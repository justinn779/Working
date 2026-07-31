import { onCall, HttpsError } from "firebase-functions/v2/https";
import { capturePaypalOrder, createPaypalOrder, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } from "./paypalClient";
import { TELEGRAM_SECRETS } from "./telegram";
import {
  attachPaypalOrder,
  captureAndCredit,
  consumePotion,
  createOrder,
  getOrder,
  markOrderFailed,
  spendCoins,
  TopupError,
} from "./topupService";

const PAYPAL_SECRETS = [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET];

interface CreateTopupOrderData {
  productId: string;
}

export const createTopupOrder = onCall(
  { region: "asia-east1", maxInstances: 5, secrets: PAYPAL_SECRETS },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能建立訂單");
    const data = request.data as CreateTopupOrderData;
    if (!data?.productId) throw new HttpsError("invalid-argument", "缺少 productId");

    try {
      const order = await createOrder(request.auth.uid, data.productId);
      const { paypalOrderId } = await createPaypalOrder({
        internalOrderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
      });
      return await attachPaypalOrder(order.orderId, paypalOrderId);
    } catch (err) {
      if (err instanceof TopupError) throw new HttpsError("failed-precondition", err.message);
      throw err;
    }
  }
);

interface CaptureTopupOrderData {
  orderId: string;
}

export const captureTopupOrder = onCall(
  { region: "asia-east1", maxInstances: 5, secrets: [...PAYPAL_SECRETS, ...TELEGRAM_SECRETS] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能確認付款");
    const data = request.data as CaptureTopupOrderData;
    if (!data?.orderId) throw new HttpsError("invalid-argument", "缺少 orderId");

    const order = await getOrder(data.orderId);
    if (!order) throw new HttpsError("not-found", "找不到指定訂單");
    if (order.userId !== request.auth.uid) throw new HttpsError("permission-denied", "無法存取他人的訂單");
    // Already finished (double-click / retry) — never call PayPal's Capture
    // API again for an order we already know is done; PayPal itself rejects
    // a second capture attempt on an already-captured order, so short-circuit
    // here instead of trying and having to interpret that error.
    if (order.status === "CREDITED") return order;
    if (!order.paypalOrderId) throw new HttpsError("failed-precondition", "訂單尚未建立 PayPal 付款");

    try {
      const captured = await capturePaypalOrder(order.paypalOrderId);
      if (captured.customId !== order.orderId) {
        console.warn("custom_id 不符", { orderId: order.orderId, capturedCustomId: captured.customId });
        return await markOrderFailed(order.orderId, "PayPal 回傳的 custom_id 與訂單不符");
      }
      if (captured.status !== "COMPLETED") {
        return await markOrderFailed(order.orderId, `PayPal 請款狀態為 ${captured.status}`);
      }
      return await captureAndCredit(order.orderId, captured.captureId, captured.amount, captured.currency);
    } catch (err) {
      // Could be a genuine failure, or PayPal rejecting a second concurrent
      // capture attempt (e.g. the webhook got there first) — check whether
      // the order actually finished in the meantime before giving up.
      const latest = await getOrder(order.orderId);
      if (latest?.status === "CREDITED") return latest;
      console.warn("PayPal capture 失敗", err);
      if (err instanceof TopupError) throw new HttpsError("failed-precondition", err.message);
      throw new HttpsError("unavailable", "確認付款時發生問題,請稍後查詢訂單狀態");
    }
  }
);

interface GetOrderStatusData {
  orderId: string;
}

export const getOrderStatus = onCall({ region: "asia-east1", maxInstances: 5 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能查詢訂單");
  const data = request.data as GetOrderStatusData;
  if (!data?.orderId) throw new HttpsError("invalid-argument", "缺少 orderId");

  const order = await getOrder(data.orderId);
  if (!order) throw new HttpsError("not-found", "找不到指定訂單");
  if (order.userId !== request.auth.uid) throw new HttpsError("permission-denied", "無法存取他人的訂單");
  return order;
});

interface ExchangeCoinsForStaminaData {
  units: number;
}

/** "1 加班費 = 1 工時單位", player-initiated. The underlying stamina/工時
 * mechanic stays client-side (unchanged from before this feature); only the
 * coin deduction is server-authoritative. */
export const exchangeCoinsForStamina = onCall({ region: "asia-east1", maxInstances: 5 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能兌換加班費");
  const data = request.data as ExchangeCoinsForStaminaData;
  if (!data?.units || typeof data.units !== "number") throw new HttpsError("invalid-argument", "缺少 units");

  try {
    return await spendCoins(request.auth.uid, data.units, `兌換 ${data.units} 單位工時`);
  } catch (err) {
    if (err instanceof TopupError) throw new HttpsError("failed-precondition", err.message);
    throw err;
  }
});

interface UsePotionData {
  productId: string;
}

/** Each potion purchase only adds to an inventory count (see
 * topupService.ts's creditOrder) — it does NOT grant stamina immediately.
 * This is the separate redemption step, callable any time the player wants
 * to drink one of their stockpiled potions. */
export const usePotion = onCall({ region: "asia-east1", maxInstances: 5 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能使用藥水");
  const data = request.data as UsePotionData;
  if (!data?.productId || typeof data.productId !== "string") {
    throw new HttpsError("invalid-argument", "缺少 productId");
  }

  try {
    return await consumePotion(request.auth.uid, data.productId);
  } catch (err) {
    if (err instanceof TopupError) throw new HttpsError("failed-precondition", err.message);
    throw err;
  }
});
