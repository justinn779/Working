import { getFirestore } from "firebase-admin/firestore";
import { refundCapture } from "./paypalClient";
import { notifyTelegram } from "./telegram";
import { canTransition, Dispute, LedgerEntry, OrderStatus, TopupOrder } from "./topupTypes";
import { getOrder, TopupError } from "./topupService";

const db = getFirestore();

export interface RefundOutcome {
  order: TopupOrder;
  clawedBackPaid: number;
  shortfall: number;
  paypalRefundId: string;
}

/**
 * Refunds an order: calls PayPal's Refund API, then claws back coins from
 * the player's *pooled* wallet, capped by what's actually still there
 * (coins from different orders mix together once credited — see the Stage 4
 * design note). Whatever can't be clawed back is never silently dropped:
 * it puts the account into paymentReview instead of corrupting the balance
 * into an untrackable negative number.
 */
export async function refundOrder(
  orderId: string,
  reason: string,
  partial?: { amount: number }
): Promise<RefundOutcome> {
  if (!reason.trim()) throw new TopupError("退款必須填寫原因");
  const order = await getOrder(orderId);
  if (!order) throw new TopupError("訂單不存在");
  if (!order.paypalCaptureId) throw new TopupError("訂單沒有對應的 PayPal 請款紀錄,無法退款");
  // REFUND_PENDING itself is a valid starting point — a previous attempt
  // whose PayPal call failed leaves the order here so it can be retried,
  // not a transition target to re-derive via canTransition (which only
  // models edges out of a state, not staying in one).
  const alreadyPending = order.status === "REFUND_PENDING";
  if (!alreadyPending && !canTransition(order.status, "REFUND_PENDING")) {
    throw new TopupError(`訂單狀態 ${order.status} 無法退款`);
  }

  const orderRef = db.collection("orders").doc(orderId);
  if (!alreadyPending) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      const current = snap.data() as TopupOrder;
      if (current.status !== "REFUND_PENDING" && !canTransition(current.status, "REFUND_PENDING")) {
        throw new TopupError(`訂單狀態 ${current.status} 無法退款`);
      }
      tx.update(orderRef, { status: "REFUND_PENDING" as OrderStatus, updatedAt: Date.now() });
    });
  }

  let refund;
  try {
    refund = await refundCapture(
      order.paypalCaptureId,
      partial ? { amount: partial.amount, currency: order.currency } : undefined
    );
  } catch (err) {
    // Stay in REFUND_PENDING (not the terminal FAILED) — REFUND_PENDING has
    // no dead end in the transition table, so a retry can still call this
    // function again for the same order; FAILED would permanently block it.
    await orderRef.update({
      failureReason: `PayPal 退款失敗(可重試):${(err as Error).message}`,
      updatedAt: Date.now(),
    });
    await notifyTelegram(
      `❌ 退款失敗\n訂單:${orderId}\n原因:${(err as Error).message}\n(訂單留在 REFUND_PENDING,可重新呼叫退款重試)`
    );
    throw err;
  }

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    const current = snap.data() as TopupOrder;

    const walletRef = db.collection("players").doc(current.userId);
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.exists ? walletSnap.data()! : {};
    const paidBefore = (wallet.paidCoinBalance as number) ?? 0;

    // Full refund claws back everything this order granted; a partial
    // refund scales proportionally to the refunded amount.
    const refundRatio = partial ? partial.amount / current.amount : 1;
    const targetClawback = Math.round(current.paidCoins * refundRatio);
    const paidClawback = Math.min(targetClawback, paidBefore);
    const shortfall = targetClawback - paidClawback;

    const paidAfter = paidBefore - paidClawback;
    const now = Date.now();

    const walletUpdate: Record<string, unknown> = { paidCoinBalance: paidAfter };
    if (shortfall > 0) {
      walletUpdate.paymentReview = {
        underReview: true,
        reason: `訂單 ${orderId} 退款 ${shortfall} 點無法扣回(玩家可能已花用),需人工複查`,
        setAt: now,
        setBy: "system",
      };
    }
    tx.set(walletRef, walletUpdate, { merge: true });

    const entry: LedgerEntry = {
      orderId,
      referenceId: refund.refundId,
      transactionType: "REFUND",
      paidCoinDelta: -paidClawback,
      paidBalanceAfter: paidAfter,
      description: `退款(${reason})`,
      operatorType: "admin",
      createdAt: now,
    };
    tx.create(walletRef.collection("ledger").doc(), entry);

    const newStatus: OrderStatus = refundRatio < 1 ? "PARTIALLY_REFUNDED" : "REFUNDED";
    tx.update(orderRef, { status: newStatus, refundedAt: now, updatedAt: now });

    return {
      order: { ...current, status: newStatus, refundedAt: now, updatedAt: now },
      clawedBackPaid: paidClawback,
      shortfall,
      paypalRefundId: refund.refundId,
    };
  });

  if (outcome.shortfall > 0) {
    await notifyTelegram(
      `⚠️ 退款扣回不足,已標記複查\n訂單:${orderId}\n玩家:${outcome.order.userId}\n無法扣回:${outcome.shortfall} 點加班費`
    );
  }
  return outcome;
}

/** Applies the same pooled-wallet clawback math as refundOrder, but for a
 * PayPal-side chargeback/reversal instead of a merchant-initiated refund —
 * shared so both paths can never diverge in how they compute what to take
 * back. No PayPal API call here: the money movement already happened on
 * PayPal's side, this only reconciles our own ledger/order state to match. */
