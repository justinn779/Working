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

const CATEGORY_ORDER: Category[] = ["person", "matter", "place", "object"];

const CATEGORY_LABEL: Record<Category, string> = {
  person: "人",
  matter: "事",
  place: "地",
  object: "物",
};

// Mirrors the locked half of SEED_OPTIONS in src/data/options.ts on the
// frontend — this list only needs the entries that start out locked, since
// those are the only ones eligible to be handed out as unlock rewards. Keep
// it in sync by hand if the frontend catalog changes.
const LOCKED_OPTIONS: { id: string; category: Category; label: string }[] = [
  { id: "person_cleaner", category: "person", label: "神秘清潔阿姨" },
  { id: "person_ceo", category: "person", label: "總經理" },
  { id: "person_ex_colleague", category: "person", label: "已離職的前同事" },
  { id: "person_rival", category: "person", label: "競爭對手公司的人" },
  { id: "matter_job_interview", category: "matter", label: "偷偷去面試" },
  { id: "matter_whistleblow", category: "matter", label: "內部檢舉" },
  { id: "matter_startup_pitch", category: "matter", label: "醞釀創業提案" },
  { id: "matter_party_show", category: "matter", label: "尾牙表演彩排" },
  { id: "place_rooftop", category: "place", label: "頂樓天台" },
  { id: "place_boss_office", category: "place", label: "老闆辦公室" },
  { id: "place_remote_office", category: "place", label: "異地辦公室" },
  { id: "place_empty_office_night", category: "place", label: "深夜只剩自己的辦公室" },
  { id: "object_fortune", category: "object", label: "神秘籤詩" },
  { id: "object_resignation", category: "object", label: "辭職信" },
  { id: "object_lottery", category: "object", label: "樂透彩券" },
  { id: "object_crypto_wallet", category: "object", label: "加密貨幣錢包" },
];

interface Selection {
  person: string | null;
  matter: string | null;
  place: string | null;
  object: string | null;
}

interface ResolveEventData {
  selection: Selection;
  labels: Partial<Record<Category, string | null>>;
  durationUnits: number;
}

interface UnlockRef {
  category: Category;
  optionId: string;
}

interface StoredEvent {
  comboKey: string;
  title: string;
  description: string;
  durationUnits: number;
  unlocks: UnlockRef[];
  createdAt: number;
}

function buildComboKey(selection: Selection): string {
  return CATEGORY_ORDER.map((cat) => `${cat}:${selection[cat] ?? "none"}`).join("|");
}

function buildPrompt(labels: Partial<Record<Category, string | null>>, durationUnits: number): string {
  const minutes = durationUnits * 10;
  const selectedLines = CATEGORY_ORDER.filter((cat) => labels[cat])
    .map((cat) => `${CATEGORY_LABEL[cat]}:${labels[cat]}`)
    .join("\n");

  const lengthGuide =
    minutes <= 20
      ? "這段時間很短,故事應該是一個簡短明快的小插曲,不需要太多轉折。"
      : minutes <= 60
      ? "這段時間中等,故事可以有一次小轉折或意外。"
      : "這段時間較長,故事可以有比較完整的過程,甚至一兩次轉折。";

  const unlockCandidates = LOCKED_OPTIONS.map((o) => `${o.id} (${CATEGORY_LABEL[o.category]}:${o.label})`).join(
    "、"
  );

  return `你是「職場大小事」文字遊戲的事件生成器。玩家這次指定了以下情境元素:
${selectedLines || "(玩家這次沒有指定任何人事地物,請自由發揮一個職場小故事)"}

玩家決定花費 ${minutes} 分鐘處理這件事。${lengthGuide}

請用繁體中文生成一個簡短、有趣、貼近台灣職場文化的小故事,描述接下來發生的事——可以是好事、壞事、荒謬的事,或意外的轉折。故事要以上面「玩家指定的元素」為主角,不要為了填滿內容硬塞進玩家沒有選到的具體人物/地點/物品,沒指定的部分保持模糊或不提及即可。

如果故事情節可以自然地引入下面清單中的某一個新元素,並讓故事「明確描述到」它,你可以在 unlockedOptionId 填入該元素的 id;如果沒有合適的,或不想加入新元素,unlockedOptionId 請填 null。絕對不要填清單以外的 id,也絕對不要填了 id 卻沒有讓故事真的出現那個元素。
可選的新元素清單:
${unlockCandidates}

請「只」回覆下面這個 JSON 格式,不要加任何說明文字,也不要用 markdown code block 包起來:
{"title": "4到12字的標題", "description": "80到150字的故事內容", "unlockedOptionId": "清單中的其中一個 id,或 null"}`;
}

function extractJson(text: string): { title: string; description: string; unlockedOptionId: string | null } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 回覆中找不到 JSON 內容");
  const parsed = JSON.parse(match[0]);
  if (typeof parsed.title !== "string" || typeof parsed.description !== "string") {
    throw new Error("AI 回覆的 JSON 缺少 title 或 description");
  }
  const unlockedOptionId = typeof parsed.unlockedOptionId === "string" ? parsed.unlockedOptionId : null;
  return { title: parsed.title, description: parsed.description, unlockedOptionId };
}

/** Only honors the unlock if it's a real catalog entry AND its label
 * literally appears in the story text — guards against the AI naming an id
 * without actually writing that element into the narrative (or hallucinating
 * an id outside the candidate list). This is what makes unlocks track what a
 * player actually encountered instead of an unrelated random grant. */
function resolveUnlocks(unlockedOptionId: string | null, description: string): UnlockRef[] {
  if (!unlockedOptionId) return [];
  const option = LOCKED_OPTIONS.find((o) => o.id === unlockedOptionId);
  if (!option) return [];
  if (!description.includes(option.label)) return [];
  return [{ category: option.category, optionId: option.id }];
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

    const comboKey = buildComboKey(data.selection);
    const docRef = db.collection("events").doc(comboKey);
    const existing = await docRef.get();
    if (existing.exists) {
      return existing.data() as StoredEvent;
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY.value() });
    const prompt = buildPrompt(data.labels ?? {}, data.durationUnits);

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new HttpsError("internal", "AI 沒有回覆文字內容");
    }

    let parsed: { title: string; description: string; unlockedOptionId: string | null };
    try {
      parsed = extractJson(content);
    } catch (err) {
      throw new HttpsError("internal", `無法解析 AI 回覆: ${(err as Error).message}`);
    }

    const event: StoredEvent = {
      comboKey,
      title: parsed.title,
      description: parsed.description,
      durationUnits: data.durationUnits,
      unlocks: resolveUnlocks(parsed.unlockedOptionId, parsed.description),
      createdAt: Date.now(),
    };

    // Cache-write races: if two players trigger the same brand-new combo at
    // nearly the same time, both may call the AI and both will overwrite
    // this doc — the last write wins. Acceptable for this game's scale;
    // switch to a transaction if that ever becomes a real concern.
    await docRef.set(event);
    return event;
  }
);
