import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } from "./paypalClient";
import { refundOrder } from "./refundService";
import { notifyTelegram, TELEGRAM_SECRETS } from "./telegram";
import { getOrder, TopupError } from "./topupService";
import { AdminActionLog, LedgerEntry } from "./topupTypes";

const db = getFirestore();
const PAYPAL_SECRETS = [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET];

/**
 * There is deliberately no admin web UI (Stage 1 design decision: core
 * correctness first, ops tooling later) — these are plain protected
 * callables, meant to be invoked by the developer directly (e.g. via a
 * small script using the Firebase client SDK, or the emulator/console).
 * Membership is a Firestore allowlist doc rather than a custom auth claim,
 * so granting/revoking admin access never needs a redeploy.
 */
async function assertAdmin(uid: string | undefined): Promise<string> {
  if (!uid) throw new HttpsError("unauthenticated", "請先登入");
  const snap = await db.collection("admins").doc(uid).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "沒有管理權限");
  return uid;
}

async function logAdminAction(
  operatorUid: string,
  action: string,
  targetOrderId: string | null,
  targetUserId: string | null,
  before: unknown,
  after: unknown,
  reason: string
): Promise<void> {
  const entry: AdminActionLog = {
    operatorUid,
    action,
    targetOrderId,
    targetUserId,
    before,
    after,
    reason,
    createdAt: Date.now(),
  };
  await db.collection("adminActions").add(entry);
  await notifyTelegram(
    `🛠 管理員操作:${action}\n操作人:${operatorUid}\n對象:${targetOrderId ?? targetUserId ?? "—"}\n原因:${reason}`
  );
}

interface AdminRefundOrderData {
  orderId: string;
  reason: string;
  partialAmount?: number;
}

export const adminRefundOrder = onCall(
  { region: "asia-east1", maxInstances: 3, secrets: [...PAYPAL_SECRETS, ...TELEGRAM_SECRETS] },
  async (request) => {
    const operatorUid = await assertAdmin(request.auth?.uid);
    const data = request.data as AdminRefundOrderData;
    if (!data?.orderId || !data?.reason?.trim()) {
      throw new HttpsError("invalid-argument", "缺少 orderId 或 reason(退款必須填寫原因)");
    }
    const before = await getOrder(data.orderId);
    try {
      const result = await refundOrder(
        data.orderId,
        data.reason,
        data.partialAmount ? { amount: data.partialAmount } : undefined
      );
      await logAdminAction(
        operatorUid,
        "refundOrder",
        data.orderId,
        before?.userId ?? null,
        before,
        result,
        data.reason
      );
      return result;
    } catch (err) {
      if (err instanceof TopupError) throw new HttpsError("failed-precondition", err.message);
      throw err;
    }
  }
);

// adminGetOrder/adminSearchOrders used to live here as callables, but
// looking up or listing orders doesn't move money or need an audit trail —
// admins now read `orders` directly from the client (broad `isAdmin()` read
// grant in firestore.rules, see src/admin/adminApi.ts's queryOrders). Only
// actions that actually change something (refund/adjust/review/reconcile,
// below) still go through a Cloud Function.

interface AdminAdjustCoinsData {
  userId: string;
  paidDelta: number;
  reason: string;
}

export const adminAdjustCoins = onCall(
  { region: "asia-east1", maxInstances: 3, secrets: TELEGRAM_SECRETS },
  async (request) => {
    const operatorUid = await assertAdmin(request.auth?.uid);
    const data = request.data as AdminAdjustCoinsData;
    if (!data?.userId || !data?.reason?.trim()) {
      throw new HttpsError("invalid-argument", "缺少 userId 或 reason(人工調整加班費必須填寫原因)");
    }
    if (!Number.isInteger(data.paidDelta ?? 0)) {
      throw new HttpsError("invalid-argument", "paidDelta 必須是整數");
    }

    const walletRef = db.collection("players").doc(data.userId);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(walletRef);
      const before = snap.exists ? snap.data()! : {};
      const paidBefore = (before.paidCoinBalance as number) ?? 0;
      const paidAfter = Math.max(0, paidBefore + (data.paidDelta ?? 0));
      const now = Date.now();

      tx.set(walletRef, { paidCoinBalance: paidAfter }, { merge: true });
      const entry: LedgerEntry = {
        orderId: null,
        referenceId: `admin-${operatorUid}-${now}`,
        transactionType: "ADMIN_ADJUSTMENT",
        paidCoinDelta: paidAfter - paidBefore,
        paidBalanceAfter: paidAfter,
        description: data.reason,
        operatorType: "admin",
        createdAt: now,
      };
      tx.create(walletRef.collection("ledger").doc(), entry);
      return { before: { paidBefore }, after: { paidAfter } };
    });

    await logAdminAction(operatorUid, "adjustCoins", null, data.userId, result.before, result.after, data.reason);
    return result.after;
  }
);