async function clawBackOrderCoins(
  orderId: string,
  referenceId: string,
  transactionType: "REFUND" | "CHARGEBACK",
  description: string,
  targetStatus: OrderStatus
): Promise<void> {
  const orderRef = db.collection("orders").doc(orderId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) return null;
    const order = snap.data() as TopupOrder;
    if (order.status === targetStatus || order.status === "REFUNDED" || order.status === "CHARGEBACK") return null;

    const walletRef = db.collection("players").doc(order.userId);
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.exists ? walletSnap.data()! : {};
    const paidBefore = (wallet.paidCoinBalance as number) ?? 0;
    const paidClawback = Math.min(order.paidCoins, paidBefore);
    const shortfall = order.paidCoins - paidClawback;
    const paidAfter = paidBefore - paidClawback;
    const now = Date.now();

    const walletUpdate: Record<string, unknown> = { paidCoinBalance: paidAfter };
    if (shortfall > 0) {
      walletUpdate.paymentReview = {
        underReview: true,
        reason: `訂單 ${orderId} 的 ${transactionType} 有 ${shortfall} 點無法扣回,需人工複查`,
        setAt: now,
        setBy: "system",
      };
    }
    tx.set(walletRef, walletUpdate, { merge: true });

    const entry: LedgerEntry = {
      orderId,
      referenceId,
      transactionType,
      paidCoinDelta: -paidClawback,
      paidBalanceAfter: paidAfter,
      description,
      operatorType: "system",
      createdAt: now,
    };
    tx.create(walletRef.collection("ledger").doc(), entry);
    tx.update(orderRef, { status: targetStatus, refundedAt: now, updatedAt: now });
    return { shortfall, userId: order.userId };
  });

  if (result && result.shortfall > 0) {
    await notifyTelegram(
      `⚠️ ${transactionType === "CHARGEBACK" ? "Chargeback" : "退款"}扣回不足,已標記複查\n訂單:${orderId}\n玩家:${result.userId}\n無法扣回:${result.shortfall} 點加班費`
    );
  }
}

/** PAYMENT.CAPTURE.REFUNDED / PAYMENT.CAPTURE.REVERSED webhook events —
 * PayPal-initiated (e.g. refunded directly from the PayPal dashboard,
 * bypassing our own admin refund callable entirely). Must still converge on
 * the same coin math, or a refund done outside our own tooling would leave
 * the wallet untouched. */
export async function handlePaypalInitiatedRefund(orderId: string, paypalRefundId: string): Promise<void> {
  await clawBackOrderCoins(orderId, paypalRefundId, "REFUND", "PayPal 端發起的退款", "REFUNDED");
}

export async function recordDispute(dispute: Omit<Dispute, "createdAt" | "updatedAt" | "resolvedAt">): Promise<void> {
  const ref = db.collection("disputes").doc(dispute.paypalDisputeId);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      tx.update(ref, { status: dispute.status, updatedAt: now });
    } else {
      tx.create(ref, { ...dispute, createdAt: now, updatedAt: now, resolvedAt: null });
    }
    const orderRef = db.collection("orders").doc(dispute.orderId);
    const orderSnap = await tx.get(orderRef);
    if (orderSnap.exists) {
      const order = orderSnap.data() as TopupOrder;
      if (canTransition(order.status, "DISPUTED")) {
        tx.update(orderRef, { status: "DISPUTED" as OrderStatus, updatedAt: now });
      }
    }
    // Freeze the wallet (blocks new top-ups and spend, see topupHandlers'
    // paymentReview checks) while a dispute is open — coins tied to a
    // disputed payment shouldn't be spendable until it resolves.
    const walletRef = db.collection("players").doc(dispute.userId);
    tx.set(
      walletRef,
      {
        paymentReview: {
          underReview: true,
          reason: `訂單 ${dispute.orderId} 有付款爭議(${dispute.reason}),等待處理`,
          setAt: now,
          setBy: "system",
        },
      },
      { merge: true }
    );
  });
}

export async function resolveDispute(paypalDisputeId: string, buyerWon: boolean): Promise<void> {
  const ref = db.collection("disputes").doc(paypalDisputeId);
  const snap = await ref.get();
  if (!snap.exists) throw new TopupError("找不到對應的爭議紀錄");
  const dispute = snap.data() as Dispute;
  const now = Date.now();

  await ref.update({
    status: buyerWon ? "RESOLVED_BUYER_FAVOR" : "RESOLVED_SELLER_FAVOR",
    resolvedAt: now,
    updatedAt: now,
  });

  if (buyerWon) {
    // Buyer won = chargeback: claw back coins, keep the account flagged.
    await clawBackOrderCoins(
      dispute.orderId,
      paypalDisputeId,
      "CHARGEBACK",
      `爭議判定買方勝訴(chargeback)`,
      "CHARGEBACK"
    );
  } else {
    // Seller (us) won — clear the order back to CREDITED and lift the
    // review freeze if this dispute was the reason for it.
    const orderRef = db.collection("orders").doc(dispute.orderId);
    const walletRef = db.collection("players").doc(dispute.userId);
    await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (orderSnap.exists && (orderSnap.data() as TopupOrder).status === "DISPUTED") {
        tx.update(orderRef, { status: "CREDITED" as OrderStatus, updatedAt: now });
      }
      const walletSnap = await tx.get(walletRef);
      const review = walletSnap.data()?.paymentReview as { reason?: string } | undefined;
      if (review?.reason?.includes(dispute.orderId)) {
        tx.set(walletRef, { paymentReview: { underReview: false, reason: null, setAt: null, setBy: null } }, { merge: true });
      }
    });
  }
}
