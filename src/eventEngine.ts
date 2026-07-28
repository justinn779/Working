import { UNIT_MINUTES } from "./config";
import { buildComboKey, durationBucket, getOptionById, isEmptySelection, type KnownMaterials } from "./combo";
import { generateEventRemote } from "./remoteEvent";
import { recordEvent, spendStamina, unlockOption, type GameState } from "./state";
import { CATEGORY_ORDER } from "./types";
import type { Category, GameEvent, Selection } from "./types";

const CONNECTOR: Record<"zh" | "en", Record<Category, string>> = {
  zh: { person: "和", matter: "處理", place: "在", object: "靠著" },
  en: { person: "with", matter: "on", place: "at", object: "using" },
};

const CLOSERS_BY_LENGTH: Record<"zh" | "en", Record<"short" | "medium" | "long", string[]>> = {
  zh: {
    short: ["很快就解決了。", "算是輕鬆過關。", "沒花多少功夫。"],
    medium: ["過程有點小曲折,但總算收場。", "比想像中麻煩一點,不過還好。", "中間出了點小插曲,幸好沒釀成大事。"],
    long: ["這段時間過得特別漫長,總算是熬過去了。", "花了不少心力才告一段落。", "過程一波三折,結束時整個人都累了。"],
  },
  en: {
    short: ["It wrapped up quickly.", "A pretty easy win.", "Didn't take much effort."],
    medium: [
      "It got a little complicated, but wrapped up in the end.",
      "A bit more trouble than expected, but okay.",
      "There was a small hiccup, but nothing serious came of it.",
    ],
    long: [
      "It dragged on for a while, but got through it eventually.",
      "Took a lot of effort to finally wrap up.",
      "It was a bumpy ride, and everyone was exhausted by the end.",
    ],
  },
};

/** Local, rule-based fallback used only when the Cloud Function is
 * unreachable (offline, not yet deployed, etc). It deliberately never
 * features/unlocks anything — that's meant to track what the AI actually
 * wove into a story, and a template like this can't guarantee that
 * coherence. It also only mentions categories the player actually selected,
 * matching the same "don't invent unselected filler" rule the AI prompt
 * follows. Never touches the shared library, so there's no real "discoverer"
 * — the placeholder name makes that visible rather than implying a global
 * discovery that didn't happen.
 *
 * Builds both languages at once (no AI available here to translate on
 * demand), same as the remote generator, so switching the UI language never
 * needs to regenerate this event. */
function generateEventLocal(
  selection: Selection,
  durationUnits: number,
  comboKey: string,
  playerName: string,
  knownMaterials: KnownMaterials,
  uiLanguage: "zh" | "en"
): GameEvent {
  const minutes = durationUnits * UNIT_MINUTES;
  const selectedCats = CATEGORY_ORDER.filter((cat) => selection[cat] !== null);
  const bucket = durationBucket(durationUnits);
  const closerIndex = Math.floor(Math.random() * CLOSERS_BY_LENGTH.zh[bucket].length);

  const label = (cat: Category, lang: "zh" | "en") =>
    getOptionById(selection[cat] as string, knownMaterials)?.label[lang] ?? "";

  const actorZh = playerName || "你";
  const actorEn = playerName || "You";
  const fragmentsZh = selectedCats.map((cat) => `${CONNECTOR.zh[cat]}${label(cat, "zh")}`);
  const fragmentsEn = selectedCats.map((cat) => `${CONNECTOR.en[cat]}${label(cat, "en")}`);

  const bodyZh =
    fragmentsZh.length > 0
      ? `${actorZh}花了${minutes}分鐘,${fragmentsZh.join("、")}。`
      : `${actorZh}自己找了件事花了${minutes}分鐘處理。`;
  const bodyEn =
    fragmentsEn.length > 0
      ? `${actorEn} spent ${minutes} minutes ${fragmentsEn.join(", ")}.`
      : `${actorEn} found something to do for ${minutes} minutes.`;

  const titleZh = isEmptySelection(selection)
    ? "平凡的一段工作時間"
    : selectedCats.map((cat) => label(cat, "zh")).join("・");
  const titleEn = isEmptySelection(selection)
    ? "An Ordinary Work Session"
    : selectedCats.map((cat) => label(cat, "en")).join(" · ");

  return {
    comboKey,
    title: { zh: titleZh, en: titleEn },
    description: {
      zh: `${bodyZh}${CLOSERS_BY_LENGTH.zh[bucket][closerIndex]}`,
      en: `${bodyEn} ${CLOSERS_BY_LENGTH.en[bucket][closerIndex]}`,
    },
    durationUnits,
    featuredOption: null,
    discovererName: playerName || (uiLanguage === "en" ? "You (offline mode)" : "你(本機模式)"),
    discoveredAt: Date.now(),
  };
}

export interface ResolveResult {
  event: GameEvent;
  isNewDiscovery: boolean;
  /** True only if event.featuredOption existed and wasn't already unlocked
   * for this specific player — gates the "🎉 newly unlocked" toast. The
   * featured tag itself is still shown either way. */
  isFeaturedOptionNewToMe: boolean;
  /** Where this event's content came from this time around — 'cached' means
   * it was already known locally and no generation happened at all. */
  source: "cached" | "remote" | "local-fallback";
}

/** Returns null when there isn't enough stamina to cover the requested duration. */
export async function resolveAction(
  state: GameState,
  selection: Selection,
  durationUnits: number
): Promise<ResolveResult | null> {
  if (!spendStamina(state, durationUnits)) return null;

  const comboKey = buildComboKey(selection, durationUnits);
  const cached = state.eventsByCombo[comboKey];
  let event = cached;
  let source: ResolveResult["source"] = "cached";

  if (!event) {
    try {
      event = await generateEventRemote(selection, durationUnits, state.playerName, state.knownMaterials);
      source = "remote";
    } catch (err) {
      console.warn("雲端事件生成失敗,改用本機規則產生", err);
      event = generateEventLocal(selection, durationUnits, comboKey, state.playerName, state.knownMaterials, state.language);
      source = "local-fallback";
    }
  }

  const { isNewDiscovery } = recordEvent(state, event);

  const isFeaturedOptionNewToMe = event.featuredOption
    ? unlockOption(state, event.featuredOption.optionId)
    : false;

  return { event, isNewDiscovery, isFeaturedOptionNewToMe, source };
}