interface AdminSetPaymentReviewData {
  userId: string;
  underReview: boolean;
  reason: string;
}

export const adminSetPaymentReview = onCall(
  { region: "asia-east1", maxInstances: 3, secrets: TELEGRAM_SECRETS },
  async (request) => {
    const operatorUid = await assertAdmin(request.auth?.uid);
    const data = request.data as AdminSetPaymentReviewData;
    if (!data?.userId || typeof data.underReview !== "boolean") {
      throw new HttpsError("invalid-argument", "缺少 userId 或 underReview");
    }
    const walletRef = db.collection("players").doc(data.userId);
    const before = (await walletRef.get()).data()?.paymentReview ?? null;
    const now = Date.now();
    const after = data.underReview
      ? { underReview: true, reason: data.reason || "管理員手動設定", setAt: now, setBy: "admin" as const }
      : { underReview: false, reason: null, setAt: null, setBy: null };
    await walletRef.set({ paymentReview: after }, { merge: true });
    await logAdminAction(
      operatorUid,
      "setPaymentReview",
      null,
      data.userId,
      before,
      after,
      data.reason || "(解除複查)"
    );
    return after;
  }
);

/**
 * Manual reconciliation pass (Stage 1 decision: manually-triggered, not a
 * Cloud Scheduler job, to avoid extra always-on cost/setup for a
 * hobby-scale project). Only detects and reports — never auto-fixes, per
 * the design doc's "must never blindly re-credit when ambiguous."
 */
export const adminReconcile = onCall(
  { region: "asia-east1", maxInstances: 1, timeoutSeconds: 120, secrets: TELEGRAM_SECRETS },
  async (request) => {
    await assertAdmin(request.auth?.uid);

    const staleThresholdMs = 24 * 60 * 60 * 1000; // 24h — PayPal orders themselves expire after 3h, this is generous slack.
    const now = Date.now();
    const report: Record<string, unknown[]> = {
      stuckOrders: [],
      capturedWithoutCaptureRecord: [],
      erroredWebhooks: [],
    };

    const stuckStatuses = ["CREATED", "PAYPAL_CREATED", "APPROVED", "CAPTURED", "REFUND_PENDING"];
    const ordersSnap = await db.collection("orders").where("status", "in", stuckStatuses).get();
    for (const doc of ordersSnap.docs) {
      const order = doc.data();
      if (now - (order.updatedAt as number) > staleThresholdMs) {
        report.stuckOrders.push({ orderId: doc.id, status: order.status, updatedAt: order.updatedAt });
      }
    }

    const creditedSnap = await db.collection("orders").where("status", "==", "CREDITED").limit(200).get();
    for (const doc of creditedSnap.docs) {
      const order = doc.data();
      if (!order.paypalCaptureId) {
        report.capturedWithoutCaptureRecord.push({ orderId: doc.id });
        continue;
      }
      const captureDoc = await db.collection("paypalCaptures").doc(order.paypalCaptureId).get();
      if (!captureDoc.exists) {
        report.capturedWithoutCaptureRecord.push({ orderId: doc.id, paypalCaptureId: order.paypalCaptureId });
      }
    }

    const errorWebhooksSnap = await db
      .collection("webhookLogs")
      .where("processingStatus", "==", "ERROR")
      .orderBy("receivedAt", "desc")
      .limit(50)
      .get();
    report.erroredWebhooks = errorWebhooksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const anomalyCount =
      report.stuckOrders.length + report.capturedWithoutCaptureRecord.length + report.erroredWebhooks.length;
    if (anomalyCount > 0) {
      await notifyTelegram(
        `⚠️ 對帳發現異常\n卡住的訂單:${report.stuckOrders.length}\n入帳但缺紀錄:${report.capturedWithoutCaptureRecord.length}\nWebhook 錯誤:${report.erroredWebhooks.length}`
      );
    }

    return report;
  }
);
