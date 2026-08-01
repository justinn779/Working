import { onCall, HttpsError } from "firebase-functions/v2/https";
import { buildCheckoutFields, ECPAY_HASH_IV, ECPAY_HASH_KEY, ECPAY_MERCHANT_ID } from "./ecpayClient";
import { consumePotion, createOrder, getOrder, markEcpayCreated, spendCoins, TopupError } from "./topupService";

const ECPAY_SECRETS = [ECPAY_MERCHANT_ID, ECPAY_HASH_KEY, ECPAY_HASH_IV];

/** Deployed Cloud Function / Hosting URLs for this project — ECPay has no
 * dashboard-configured webhook URL the way PayPal does; ReturnURL and
 * ClientBackURL are plain fields passed on every single checkout request,
 * so they're hardcoded here rather than looked up anywhere. */
const ECPAY_RETURN_URL = "https://asia-east1-workplace-big-small.cloudfunctions.net/ecpayCallback";
const CLIENT_BACK_URL_BASE = "https://workplace-big-small.web.app/";

interface CreateTopupOrderData {
  productId: string;
}

/** Unlike PayPal's createTopupOrder (which called out to PayPal and got an
 * id back to render buttons against), this needs no network call at all —
 * ECPay's MerchantTradeNo is our own orderId, so the checkout form's fields
 * can be computed purely locally. Returns the form the frontend must POST
 * to actually send the buyer to ECPay's hosted checkout page. */
export const createTopupOrder = onCall(
  { region: "asia-east1", maxInstances: 5, secrets: ECPAY_SECRETS },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入才能建立訂單");
    const data = request.data as CreateTopupOrderData;
    if (!data?.productId) throw new HttpsError("invalid-argument", "缺少 productId");

    try {
      const order = await createOrder(request.auth.uid, data.productId);
      const { actionUrl, fields } = buildCheckoutFields({
        merchantTradeNo: order.orderId,
        amount: order.amount,
        itemName: order.productName.zh,
        returnUrl: ECPAY_RETURN_URL,
        clientBackUrl: `${CLIENT_BACK_URL_BASE}?ecpayReturn=${order.orderId}`,
      });
      await markEcpayCreated(order.orderId);
      return { orderId: order.orderId, actionUrl, fields };
    } catch (err) {
      if (err instanceof TopupError) throw new HttpsError("failed-precondition", err.message);
      throw err;
    }
  }
);

// There is no ECPay equivalent of PayPal's client-triggered captureTopupOrder
// — ECPay settles a credit-card AioCheckOut in one shot and reports the
// result solely via the ReturnURL server notify (see ecpayCallback.ts),
// which is the only path that ever calls captureAndCredit. The frontend
// only gets to know the outcome by polling getOrderStatus below once the
// buyer's browser comes back via ClientBackURL.

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
