import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { GameState } from "./state";

const PLAYERS_COLLECTION = "players";

export async function pullRemoteState(uid: string): Promise<GameState | null> {
  const snap = await getDoc(doc(db, PLAYERS_COLLECTION, uid));
  return snap.exists() ? (snap.data() as GameState) : null;
}

/** Fire-and-forget: local play should never block on network sync. */
export function pushRemoteState(uid: string, state: GameState): void {
  setDoc(doc(db, PLAYERS_COLLECTION, uid), state).catch((err) => {
    console.warn("雲端同步失敗(不影響本機遊玩)", err);
  });
}
