import { onCall, HttpsError } from "firebase-functions/v2/https";
import { notifyTelegram, TELEGRAM_SECRETS } from "./telegram";

interface NotifyPlayerRegisteredData {
  playerName?: string;
}

/** Client-invoked exactly once, right after linking a Google account for
 * the first time (see src/main.ts's handleGoogleSignInClick — the branch
 * where pullRemoteState found no existing profile). There's no
 * email/password signup in this game, so this is the closest equivalent to
 * "a player registered an account"; a purely-anonymous, never-linked player
 * never triggers this. Deliberately a plain notify-only callable rather than
 * a Firestore onDocumentCreated trigger — this project's other functions
 * are all callable/onRequest already, and a first-ever Firestore trigger
 * needs Eventarc permissions to propagate (a multi-minute one-time wait),
 * which this sidesteps entirely. */
export const notifyPlayerRegistered = onCall(
  { region: "asia-east1", maxInstances: 3, secrets: TELEGRAM_SECRETS },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
    const data = request.data as NotifyPlayerRegisteredData;
    // Trusted as-is (only length-capped), same reasoning as playerName
    // elsewhere in this game — low-stakes casual game, not a moderated
    // public platform.
    const playerName = data?.playerName?.trim().slice(0, 20);
    await notifyTelegram(
      `🆕 新玩家註冊\nUID:${request.auth.uid}${playerName ? `\n入職名稱:${playerName}` : ""}`
    );
    return { ok: true };
  }
);
