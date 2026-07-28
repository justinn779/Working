import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import OpenAI from "openai";

initializeApp();
const db = getFirestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const OPENAI_MODEL = "gpt-4o-mini";

type Category = "person" | "matter" | "place" | "object";

/** Mirrors src/types.ts's Localized — every generated string exists in both
 * languages at once, produced by a single generation call (see buildPrompt),
 * so a material's zh/en pair is never independently re-invented per
 * language. */
interface Localized {
  zh: string;
  en: string;
}

const CATEGORY_ORDER: Category[] = ["person", "matter", "place", "object"];

const CATEGORY_LABEL: Record<Category, string> = {
  person: "人",
  matter: "事",
  place: "地",
  object: "物",
};

/** Explicit per-category definition + exclusions + examples for the invention
 * prompt — plain category names alone ("發明一個「人」類素材") turned out too
 * loose in practice: the model would sometimes invent an event/document/place
 * and label it "人" anyway (e.g. "會議記錄器"、"團隊合作協議" showing up under
 * 人). Spelling out what counts and what doesn't, with concrete examples,
 * keeps the invented item's category honest. */
const CATEGORY_HINT: Record<Category, string> = {
  person: "一個「人」——具體的人物身份或角色,例如工讀生、神秘清潔阿姨、總經理、已離職的前同事之類。不能是活動、地點、物品或抽象概念。",
  matter: "一件「事」——正在進行或即將發生的任務、活動、事件,例如加班趕案子、提案簡報、內部檢舉之類。不能是人物、地點或物品。",
  place: "一個「地」——具體的實體場所或空間,例如電梯、頂樓天台、老闆辦公室之類。不能是人物、事件、物品或抽象概念。",
  object: "一個「物」——具體的實體物品或東西,例如簡報檔案、辭職信、樂透彩券之類。不能是人物、地點或事件。",
};

interface Selection {
  person: string | null;
  matter: string | null;
  place: string | null;
  object: string | null;
}

interface ResolveEventData {
  selection: Selection;
  /** Bilingual label of whatever's selected per category, so the prompt can
   * reference the correct existing English name instead of inventing its
   * own translation for something that already has one. */
  labels: Partial<Record<Category, Localized | null>>;
  durationUnits: number;
  /** Client-chosen "入職名稱" display name. Trusted as-is (only length-capped)
   * — this is a low-stakes casual game, not a moderated public platform. */
  playerName?: string;
}

interface FeaturedRef {
  category: Category;
  optionId: string;
  label: Localized;
}

interface StoredEvent {
  comboKey: string;
  title: Localized;
  description: Localized;
  durationUnits: number;
  featuredOption: FeaturedRef | null;
  discovererName: string;
  discoveredAt: number;
}

/** Duration is the exact unit count (not a bucket) — every distinct duration
 * choice is its own discoverable event. Must match src/combo.ts's copy
 * exactly. */
function buildComboKey(selection: Selection, durationUnits: number): string {
  const base = CATEGORY_ORDER.map((cat) => `${cat}:${selection[cat] ?? "none"}`).join("|");
  return `${base}|time:${durationUnits}`;
}

/** Stable per-uid nickname for players who never signed in with Google —
 * derived purely from the uid so it needs no extra storage and both the
 * client and this function always agree on the same name. */
function visitorLabel(uid: string): string {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  }
  return `訪客#${(hash % 10000).toString().padStart(4, "0")}`;
}

/** Which category this combo's new material should be invented in — biased
 * toward categories the player already selected (branching outward from
 * familiar ground) with an occasional wildcard into an unrelated category,
 * mirroring the ~80/20 related/unrelated split the old fixed-catalog
 * sampling used. */
