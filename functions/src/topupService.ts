import { getFirestore } from "firebase-admin/firestore";
import { notifyTelegram } from "./telegram";
import { canTransition, LedgerEntry, OrderStatus, TopupOrder, TopupProduct } from "./topupTypes";

const db = getFirestore();

export class TopupError extends Error {}

/** Blocks new top-ups and spending while an account is under review
 * (insufficient refund clawback, open dispute — see refundService.ts). Not
 * a full account freeze: the player can still play, just not move coins. */
async function assertNotUnderPaymentReview(userId: string): Promise<void> {
  const snap = await db.collection("players").doc(userId).get();
  const review = snap.data()?.paymentReview as { underReview?: boolean } | undefined;
  if (review?.underReview) {
    throw new TopupError("帳號目前因款項問題被暫停儲值/兌換功能,請聯絡客服");
  }
}

/** Creates the internal order doc with price/coins snapshotted from the
 * product at this exact moment — later price changes to the product never
 * retroactively affect an already-created order. No PayPal call yet. */
export async function createOrder(userId: string, productId: string): Promise<TopupOrder> {
  await assertNotUnderPaymentReview(userId);
  const productSnap = await db.collection("products").doc(productId).get();
  if (!productSnap.exists) throw new TopupError("找不到指定商品");
  const product = productSnap.data() as TopupProduct;
  if (!product.enabled) throw new TopupError("此商品目前無法購買");

  const orderRef = db.collection("orders").doc();
  const now = Date.now();
  const order: TopupOrder = {
    orderId: orderRef.id,
    userId,
    productId,
    productName: product.name,
    currency: product.currency,
    amount: product.price,
    paidCoins: product.paidCoins,
    paypalOrderId: null,
    paypalCaptureId: null,
    status: "CREATED",
    failureReason: null,
    createdAt: now,
    approvedAt: null,
    capturedAt: null,
    creditedAt: null,
    refundedAt: null,
    updatedAt: now,
  };
  await orderRef.set(order);
  return order;
}

export async function getOrder(orderId: string): Promise<TopupOrder | null> {
  const snap = await db.collection("orders").doc(orderId).get();
  return snap.exists ? (snap.data() as TopupOrder) : null;
}

/** Records the PayPal order id returned by Create Order, and enforces that a
 * given paypalOrderId is only ever attached to one internal order — the
 * `paypalOrderIndex/{paypalOrderId}` doc's mere existence (written via
 * `create()`, which throws if it already exists) is Firestore's stand-in for
 * a relational unique index on a non-primary-key column. */
export async function attachPaypalOrder(orderId: string, paypalOrderId: string): Promise<TopupOrder> {
  const orderRef = db.collection("orders").doc(orderId);
  const indexRef = db.collection("paypalOrderIndex").doc(paypalOrderId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new TopupError("訂單不存在");
    const order = snap.data() as TopupOrder;
    if (!canTransition(order.status, "PAYPAL_CREATED")) {
      throw new TopupError(`訂單狀態 ${order.status} 無法轉移到 PAYPAL_CREATED`);
    }

    const now = Date.now();
    tx.create(indexRef, { orderId, createdAt: now });
    tx.update(orderRef, { paypalOrderId, status: "PAYPAL_CREATED" as OrderStatus, updatedAt: now });
    return { ...order, paypalOrderId, status: "PAYPAL_CREATED", updatedAt: now };
  });
}

/** Marks an order CAPTURED once PayPal confirms the capture, after verifying
 * the captured amount/currency exactly match what was snapshotted at order
 * creation. A mismatch moves the order straight to FAILED instead — this is
 * where a tampered/replayed request gets caught, since nothing here trusts
 * anything the client sent except which internal orderId to look at. */
