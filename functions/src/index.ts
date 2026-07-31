import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import OpenAI from "openai";
import { notifyTelegram, TELEGRAM_SECRETS } from "./telegram";

initializeApp();
const db = getFirestore();

export { createTopupOrder, captureTopupOrder, getOrderStatus, exchangeCoinsForStamina, usePotion } from "./topupHandlers";
export { paypalWebhook } from "./paypalWebhook";
export { adminRefundOrder, adminAdjustCoins, adminSetPaymentReview, adminReconcile } from "./adminHandlers";
export { notifyPlayerRegistered } from "./playerHandlers";

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
 * keeps the invented item's category honest.
 *
 * Examples are still overwhelmingly office jargon on purpose — only one
 * personal-life example per category, matching the "an occasional minority
 * (1-2成), not a coin flip" ratio spelled out in buildPrompt's invention
 * paragraph below. An earlier version gave office and personal examples
 * equal billing and the model overcorrected into inventing almost nothing
 * but cafés/parks/friends every time — the fix is fewer non-office examples
 * and an explicit ratio, not removing them outright. */
const CATEGORY_HINT: Record<Category, string> = {
  person: "一個「人」——具體的人物身份或角色,例如工讀生、神秘清潔阿姨、總經理、已離職的前同事之類的職場角色,偶爾也可以是家人、朋友這類跟職場無關的人。不能是活動、地點、物品或抽象概念。",
  matter: "一件「事」——正在進行或即將發生的任務、活動、事件,例如加班趕案子、提案簡報、內部檢舉之類的職場事務,偶爾也可以是私人生活裡的小事。不能是人物、地點或物品。",
  place: "一個「地」——具體的實體場所或空間,例如電梯、頂樓天台、老闆辦公室之類的職場空間,偶爾也可以是住家附近之類跟職場無關的地方。不能是人物、事件、物品或抽象概念。",
  object: "一個「物」——具體的實體物品或東西,例如簡報檔案、辭職信、樂透彩券之類的職場物品,偶爾也可以是私人物品。不能是人物、地點或事件。",
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
  /** The acting player's current 職稱 — optional only so an old cached
   * frontend bundle mid-rollout doesn't hard-fail; see the default applied
   * in resolveEvent below. Must be trusted as-is like playerName, for the
   * same reason. */
  jobTitle?: Localized;
}

/** Every player starts here — must match src/state.ts's copy exactly. */
const DEFAULT_JOB_TITLE: Localized = { zh: "新進員工", en: "New Employee" };

interface FeaturedRef {
  category: Category;
  optionId: string;
  label: Localized;
  /** Short standalone blurb (~10-30 zh chars) describing what this
   * AI-invented material actually is — independent of any specific event's
   * story text, so a player can look it up later without re-reading the
   * story that discovered it. */
  description: Localized;
}

interface StoredEvent {
  comboKey: string;
  title: Localized;
  description: Localized;
  durationUnits: number;
  featuredOption: FeaturedRef | null;
  discovererName: string;
  discoveredAt: number;
  /** The acting player's 職稱 *before* this event — part of the comboKey
   * (see buildComboKey), stored directly here too so it can be displayed
   * without re-decoding the key. */
  jobTitle: Localized;
  /** Whether this event should move the acting player's 職稱 forward —
   * null means no change. See buildPrompt's job-title section for what
   * "should" means here; this is GPT's call, not a threshold/points system. */
  newJobTitle: Localized | null;
}

/** Duration is the exact unit count (not a bucket) — every distinct duration
 * choice is its own discoverable event. The acting player's 職稱 is also
 * part of the key — the same materials tell a different, separately-cached
 * story depending on what job the player currently holds (see buildPrompt).
 * Must match src/combo.ts's copy exactly. */
function buildComboKey(selection: Selection, durationUnits: number, jobTitleZh: string): string {
  const base = CATEGORY_ORDER.map((cat) => `${cat}:${selection[cat] ?? "none"}`).join("|");
  return `${base}|time:${durationUnits}|job:${sanitizeForId(jobTitleZh)}`;
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
 * toward categories the player did NOT select, so a discovery cross-pollinates
 * the combo instead of reinforcing what's already there (e.g. person+place
 * picks should tend to invent an object or matter, not another person or
 * place). Originally biased the other way (toward already-selected
 * categories) — flipped after user feedback that events felt monotonous,
 * always surfacing more of whatever category was already picked. Falls back
 * to a uniform pick across all 4 if every category is already selected
 * (nothing left to fill in). */