function pickBiasedCategory(selection: Selection): Category {
  const selectedCategories = CATEGORY_ORDER.filter((cat) => selection[cat] !== null);
  const useRelated = selectedCategories.length > 0 && Math.random() < 0.8;
  const pool = useRelated ? selectedCategories : CATEGORY_ORDER;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Strips characters that would corrupt comboKey parsing (`|` separates
 * segments, `:` separates a segment's category from its value) — everything
 * else in the AI-invented label is kept as-is. */
function sanitizeForId(label: string): string {
  return label.replace(/[|:]/g, "");
}

/** Even with an explicit category definition in the prompt, the model still
 * occasionally invents a document/agreement/event and tags it "人" anyway
 * (observed: "團隊合作協議", "會議記錄器"). These suffixes are a strong signal
 * the thing is a document/object/matter, not a person — reject and let
 * generateStory's retry loop try again rather than accept an obvious miss. */
const NON_PERSON_SUFFIXES_ZH = [
  "協議", "報告", "文件", "記錄", "紀錄", "備忘錄", "方案", "計畫",
  "清單", "申請", "確認書", "合約", "證明", "收據", "表", "單", "書",
];
const NON_PERSON_SUFFIXES_EN = [
  "agreement", "report", "document", "record", "memo", "plan", "form",
  "checklist", "application", "contract", "receipt", "invoice",
];

function looksLikeMiscategorizedPerson(category: Category, label: Localized): boolean {
  if (category !== "person") return false;
  const lowerEn = label.en.toLowerCase();
  return (
    NON_PERSON_SUFFIXES_ZH.some((suffix) => label.zh.endsWith(suffix)) ||
    NON_PERSON_SUFFIXES_EN.some((suffix) => lowerEn.endsWith(suffix))
  );
}

/** The new material is invented by the AI in the same response as the story
 * — asking it to name something and immediately write that thing into the
 * scene keeps the two consistent by construction, instead of inventing a
 * name first and hoping a separate writing pass references it the same way.
 * Both a Traditional Chinese and an English version are requested in the
 * SAME call for the same reason: a material's zh/en pair must always be
 * produced together, never independently re-invented per language, or the
 * English name of "the same" discovery could drift from the Chinese one. */
function buildPrompt(
  labels: Partial<Record<Category, Localized | null>>,
  durationUnits: number,
  biasedCategory: Category,
  playerLabel: string
): string {
  const minutes = durationUnits * 10;
  const selectedLines = CATEGORY_ORDER.filter((cat) => labels[cat])
    .map((cat) => `${CATEGORY_LABEL[cat]}:${labels[cat]!.zh} (${labels[cat]!.en})`)
    .join("\n");

  return `你是「職場大小事」文字遊戲的事件生成器。這次故事的主角名字是「${playerLabel}」——內文請直接用這個名字稱呼主角,不要用「玩家」這個詞。主角這次指定了以下情境元素(中文名稱後面括號是對應的英文名稱):
${selectedLines || `(${playerLabel}這次沒有指定任何人事地物)`}

除此之外,請你自己發明${CATEGORY_HINT[biasedCategory]}名稱限4到10字。發明的東西類別一定要精準符合上面的定義,不要把其他類別的東西誤標成這一類。把它當成情節裡真實存在、合理發生的一部分,跟其他情境元素一起自然發展,不能只在結尾補一句無關的話帶過。這個新素材最好跟現有情境元素有點關聯,但不要跟上面已經指定的元素重複或雷同。

${playerLabel}決定花費 ${minutes} 分鐘處理這件事。

請用繁體中文和英文「各寫一次」同一段簡單直接的職場情境描述,平實說明${playerLabel}用這些素材做了什麼、結果如何——不需要曲折劇情、意外轉折或誇張渲染,像日常紀錄一樣簡潔就好。內容要把所有元素(包含你發明的新素材)合理地兜在一起,不要為了填滿內容硬塞進沒有出現過的其他具體人物/地點/物品。英文版不是逐字翻譯,而是同一件事用自然道地的英文重新敘述一次,長度跟語氣比照中文版。

中文描述內文必須逐字出現你發明的新素材的中文名稱,英文描述內文也必須逐字出現(忽略大小寫)該素材的英文名稱。兩種語言都要用主角的名字「${playerLabel}」稱呼主角,不要用「玩家」或「the player」這種詞。

請「只」回覆下面這個 JSON 格式,不要加任何說明文字,也不要用 markdown code block 包起來:
{"newMaterial": {"zh": "你發明的新素材中文名稱(4到10字)", "en": "same material's English name"}, "title": {"zh": "中文標題(4到10字)", "en": "English title"}, "description": {"zh": "中文描述(40到80字)", "en": "English description, similar length and tone"}}`;
}

interface RawGenerationResult {
  newMaterial: Localized;
  title: Localized;
  description: Localized;
}

function isLocalized(value: unknown): value is Localized {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Localized).zh === "string" &&
    typeof (value as Localized).en === "string"
  );
}

