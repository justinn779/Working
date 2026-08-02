import { collection, getDocs, limit, orderBy, query, startAfter } from "firebase/firestore";
import type { QueryConstraint, QueryDocumentSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import type { Localized, Selection } from "./types";

/** Mirrors functions/src/index.ts's logPlayerAction write shape — one entry
 * per resolveEvent call (cached replays included), unlike the deduped
 * collectedComboKeys used by the 事件 sub-tab. */
export interface PlayerActionEntry {
  at: number;
  comboKey: string;
  selection: Selection;
  durationUnits: number;
  jobTitleAtTime: Localized;
  eventTitle: Localized;
  source: "cached" | "generated";
  newJobTitle: Localized | null;
}

export interface JobTitleHistoryEntry {
  at: number;
  fromTitle: Localized;
  toTitle: Localized;
  viaEventTitle: Localized;
  viaComboKey: string;
}

const ACTIONS_PAGE_SIZE = 30;

export interface ActionLogPage {
  entries: PlayerActionEntry[];
  lastDoc: QueryDocumentSnapshot | null;
  hasMore: boolean;
}

/** Cursor-based paging, newest first — same shape as the admin dashboard's
 * fetchPlayersPage (src/admin/adminApi.ts), fetches one extra doc past the
 * page size purely to answer "is there a next page". Firestore rules
 * restrict this to the signed-in player's own uid (see firestore.rules). */
export async function fetchOwnActions(uid: string, afterDoc?: QueryDocumentSnapshot | null): Promise<ActionLogPage> {
  const constraints: QueryConstraint[] = [orderBy("at", "desc"), limit(ACTIONS_PAGE_SIZE + 1)];
  if (afterDoc) constraints.push(startAfter(afterDoc));
  const snap = await getDocs(query(collection(db, "players", uid, "actions"), ...constraints));
  const hasMore = snap.docs.length > ACTIONS_PAGE_SIZE;
  const pageDocs = snap.docs.slice(0, ACTIONS_PAGE_SIZE);
  return {
    entries: pageDocs.map((d) => d.data() as PlayerActionEntry),
    lastDoc: pageDocs.length > 0 ? pageDocs[pageDocs.length - 1] : null,
    hasMore,
  };
}

/** Title changes are rare — no pagination needed, just the full timeline. */
export async function fetchOwnJobTitleHistory(uid: string): Promise<JobTitleHistoryEntry[]> {
  const snap = await getDocs(query(collection(db, "players", uid, "jobTitleHistory"), orderBy("at", "desc")));
  return snap.docs.map((d) => d.data() as JobTitleHistoryEntry);
}
