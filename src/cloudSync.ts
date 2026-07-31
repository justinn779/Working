import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import type { KnownMaterials } from "./combo";
import { db, functions } from "./firebase";
import type { GameEvent, Localized } from "./types";
import { DEFAULT_JOB_TITLE } from "./state";
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
  /** Lowercased mirror of playerName, kept only so the admin dashboard's
   * name search (a Firestore range query, which is a byte-order comparison
   * with no case-folding) can match regardless of case — never read by the
   * game itself. */
  playerNameLower: string;
  language: "zh" | "en";
  /** Epoch ms the player confirmed the top-up terms modal, or null — a
   * normal round-tripped preference (unlike the wallet balance below), so it
   * follows the player across devices once Google-linked. */
  consentAcceptedAt: number | null;
  /** id of the last announcement this player permanently dismissed — also a
   * normal round-tripped preference, same reasoning as consentAcceptedAt. */
  dismissedAnnouncementId: string | null;
  /** Current 職稱 (job title) — also a normal round-tripped preference; only
   * ever changed client-side (via a generated event's newJobTitle), never by
   * a Cloud Function, so it belongs here rather than in
   * ServerOwnedWalletFields below. */
  jobTitle: Localized;
}

/** Fields on the players/{uid} doc that only Cloud Functions ever write
 * (see functions/src/topupService.ts's creditOrder). Declared here so
 * pullRemoteState can read them without pretending they're part of
 * SyncedProfile — they must never appear in toSyncedProfile/pushRemoteState,
 * or a client push could clobber a real balance with a stale local mirror. */
interface ServerOwnedWalletFields {
  paidCoinBalance?: number;
  potions?: Record<string, number>;
}

function toSyncedProfile(state: GameState): SyncedProfile {
  return {
    staminaUnits: state.staminaUnits,
    staminaLastSettled: state.staminaLastSettled,
    unlockedOptionIds: state.unlockedOptionIds,
    history: state.personalDiscoveredAt,
    playerName: state.playerName,
    playerNameLower: state.playerName.toLowerCase(),
    language: state.language,
    consentAcceptedAt: state.consentAcceptedAt,
    dismissedAnnouncementId: state.dismissedAnnouncementId,
    jobTitle: state.jobTitle,
  };
}

export async function pullRemoteState(uid: string): Promise<GameState | null> {
  const snap = await getDoc(doc(db, PLAYERS_COLLECTION, uid));
  if (!snap.exists()) return null;
  const profile = snap.data() as SyncedProfile & ServerOwnedWalletFields;
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
    wallet: { paidCoinBalance: profile.paidCoinBalance ?? 0, potions: profile.potions ?? {} },
    consentAcceptedAt: profile.consentAcceptedAt ?? null,
    dismissedAnnouncementId: profile.dismissedAnnouncementId ?? null,
    jobTitle: profile.jobTitle ?? DEFAULT_JOB_TITLE,
  };
}

/** Fire-and-forget: local play should never block on network sync.
 * `merge: true` is required here — toSyncedProfile never includes the
 * server-owned wallet fields, and without merge a plain setDoc would
 * overwrite the whole document, deleting whatever balance a Cloud Function
 * had just credited. */
export function pushRemoteState(uid: string, state: GameState): void {
  setDoc(doc(db, PLAYERS_COLLECTION, uid), toSyncedProfile(state), { merge: true }).catch((err) => {
    console.warn("雲端同步失敗(不影響本機遊玩)", err);
  });
}

/** Permanently removes this player's cloud profile document — used by
 * "刪除帳號" (Delete Account), not the same as pushRemoteState with an empty
 * state: that would leave a doc behind holding blank data forever, whereas
 * this actually deletes it. Awaited (not fire-and-forget) since the caller
 * needs to know it finished before signing out. */
export async function deleteRemoteState(uid: string): Promise<void> {
  await deleteDoc(doc(db, PLAYERS_COLLECTION, uid));
}

const notifyPlayerRegisteredCallable = httpsCallable<{ playerName?: string }, { ok: boolean }>(
  functions,
  "notifyPlayerRegistered"
);

/** Fire-and-forget, same reasoning as pushRemoteState — this is purely an
 * operator notification, never something the player's own flow should wait
 * on or fail over. Call exactly once, right after linking Google for the
 * first time (see main.ts's handleGoogleSignInClick — the "no existing
 * remote profile" branch), never on every later sign-in. */
export function notifyPlayerRegistered(playerName: string): void {
  notifyPlayerRegisteredCallable({ playerName }).catch((err) => {
    console.warn("新玩家註冊通知發送失敗(不影響遊玩)", err);
  });
}
