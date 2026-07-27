import { UNIT_MINUTES } from "./config";
import { buildComboKey, getOptionById, isEmptySelection } from "./combo";
import { generateEventRemote } from "./remoteEvent";
import { recordEvent, spendStamina, unlockOption, type GameState } from "./state";
import { CATEGORY_ORDER } from "./types";
import type { Category, GameEvent, Selection, UnlockRef } from "./types";

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const CONNECTOR: Record<Category, string> = {
  person: "和",
  matter: "處理",
  place: "在",
  object: "靠著",
};

const CLOSERS_BY_LENGTH = {
  short: ["很快就解決了。", "算是輕鬆過關。", "沒花多少功夫。"],
  medium: ["過程有點小曲折,但總算收場。", "比想像中麻煩一點,不過還好。", "中間出了點小插曲,幸好沒釀成大事。"],
  long: ["這段時間過得特別漫長,總算是熬過去了。", "花了不少心力才告一段落。", "過程一波三折,結束時整個人都累了。"],
};

/** Local, rule-based fallback used only when the Cloud Function is
 * unreachable (offline, not yet deployed, etc). It deliberately never
 * unlocks anything — unlocking is meant to track what the AI actually wove
 * into a story, and a template like this can't guarantee that coherence. It
 * also only mentions categories the player actually selected, matching the
 * same "don't invent unselected filler" rule the AI prompt follows. */
function generateEventLocal(selection: Selection, durationUnits: number, comboKey: string): GameEvent {
  const minutes = durationUnits * UNIT_MINUTES;
  const selectedCats = CATEGORY_ORDER.filter((cat) => selection[cat] !== null);
  const fragments = selectedCats.map(
    (cat) => `${CONNECTOR[cat]}${getOptionById(selection[cat] as string)?.label ?? ""}`
  );

  const lengthBucket = minutes <= 20 ? "short" : minutes <= 60 ? "medium" : "long";
  const closer = pickRandom(CLOSERS_BY_LENGTH[lengthBucket]);
  const body =
    fragments.length > 0
      ? `你花了${minutes}分鐘,${fragments.join("、")}。`
      : `你自己找了件事花了${minutes}分鐘處理。`;

  const title = isEmptySelection(selection)
    ? "平凡的一段工作時間"
    : selectedCats.map((cat) => getOptionById(selection[cat] as string)?.label ?? "").join("・");

  return {
    comboKey,
    title,
    description: `${body}${closer}`,
    durationUnits,
    unlocks: [],
    createdAt: Date.now(),
  };
}

export interface ResolveResult {
  event: GameEvent;
  isNewDiscovery: boolean;
  newlyUnlocked: UnlockRef[];
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

  const comboKey = buildComboKey(selection);
  const cached = state.eventsByCombo[comboKey];
  let event = cached;
  let source: ResolveResult["source"] = "cached";

  if (!event) {
    try {
      event = await generateEventRemote(selection, durationUnits);
      source = "remote";
    } catch (err) {
      console.warn("雲端事件生成失敗,改用本機規則產生", err);
      event = generateEventLocal(selection, durationUnits, comboKey);
      source = "local-fallback";
    }
  }

  const { isNewDiscovery } = recordEvent(state, event, durationUnits);

  const newlyUnlocked = event.unlocks.filter((u) => unlockOption(state, u.optionId));

  return { event, isNewDiscovery, newlyUnlocked, source };
}
