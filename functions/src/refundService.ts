import { getFirestore } from "firebase-admin/firestore";
import { refundCreditCard } from "./ecpayClient";
import { notifyTelegram } from "./telegram";
import { canTransition, LedgerEntry, OrderStatus, TopupOrder } from "./topupTypes";
import { getOrder, TopupError } from "./topupService";

const db = getFirestore();

export interface RefundOutcome {
  order: TopupOrder;
  clawedBackPaid: number;
  shortfall: number;
  ecpayRefundReference: string;
}

/**
 * Refunds an order: calls ECPay's credit-card DoAction (Action=R) refund,
 * then claws back coins from the player's *pooled* wallet, capped by what's
 * actually still there (coins from different orders mix together once
 * credited — see the Stage 4 design note this inherited from the PayPal
 * version). Whatever can't be clawed back is never silently dropped: it
 * puts the account into paymentReview instead of corrupting the balance
 * into an untrackable negative number.
 *
 * Credit-card-only, matching this project's ChoosePayment=Credit-only
 * checkout (see ecpayClient.ts) — ECPay's ATM/CVS/barcode payment types
 * can't be refunded through this API at all, so there's no branching here
 * for other payment types the way a broader integration might need.
 */
export async function refundOrder(
  orderId: string,
  reason: string,
  partial?: { amount: number }
): Promise<RefundOutcome> {
  if (!reason.trim()) throw new TopupError("退款必須填寫原因");
  const order = await getOrder(orderId);
  if (!order) throw new TopupError("訂單不存在");
  if (!order.ecpayTradeNo) throw new TopupError("訂單沒有對應的 ECPay 請款紀錄,無法退款");
  // REFUND_PENDING itself is a valid starting point — a previous attempt
  // whose ECPay call failed leaves the order here so it can be retried,
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
    refund = await refundCreditCard({
      merchantTradeNo: order.orderId,
      ecpayTradeNo: order.ecpayTradeNo,
      amount: partial ? partial.amount : order.amount,
    });
    if (!refund.ok) throw new Error(refund.message);
  } catch (err) {
    // Stay in REFUND_PENDING (not the terminal FAILED) — REFUND_PENDING has
    // no dead end in the transition table, so a retry can still call this
    // function again for the same order; FAILED would permanently block it.
    await orderRef.update({
      failureReason: `ECPay 退款失敗(可重試):${(err as Error).message}`,
      updatedAt: Date.now(),
    });
    await notifyTelegram(
      `❌ 退款失敗\n訂單:${orderId}\n原因:${(err as Error).message}\n(訂單留在 REFUND_PENDING,可重新呼叫退款重試)`
    );
    throw err;
  }

  // ECPay's DoAction response has no distinct refund-transaction id the way
  // PayPal's Refund API does — it's just a same-trade reversal confirmation
  // — so the ledger reference is synthesized here instead of echoed back.
  const ecpayRefundReference = `refund-${order.ecpayTradeNo}-${Date.now()}`;

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
      referenceId: ecpayRefundReference,
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
      ecpayRefundReference,
    };
  });

  if (outcome.shortfall > 0) {
    await notifyTelegram(
      `⚠️ 退款扣回不足,已標記複查\n訂單:${orderId}\n玩家:${outcome.order.userId}\n無法扣回:${outcome.shortfall} 點加班費`
    );
  }
  return outcome;
}

// PayPal-only automation removed on the ECPay branch: PayPal pushed
// PAYMENT.CAPTURE.REFUNDED/REVERSED and CUSTOMER.DISPUTE.* events to the
// webhook, letting a dashboard-initiated refund or a buyer dispute
// reconcile the wallet automatically (handlePaypalInitiatedRefund/
// recordDispute/resolveDispute, since removed). ECPay's ReturnURL notify
// only ever reports checkout completion — it has no equivalent push for
// refunds initiated outside this app or for card-issuer chargebacks, which
// arrive out-of-band from the acquiring bank instead. Until there's a real
// process for that, refundOrder above (triggered only via adminRefundOrder)
// is the sole way an order's coins get clawed back; a real chargeback still
// needs an admin to manually freeze the account (adminSetPaymentReview) and
// adjust the balance (adminAdjustCoins).