async function markCaptured(
  orderId: string,
  capturedAmount: number,
  capturedCurrency: string
): Promise<TopupOrder> {
  const orderRef = db.collection("orders").doc(orderId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new TopupError("訂單不存在");
    const order = snap.data() as TopupOrder;

    if (order.status === "CAPTURED" || order.status === "CREDITED") {
      return order; // already past this point — idempotent no-op
    }
    if (!canTransition(order.status, "CAPTURED")) {
      throw new TopupError(`訂單狀態 ${order.status} 無法轉移到 CAPTURED`);
    }

    const now = Date.now();
    if (capturedAmount !== order.amount || capturedCurrency !== order.currency) {
      tx.update(orderRef, {
        status: "FAILED" as OrderStatus,
        failureReason: "PayPal 回傳金額或幣別與訂單快照不符",
        updatedAt: now,
      });
      return { ...order, status: "FAILED", failureReason: "PayPal 回傳金額或幣別與訂單快照不符", updatedAt: now };
    }

    tx.update(orderRef, { status: "CAPTURED" as OrderStatus, capturedAt: now, updatedAt: now });
    return { ...order, status: "CAPTURED", capturedAt: now, updatedAt: now };
  });
}

/** The one and only place coins get added to a wallet. Guarded by
 * `paypalCaptures/{captureId}` the same way `attachPaypalOrder` is guarded by
 * `paypalOrderIndex` — its `create()`-only existence check means the same
 * PayPal capture can never be credited twice, no matter how many times this
 * function is called for it (double-click, webhook redelivery, webhook and
 * frontend capture racing each other, retry after a timeout, ...). */
/** `wasNewlyCredited` distinguishes an actual first-time credit from an
 * idempotent no-op re-hit (frontend polling + webhook redelivery both call
 * this for the same capture) — captureAndCredit uses it to notify exactly
 * once per real payment instead of once per call. */
async function creditOrder(
  orderId: string,
  captureId: string
): Promise<{ order: TopupOrder; wasNewlyCredited: boolean }> {
  const orderRef = db.collection("orders").doc(orderId);
  const captureRef = db.collection("paypalCaptures").doc(captureId);

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new TopupError("訂單不存在");
    const order = orderSnap.data() as TopupOrder;

    if (order.status === "CREDITED") return { order, wasNewlyCredited: false };
    if (order.status !== "CAPTURED") {
      throw new TopupError(`訂單狀態 ${order.status} 無法入帳(必須先是 CAPTURED)`);
    }

    const captureSnap = await tx.get(captureRef);
    if (captureSnap.exists) {
      // This captureId was already claimed by a concurrent/earlier call.
      // The order itself just hasn't caught up yet in this read — safe to
      // treat as "someone else is handling it", not an error.
      return { order, wasNewlyCredited: false };
    }

    const walletRef = db.collection("players").doc(order.userId);
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.exists ? walletSnap.data()! : {};
    const paidBefore = (wallet.paidCoinBalance as number) ?? 0;
    const paidAfter = paidBefore + order.paidCoins;
    // Potions are tracked per-productId so a player can stockpile different
    // kinds and use each independently later — separate from paidCoinBalance,
    // which stays purely a bookkeeping figure for refund/clawback math.
    const potionsBefore = (wallet.potions as Record<string, number>) ?? {};
    const potionsAfter = { ...potionsBefore, [order.productId]: (potionsBefore[order.productId] ?? 0) + 1 };

    const now = Date.now();
    // create() (not set()) — a concurrent second attempt for the same
    // captureId aborts here with a conflict and the transaction retries,
    // re-reading captureSnap and taking the "already exists" branch above.
    tx.create(captureRef, { orderId, creditedAt: now });

    const ledgerCol = walletRef.collection("ledger");
    const entry: LedgerEntry = {
      orderId,
      referenceId: captureId,
      transactionType: "PURCHASE_PAID",
      paidCoinDelta: order.paidCoins,
      paidBalanceAfter: paidAfter,
      description: `購買 ${order.productName.zh}`,
      operatorType: "system",
      createdAt: now,
    };
    tx.create(ledgerCol.doc(), entry);

    tx.set(walletRef, { paidCoinBalance: paidAfter, potions: potionsAfter }, { merge: true });
    tx.update(orderRef, {
      status: "CREDITED" as OrderStatus,
      paypalCaptureId: captureId,
      creditedAt: now,
      updatedAt: now,
    });

    return {
      order: { ...order, status: "CREDITED", paypalCaptureId: captureId, creditedAt: now, updatedAt: now },
      wasNewlyCredited: true,
    };
  });
}

/** Converts wallet coins into stamina units — the first (and for now only)
 * thing coins can be spent on. Every spend still writes exactly one ledger
 * entry rather than just adjusting the balance in place, so there's always
 * an audit trail of what happened and when. */
