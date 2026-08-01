import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { LedgerEntry } from "./topupTypes";

const db = getFirestore();

/** Rewards a player's first-ever 職稱 change — whether a promotion within
 * the same job or switching to a completely different one, both count the
 * same way src/eventEngine.ts's resolveAction already treats them — with
 * one 工時補充劑(大) potion (productId "stamina-full", see
 * functions/devScripts/seedProducts.js).
 *
 * jobTitle itself is only ever tracked client-side (see cloudSync.ts's
 * SyncedProfile), so this function can't independently verify "is this
 * really the player's first change" — it's safe to call every time
 * src/main.ts's performResolve sees a title change, because the actual gate
 * is the one-time `achievements.firstJobTitleChange` flag on players/{uid},
 * transactionally checked here, and firestore.rules blocks a client from
 * writing that field directly (same protection as paidCoinBalance/potions).
 * A player can therefore claim this at most once no matter how many times
 * the callable itself is invoked. */
export const claimFirstJobTitleAchievement = onCall(
  { region: "asia-east1", maxInstances: 5 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能領取成就獎勵");
    const uid = request.auth.uid;
    const playerRef = db.collection("players").doc(uid);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(playerRef);
      const data = snap.exists ? snap.data()! : {};
      const achievementsBefore = (data.achievements as Record<string, boolean>) ?? {};
      if (achievementsBefore.firstJobTitleChange) {
        return { granted: false, potions: (data.potions as Record<string, number>) ?? {} };
      }

      const potionsBefore = (data.potions as Record<string, number>) ?? {};
      const potionsAfter = { ...potionsBefore, "stamina-full": (potionsBefore["stamina-full"] ?? 0) + 1 };
      const now = Date.now();

      tx.set(
        playerRef,
        { potions: potionsAfter, achievements: { ...achievementsBefore, firstJobTitleChange: true } },
        { merge: true }
      );

      const entry: LedgerEntry = {
        orderId: null,
        referenceId: `achievement-firstJobTitleChange-${uid}`,
        transactionType: "ACHIEVEMENT_REWARD",
        paidCoinDelta: 0,
        paidBalanceAfter: (data.paidCoinBalance as number) ?? 0,
        description: "成就獎勵:首次職稱異動,獲得工時補充劑(大) x1",
        operatorType: "system",
        createdAt: now,
      };
      tx.create(playerRef.collection("ledger").doc(), entry);

      return { granted: true, potions: potionsAfter };
    });
  }
);