function extractJson(text: string): RawGenerationResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 回覆中找不到 JSON 內容");
  const parsed = JSON.parse(match[0]);
  if (!isLocalized(parsed.newMaterial) || !isLocalized(parsed.title) || !isLocalized(parsed.description)) {
    throw new Error("AI 回覆的 JSON 缺少雙語的 newMaterial、title 或 description");
  }
  return { newMaterial: parsed.newMaterial, title: parsed.title, description: parsed.description };
}

async function tryGenerate(
  client: OpenAI,
  labels: Partial<Record<Category, Localized | null>>,
  durationUnits: number,
  biasedCategory: Category,
  playerLabel: string
): Promise<{ title: Localized; description: Localized; featuredOption: FeaturedRef } | null> {
  const prompt = buildPrompt(labels, durationUnits, biasedCategory, playerLabel);
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 800,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) return null;

  let parsed: RawGenerationResult;
  try {
    parsed = extractJson(content);
  } catch {
    return null;
  }
  const newMaterial: Localized = { zh: parsed.newMaterial.zh.trim(), en: parsed.newMaterial.en.trim() };
  if (newMaterial.zh.length < 2 || newMaterial.zh.length > 12) return null;
  if (newMaterial.en.length < 2 || newMaterial.en.length > 40) return null;
  if (looksLikeMiscategorizedPerson(biasedCategory, newMaterial)) return null;
  // Guards against the rare case where the model ignores the "must appear
  // verbatim" instruction — only honor a generation that actually did it, in
  // both languages independently (English compared case-insensitively).
  if (!parsed.description.zh.includes(newMaterial.zh)) return null;
  if (!parsed.description.en.toLowerCase().includes(newMaterial.en.toLowerCase())) return null;

  return {
    title: parsed.title,
    description: parsed.description,
    featuredOption: {
      category: biasedCategory,
      optionId: `${biasedCategory}_${sanitizeForId(newMaterial.zh)}`,
      label: newMaterial,
    },
  };
}

async function generateStory(
  client: OpenAI,
  labels: Partial<Record<Category, Localized | null>>,
  durationUnits: number,
  selection: Selection,
  playerLabel: string
): Promise<{ title: Localized; description: Localized; featuredOption: FeaturedRef }> {
  // Up to 3 attempts — each re-rolls the category bias and asks the AI to
  // invent fresh, rather than retrying the exact same prompt verbatim.
  for (let i = 0; i < 3; i++) {
    const biasedCategory = pickBiasedCategory(selection);
    const result = await tryGenerate(client, labels, durationUnits, biasedCategory, playerLabel);
    if (result) return result;
  }

  throw new HttpsError("internal", "AI 沒有回覆有效內容,請再試一次");
}

export const resolveEvent = onCall(
  { secrets: [OPENAI_API_KEY], region: "asia-east1", maxInstances: 5 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "請先登入(包含匿名登入)才能產生事件");
    }

    const data = request.data as ResolveEventData;
    if (!data?.selection || typeof data.durationUnits !== "number") {
      throw new HttpsError("invalid-argument", "缺少必要參數");
    }

    const comboKey = buildComboKey(data.selection, data.durationUnits);
    const docRef = db.collection("events").doc(comboKey);
    const existing = await docRef.get();
    if (existing.exists) {
      return existing.data() as StoredEvent;
    }

    const trimmedPlayerName = data.playerName?.trim().slice(0, 20);
    const discovererName =
      trimmedPlayerName || (request.auth.token.name as string | undefined) || visitorLabel(request.auth.uid);

    const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
    const story = await generateStory(client, data.labels ?? {}, data.durationUnits, data.selection, discovererName);

    const event: StoredEvent = {
      comboKey,
      title: story.title,
      description: story.description,
      durationUnits: data.durationUnits,
      featuredOption: story.featuredOption,
      discovererName,
      discoveredAt: Date.now(),
    };

    // Cache-write races: if two players trigger the same brand-new combo at
    // nearly the same time, both may call the AI and both will overwrite
    // this doc — the last write wins. Acceptable for this game's scale;
    // switch to a transaction if that ever becomes a real concern.
    await docRef.set(event);
    return event;
  }
);