export async function spendCoins(
  userId: string,
  units: number,
  description: string
): Promise<{ paidCoinBalance: number }> {
  if (!Number.isInteger(units) || units <= 0) throw new TopupError("兌換數量必須是正整數");
  await assertNotUnderPaymentReview(userId);
  const walletRef = db.collection("players").doc(userId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(walletRef);
    const wallet = snap.exists ? snap.data()! : {};
    const paidBefore = (wallet.paidCoinBalance as number) ?? 0;
    if (paidBefore < units) throw new TopupError("加班費餘額不足");

    const paidAfter = paidBefore - units;
    const now = Date.now();
    const entry: LedgerEntry = {
      orderId: null,
      referenceId: `spend-${now}-${Math.random().toString(36).slice(2, 8)}`,
      transactionType: "SPEND",
      paidCoinDelta: -units,
      paidBalanceAfter: paidAfter,
      description,
      operatorType: "system",
      createdAt: now,
    };

    tx.set(walletRef, { paidCoinBalance: paidAfter }, { merge: true });
    tx.create(walletRef.collection("ledger").doc(), entry);

    return { paidCoinBalance: paidAfter };
  });
}

/** Consumes one owned potion of the given product and reports how many
 * stamina units it's worth — the product's `paidCoins` field doubles as its
 * stamina-unit amount (1 paidCoin = 1 unit, same rate spendCoins uses), so no
 * separate "units granted" field is needed on the product doc. The actual
 * staminaUnits mutation happens client-side after this resolves, same as
 * spendCoins/exchangeCoinsForStamina — only the inventory count is
 * server-authoritative. */
export async function consumePotion(
  userId: string,
  productId: string
): Promise<{ potions: Record<string, number>; units: number }> {
  await assertNotUnderPaymentReview(userId);
  const productSnap = await db.collection("products").doc(productId).get();
  if (!productSnap.exists) throw new TopupError("找不到指定商品");
  const product = productSnap.data() as TopupProduct;
  const units = product.paidCoins;

  const walletRef = db.collection("players").doc(userId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(walletRef);
    const wallet = snap.exists ? snap.data()! : {};
    const potionsBefore = (wallet.potions as Record<string, number>) ?? {};
    const countBefore = potionsBefore[productId] ?? 0;
    if (countBefore <= 0) throw new TopupError("藥水數量不足");

    const potionsAfter = { ...potionsBefore, [productId]: countBefore - 1 };
    tx.set(walletRef, { potions: potionsAfter }, { merge: true });
    return { potions: potionsAfter, units };
  });
}

/** Explicitly fails an order for a reason discovered *before* markCaptured's
 * own amount/currency check would ever run — e.g. PayPal's capture came back
 * with a status other than COMPLETED, or its custom_id didn't match the
 * order we asked about. Never touches CREDITED orders (idempotent no-op). */
export async function markOrderFailed(orderId: string, reason: string): Promise<TopupOrder> {
  const orderRef = db.collection("orders").doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new TopupError("訂單不存在");
    const order = snap.data() as TopupOrder;
    if (order.status === "CREDITED") return order;
    if (!canTransition(order.status, "FAILED")) return order;

    const now = Date.now();
    tx.update(orderRef, { status: "FAILED" as OrderStatus, failureReason: reason, updatedAt: now });
    return { ...order, status: "FAILED", failureReason: reason, updatedAt: now };
  });
}

/** The single entry point both the frontend-triggered capture flow AND the
 * PayPal webhook flow must call — never call markCaptured/creditOrder
 * separately from two different code paths, or the two flows could
 * independently race past each other's guards. */
export async function captureAndCredit(
  orderId: string,
  captureId: string,
  capturedAmount: number,
  capturedCurrency: string
): Promise<TopupOrder> {
  const captured = await markCaptured(orderId, capturedAmount, capturedCurrency);
  if (captured.status !== "CAPTURED" && captured.status !== "CREDITED") {
    // markCaptured routed it to FAILED (amount/currency mismatch) — do not credit.
    return captured;
  }
  const { order, wasNewlyCredited } = await creditOrder(orderId, captureId);
  if (wasNewlyCredited) {
    await notifyTelegram(
      `💰 儲值入帳\n訂單:${orderId}\n玩家:${order.userId}\n金額:${order.currency} ${order.amount}\n加班費:+${order.paidCoins}`
    );
  }
  return order;
}