function pickBiasedCategory(selection: Selection): Category {
  const unselectedCategories = CATEGORY_ORDER.filter((cat) => selection[cat] === null);
  const useUnselected = unselectedCategories.length > 0 && Math.random() < 0.8;
  const pool = useUnselected ? unselectedCategories : CATEGORY_ORDER;
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

/** Story text never contains a real name — see src/types.ts's PLAYER_TOKEN
 * for why (a shared/cached event is replayed by many different players, and
 * each must see themself as the protagonist, not whoever discovered it
 * first). Must match the frontend's copy exactly. */
const PLAYER_TOKEN = "{{player}}";

/** Duration used to be tacked onto the prompt as a single throwaway sentence
 * ("花費 X 分鐘處理這件事") — the model had no instruction to actually let that
 * number shape anything, so a 10-minute errand and an 8-hour ordeal came out
 * as similarly-sized stories with just a different number embedded in them.
 * These tiers turn the duration into real narrative constraints: how much
 * should go wrong, how much the outcome should weigh, and how long the
 * description itself should be — short errands stay trivial and quick,
 * long ones must earn their length with real difficulty and consequence. */
type DurationTier = "quick" | "short" | "medium" | "long" | "marathon";

function durationTier(durationUnits: number): DurationTier {
  if (durationUnits <= 2) return "quick"; // <=20 min
  if (durationUnits <= 6) return "short"; // <=60 min
  if (durationUnits <= 18) return "medium"; // <=180 min
  if (durationUnits <= 36) return "long"; // <=360 min
  return "marathon"; // up to 480 min
}

const DURATION_NARRATIVE_HINT: Record<DurationTier, string> = {
  quick:
    "這是隨手就能處理完的小空檔(幾分鐘到二十分鐘)。事件必須輕巧瑣碎——像是順手回一句話、被叫住問個小事、快速確認一個細節,不會有明顯衝突或轉折,結果通常立即見效或根本不了了之,語氣輕鬆隨性,不要把小事寫得煞有介事。",
  short:
    "這是一小段完整的時間(半小時到一小時)。事件是一件能在這段時間內從頭到尾處理完的小任務或小互動,有起頭、經過、結果,但規模不大,頂多帶一點小狀況或小驚喜,不需要複雜鋪陳。",
  medium:
    `這是一段實質投入的時間(超過一小時到三小時)。事件裡必須出現至少一個需要 ${PLAYER_TOKEN} 實際應對的狀況——意外、衝突、額外要求、或需要協調別人都可以,不能整段都順順地做完;結尾要交代清楚是順利解決、勉強過關,還是留下後續問題。`,
  long:
    `這是一段很長的投入時間(超過三小時到六小時)。事件的規模和難度要對得起這麼長的時間——牽涉不只一件事或不只一個人,過程中要有實質的壓力、疲憊或抉擇,結果要有明確分量(重大進展、代價、或後遺症)。絕對不能寫成十分鐘就能做完的小事,只是把時間數字換大而已。`,
  marathon:
    `這是幾乎耗盡一整個工作天精力的超長時間(超過六小時,接近一整天)。事件必須是一場硬仗——高強度、高風險或高壓力,${PLAYER_TOKEN} 投入大量心力甚至有所犧牲(可能疲憊不堪、錯過其他事、身心透支),結果必須有明顯重量,無論是重大突破還是慘重代價都不能輕描淡寫。`,
};

const DURATION_LENGTH_HINT: Record<DurationTier, string> = {
  quick: "30到50",
  short: "40到70",
  medium: "60到90",
  long: "80到120",
  marathon: "100到150",
};

/** The new material is invented by the AI in the same response as the story
 * — asking it to name something and immediately write that thing into the
 * scene keeps the two consistent by construction, instead of inventing a
 * name first and hoping a separate writing pass references it the same way.
 * Both a Traditional Chinese and an English version are requested in the
 * SAME call for the same reason: a material's zh/en pair must always be
 * produced together, never independently re-invented per language, or the
 * English name of "the same" discovery could drift from the Chinese one. */
/** 職稱 covers both promotion within the same job and a switch to a
 * completely different one — the game treats those as the same kind of
 * change (see src/state.ts's GameState.jobTitle doc comment). This is
 * deliberately NOT a points/threshold system: GPT judges, from the current
 * title plus this event's own materials, whether the outcome plausibly
 * moves the player forward — most events should not, so the instruction
 * leans hard on restraint rather than encouraging frequent changes. */
function buildJobTitleSection(jobTitle: Localized): string {
  return `${PLAYER_TOKEN}目前的職稱是「${jobTitle.zh}」(英文:${jobTitle.en})。這個故事要讓${PLAYER_TOKEN}目前的職稱合理地反映在情節、語氣和利害關係上——職稱越基層,通常責任範圍小、被動居多;職稱越高(例如主管、CEO),則要做決策、承擔後果,甚至要為別人負責。如果這個職稱本身已經跟辦公室職場無關(例如完全不同的職業),請直接把情境自然地換成符合那個職業的場景與用語,不必勉強塞進辦公室情境,也不用理會上面「人事地物」原本的職場語感。

另外,請你根據這次事件的具體內容,判斷${PLAYER_TOKEN}的職稱是否應該因此改變——可能是同一份工作內的升遷或降職,也可能是徹底換成另一個完全不同的職業。絕大多數事件都不應該觸發職稱改變,只有當這次事件的內容明顯、合理地導向這種結果時才判斷需要改變(例如事件內容本身就是升遷面談、決定離職創業、拿到轉職機會、被開除),不要沒來由地隨便觸發,也不要只因為投入時間長就順便升官。如果不需要改變,newJobTitle 請回傳 JSON 的 null(不是字串"null");如果需要改變,newJobTitle 是新職稱的中英文名稱,限2到8字。`;
}

function buildPrompt(
  labels: Partial<Record<Category, Localized | null>>,
  durationUnits: number,
  biasedCategory: Category,
  jobTitle: Localized
): string {
  const minutes = durationUnits * 10;
  const tier = durationTier(durationUnits);
  const selectedLines = CATEGORY_ORDER.filter((cat) => labels[cat])
    .map((cat) => `${CATEGORY_LABEL[cat]}:${labels[cat]!.zh} (${labels[cat]!.en})`)
    .join("\n");

  return `你是「工作大小事」文字遊戲的事件生成器。這次故事的主角要用一個固定代稱「${PLAYER_TOKEN}」稱呼——這個代稱之後會被系統自動換成每一位玩家自己的名字,所以絕對不能寫成「玩家」、「the player」,也不能自己發明或猜測任何具體的真人姓名,一律原封不動使用「${PLAYER_TOKEN}」這個字串(包含大括號本身)。主角這次指定了以下情境元素(中文名稱後面括號是對應的英文名稱):
${selectedLines || `(${PLAYER_TOKEN}這次沒有指定任何人事地物)`}

除此之外,請你自己發明${CATEGORY_HINT[biasedCategory]}名稱限4到10字。發明的東西類別一定要精準符合上面的定義,不要把其他類別的東西誤標成這一類。把它當成情節裡真實存在、合理發生的一部分,跟其他情境元素一起自然發展,不能只在結尾補一句無關的話帶過。這個新素材最好跟現有情境元素有點關聯,但不要跟上面已經指定的元素重複或雷同。這個新素材絕大多數時候(大約八到九成)都應該是道地的職場相關東西,只有少數時候(大約一到兩成,不要更多)才適合讓生活裡的人事物(家人、寵物、興趣之類)登場——這是偶爾出現的意外感,不是常態,不要每次都發明生活化的東西,也不要每次都是同一種職場老梗。

另外請你額外用一句話(繁體中文10到30字,英文對應長度)簡單說明這個新發明的要素本身是什麼——這是獨立於故事情節之外的簡短定義,讓玩家之後在圖鑑裡不用重看故事也能一眼看懂這個要素的性質,不要重複故事內容,也不要包含「${PLAYER_TOKEN}」這個字串。

${buildJobTitleSection(jobTitle)}

${PLAYER_TOKEN}這次決定投入 ${minutes} 分鐘處理這件事。${DURATION_NARRATIVE_HINT[tier]}這個時間長度必須實際反映在故事的份量上——事件的複雜度、過程的曲折程度、結果的影響力都要跟著時間長短調整,不可以不管時間長短都寫成差不多份量的故事,也不能只是把分鐘數字寫進句子裡交差了事。

另外,請你先撇開上面的時間長度,單純以${PLAYER_TOKEN}這次指定的人事地物組合本身的性質來判斷:正常來說這件事大概需要多久才合理——例如單純去茶水間泡杯咖啡,十幾二十分鐘就很正常;開會、討論這類活動,半小時到一小時很合理。如果你判斷這次實際投入的 ${minutes} 分鐘,跟這個組合本身該花的時間差距明顯(明顯太長或太短),故事裡就必須自然交代「為什麼」——例如中途出了狀況、被打斷、卡關耽擱,或是提早就搞定了——不能對這個落差視而不見,也不能硬把一件本來很快的小事拖成看似很長卻沒交代原因的流水帳。如果組合本身跟時間長度沒有明顯落差,就不用特別處理這一點,維持上面對應時間長度該有的份量即可。

請用繁體中文和英文「各寫一次」同一段情境描述,平實直接地說明${PLAYER_TOKEN}用這些素材做了什麼、過程如何、結果如何——語氣像日常紀錄一樣,不需要華麗詞藻或刻意誇張,但情節的起伏與份量必須符合上面對這個時間長度的說明。內容要把所有元素(包含你發明的新素材)合理地兜在一起,不要為了填滿內容硬塞進沒有出現過的其他具體人物/地點/物品。畫面上另外會顯示這次花費的時間長度,描述內文盡量不要再重複寫出精確的分鐘數或小時數(例如「花了10分鐘」、「經過2小時」這類句子),用情節本身的節奏、匆忙或從容的語氣去表現時間感就好,不用把數字寫進句子裡交差。英文版不是逐字翻譯,而是同一件事用自然道地的英文重新敘述一次,長度跟語氣比照中文版。

中文描述內文必須逐字出現你發明的新素材的中文名稱,英文描述內文也必須逐字出現(忽略大小寫)該素材的英文名稱。兩種語言的描述裡,只要提到主角,都必須原封不動寫「${PLAYER_TOKEN}」這個字串本身,不要翻譯它、不要加引號、不要改寫成任何其他稱呼或姓名。

請「只」回覆下面這個 JSON 格式,不要加任何說明文字,也不要用 markdown code block 包起來:
{"newMaterial": {"zh": "你發明的新素材中文名稱(4到10字)", "en": "same material's English name"}, "materialDescription": {"zh": "這個新素材本身是什麼的簡短定義(10到30字)", "en": "short standalone definition of the new material, similar length and tone"}, "title": {"zh": "中文標題(4到10字)", "en": "English title"}, "description": {"zh": "中文描述(${DURATION_LENGTH_HINT[tier]}字,長度必須符合上面的時間長度說明)", "en": "English description, similar length and tone"}, "newJobTitle": {"zh": "新職稱中文(2到8字)", "en": "new job title in English"} 或 JSON null}`;
}

interface RawGenerationResult {
  newMaterial: Localized;
  materialDescription: Localized;
  title: Localized;
  description: Localized;
  newJobTitle: Localized | null;
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
  if (
    !isLocalized(parsed.newMaterial) ||
    !isLocalized(parsed.materialDescription) ||
    !isLocalized(parsed.title) ||
    !isLocalized(parsed.description)
  ) {
    throw new Error("AI 回覆的 JSON 缺少雙語的 newMaterial、materialDescription、title 或 description");
  }
  // newJobTitle is optional/nullable by design (see buildJobTitleSection) —
  // only reject the response if it's present but malformed (neither null
  // nor a proper bilingual pair), not merely because it's absent.
  if (parsed.newJobTitle != null && !isLocalized(parsed.newJobTitle)) {
    throw new Error("AI 回覆的 newJobTitle 格式不正確");
  }
  return {
    newMaterial: parsed.newMaterial,
    materialDescription: parsed.materialDescription,
    title: parsed.title,
    description: parsed.description,
    newJobTitle: parsed.newJobTitle ?? null,
  };
}

async function tryGenerate(
  client: OpenAI,
  labels: Partial<Record<Category, Localized | null>>,
  durationUnits: number,
  biasedCategory: Category,
  jobTitle: Localized
): Promise<{ title: Localized; description: Localized; featuredOption: FeaturedRef; newJobTitle: Localized | null } | null> {
  const prompt = buildPrompt(labels, durationUnits, biasedCategory, jobTitle);
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    // 1000 (was 800) — the marathon tier can now ask for up to ~150 zh
    // characters plus a similarly-sized English description, which needs
    // more headroom than the old fixed 40-80字 length ever did.
    max_tokens: 1000,
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
  // Instructed as "10到30字" — validated with slack on both sides (like
  // newMaterial's own 4-10 instructed / 2-12 validated gap above) so a
  // near-miss length doesn't burn a retry over something still perfectly usable.
  const materialDescription: Localized = {
    zh: parsed.materialDescription.zh.trim(),
    en: parsed.materialDescription.en.trim(),
  };
  if (materialDescription.zh.length < 6 || materialDescription.zh.length > 40) return null;
  if (materialDescription.en.length < 6 || materialDescription.en.length > 160) return null;
  // Guards against the rare case where the model ignores the "must appear
  // verbatim" instruction — only honor a generation that actually did it, in
  // both languages independently (English compared case-insensitively).
  if (!parsed.description.zh.includes(newMaterial.zh)) return null;
  if (!parsed.description.en.toLowerCase().includes(newMaterial.en.toLowerCase())) return null;
  // Guards against the model writing a real name (or "玩家"/"the player")
  // instead of the placeholder — a story that skips this would show whoever
  // wrote the prompt's own name to every future player who replays it.
  if (!parsed.description.zh.includes(PLAYER_TOKEN)) return null;
  if (!parsed.description.en.includes(PLAYER_TOKEN)) return null;

  // A malformed or no-op newJobTitle is discarded rather than failing the
  // whole attempt — it's a rare bonus field, not worth burning a retry over
  // when the story itself is otherwise perfectly valid.
  let newJobTitle: Localized | null = null;
  if (parsed.newJobTitle) {
    const candidate: Localized = { zh: parsed.newJobTitle.zh.trim(), en: parsed.newJobTitle.en.trim() };
    const withinLength =
      candidate.zh.length >= 2 && candidate.zh.length <= 8 && candidate.en.length >= 2 && candidate.en.length <= 30;
    if (withinLength && candidate.zh !== jobTitle.zh) newJobTitle = candidate;
  }

  return {
    title: parsed.title,
    description: parsed.description,
    featuredOption: {
      category: biasedCategory,
      optionId: `${biasedCategory}_${sanitizeForId(newMaterial.zh)}`,
      label: newMaterial,
      description: materialDescription,
    },
    newJobTitle,
  };
}

async function generateStory(
  client: OpenAI,
  labels: Partial<Record<Category, Localized | null>>,
  durationUnits: number,
  selection: Selection,
  jobTitle: Localized
): Promise<{ title: Localized; description: Localized; featuredOption: FeaturedRef; newJobTitle: Localized | null }> {
  // Up to 3 attempts — each re-rolls the category bias and asks the AI to
  // invent fresh, rather than retrying the exact same prompt verbatim.
  for (let i = 0; i < 3; i++) {
    const biasedCategory = pickBiasedCategory(selection);
    const result = await tryGenerate(client, labels, durationUnits, biasedCategory, jobTitle);
    if (result) return result;
  }

  await notifyTelegram("🚨 GPT 事件生成連續 3 次都失敗(格式錯誤或內容驗證沒過),請檢查 OpenAI 那邊是否正常");
  throw new HttpsError("internal", "AI 沒有回覆有效內容,請再試一次");
}

export const resolveEvent = onCall(
  { secrets: [OPENAI_API_KEY, ...TELEGRAM_SECRETS], region: "asia-east1", maxInstances: 5 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "請先登入(包含匿名登入)才能產生事件");
    }

    const data = request.data as ResolveEventData;
    if (!data?.selection || typeof data.durationUnits !== "number") {
      throw new HttpsError("invalid-argument", "缺少必要參數");
    }
    // Defaults rather than hard-fails on a missing/malformed jobTitle — an
    // old cached frontend bundle mid-rollout won't send one yet, and this is
    // a low-stakes casual game, not worth erroring a whole request over.
    const jobTitle: Localized = isLocalized(data.jobTitle) ? data.jobTitle : DEFAULT_JOB_TITLE;

    const comboKey = buildComboKey(data.selection, data.durationUnits, jobTitle.zh);
    const docRef = db.collection("events").doc(comboKey);
    const existing = await docRef.get();
    if (existing.exists) {
      return existing.data() as StoredEvent;
    }

    const trimmedPlayerName = data.playerName?.trim().slice(0, 20);
    const discovererName =
      trimmedPlayerName || (request.auth.token.name as string | undefined) || visitorLabel(request.auth.uid);

    const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
    const story = await generateStory(client, data.labels ?? {}, data.durationUnits, data.selection, jobTitle);

    const event: StoredEvent = {
      comboKey,
      title: story.title,
      description: story.description,
      durationUnits: data.durationUnits,
      featuredOption: story.featuredOption,
      discovererName,
      discoveredAt: Date.now(),
      jobTitle,
      newJobTitle: story.newJobTitle,
    };

    // Cache-write races: if two players trigger the same brand-new combo at
    // nearly the same time, both may call the AI and both will overwrite
    // this doc — the last write wins. Acceptable for this game's scale;
    // switch to a transaction if that ever becomes a real concern.
    await docRef.set(event);

    // Only reached once per genuinely-new combo (a cache hit returns early
    // above), so this fires exactly once per real title change, not once
    // per player who later replays the same cached story.
    if (event.newJobTitle) {
      await notifyTelegram(
        `🎉 職稱異動\n玩家:${discovererName}\n${jobTitle.zh} → ${event.newJobTitle.zh}\n事件:${event.title.zh}`
      );
    }

    return event;
  }
);
