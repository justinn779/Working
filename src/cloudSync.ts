import { doc, getDoc, setDoc } from "firebase/firestore";
import type { KnownMaterials } from "./combo";
import { db } from "./firebase";
import type { GameEvent } from "./types";
import type { GameState } from "./state";

const PLAYERS_COLLECTION = "players";
const EVENTS_COLLECTION = "events";

/** What actually gets synced per player — deliberately lightweight. The full
 * event text (title/description) already lives once in the shared `events`
 * collection; duplicating it into every player's own doc would let a very
 * active player's history eventually approach Firestore's 1MiB per-document
 * limit for no benefit. Only a comboKey→timestamp map is stored here; full
 * content is rehydrated from the shared collection on pull. */
interface SyncedProfile {
  staminaUnits: number;
  staminaLastSettled: number;
  unlockedOptionIds: string[];
  /** comboKey -> when *this* player first personally discovered it. */
  history: Record<string, number>;
  playerName: string;
  language: "zh" | "en";
}

function toSyncedProfile(state: GameState): SyncedProfile {
  return {
    staminaUnits: state.staminaUnits,
    staminaLastSettled: state.staminaLastSettled,
    unlockedOptionIds: state.unlockedOptionIds,
    history: state.personalDiscoveredAt,
    playerName: state.playerName,
    language: state.language,
  };
}

export async function pullRemoteState(uid: string): Promise<GameState | null> {
  const snap = await getDoc(doc(db, PLAYERS_COLLECTION, uid));
  if (!snap.exists()) return null;
  const profile = snap.data() as SyncedProfile;
  const history = profile.history ?? {};
  const comboKeys = Object.keys(history);

  // One read per personally-discovered combo to rehydrate full event text —
  // fine at this game's scale (dozens to low hundreds per player); would
  // need batching into `in`-query chunks of 30 if that ever changed.
  const eventDocs = await Promise.all(comboKeys.map((key) => getDoc(doc(db, EVENTS_COLLECTION, key))));

  const eventsByCombo: Record<string, GameEvent> = {};
  comboKeys.forEach((key, i) => {
    const eventDoc = eventDocs[i];
    if (eventDoc.exists()) eventsByCombo[key] = eventDoc.data() as GameEvent;
  });

  const collectedComboKeys = Object.keys(eventsByCombo).sort((a, b) => (history[a] ?? 0) - (history[b] ?? 0));

  // Rebuilt the same way recordEvent does locally — there's no separate
  // materials collection to fetch, the label travels inside each event.
  // Skips pre-rearchitecture events whose featuredOption has no `.label`
  // (see the matching guard in state.ts's recordEvent for why).
  const knownMaterials: KnownMaterials = {};
  for (const event of Object.values(eventsByCombo)) {
    if (event.featuredOption?.label?.zh && !(event.featuredOption.optionId in knownMaterials)) {
      knownMaterials[event.featuredOption.optionId] = {
        category: event.featuredOption.category,
        label: event.featuredOption.label,
      };
    }
  }

  return {
    staminaUnits: profile.staminaUnits,
    staminaLastSettled: profile.staminaLastSettled,
    unlockedOptionIds: profile.unlockedOptionIds,
    eventsByCombo,
    collectedComboKeys,
    personalDiscoveredAt: history,
    playerName: profile.playerName ?? "",
    knownMaterials,
    language: profile.language === "en" ? "en" : "zh",
    // A remote profile only ever exists for a returning player — never show
    // the first-time tutorial to someone pulling down existing progress.
    hasSeenTutorial: true,
  };
}

/** Fire-and-forget: local play should never block on network sync. */
export function pushRemoteState(uid: string, state: GameState): void {
  setDoc(doc(db, PLAYERS_COLLECTION, uid), toSyncedProfile(state)).catch((err) => {
    console.warn("雲端同步失敗(不影響本機遊玩)", err);
  });
}
