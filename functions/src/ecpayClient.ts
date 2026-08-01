import { createHash } from "crypto";
import { defineSecret, defineString } from "firebase-functions/params";

/**
 * Thin wrapper around ECPay (綠界科技)'s "全通路" AioCheckOut API — a
 * fundamentally different integration model from PayPal's REST+OAuth API:
 * there is no client SDK and no "create order, get an id, render a button"
 * step. The backend signs a plain param set with a CheckMacValue checksum;
 * the frontend POSTs those params as an HTML form directly to ECPay's
 * hosted checkout page (the buyer leaves this site). The authoritative
 * payment-completion signal is ECPay's server-to-server ReturnURL POST
 * (see ecpayCallback.ts), not a client-triggered "capture" call — ECPay has
 * no equivalent of PayPal's Orders v2 capture step for a one-time credit
 * card charge.
 *
 * Confirmed against ECPay's official docs/SDK samples (the CheckMacValue
 * algorithm in particular — https://developers.ecpay.com.tw/?p=2902 — is
 * notoriously easy to get subtly wrong; every implementation must match
 * their .NET UrlEncode escaping table exactly or every request is silently
 * rejected with a signature mismatch).
 */

export const ECPAY_MERCHANT_ID = defineSecret("ECPAY_MERCHANT_ID");
export const ECPAY_HASH_KEY = defineSecret("ECPAY_HASH_KEY");
export const ECPAY_HASH_IV = defineSecret("ECPAY_HASH_IV");
/** Not a secret — just picks which base URL to call. Defaults to "stage" so
 * a missing/misconfigured value can never accidentally hit production,
 * mirroring paypalClient.ts's PAYPAL_ENV default-safe pattern. */
export const ECPAY_ENV = defineString("ECPAY_ENV", { default: "stage" });

function baseUrl(): string {
  return ECPAY_ENV.value() === "production" ? "https://payment.ecpay.com.tw" : "https://payment-stage.ecpay.com.tw";
}

/** ECPay's checksum is computed over a string built and escaped to match
 * .NET's `HttpUtility.UrlEncode` output byte-for-byte — plain
 * `encodeURIComponent` differs on several characters, so its output must be
 * lowercased and then have .NET's specific escape choices patched back in.
 * This exact table (space→+, and unescaping -_.!*()  ) is ECPay's own
 * documented algorithm, not a guess — every official SDK sample (PHP/C#/
 * Node) does this same substitution. */
function dotNetStyleEncode(str: string): string {
  return encodeURIComponent(str)
    .toLowerCase()
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%20/g, "+");
}

/** Builds the CheckMacValue for an outgoing param set (checkout) or for
 * verifying an incoming one (the ReturnURL notify) — same algorithm both
 * directions, since ECPay just expects the recipient to recompute it and
 * compare. `params` must NOT include CheckMacValue itself. */
function computeCheckMacValue(params: Record<string, string | number>): string {
  const keys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const joined = keys.map((k) => `${k}=${params[k]}`).join("&");
  const raw = `HashKey=${ECPAY_HASH_KEY.value()}&${joined}&HashIV=${ECPAY_HASH_IV.value()}`;
  const encoded = dotNetStyleEncode(raw);
  return createHash("sha256").update(encoded).digest("hex").toUpperCase();
}

/** yyyy/MM/dd HH:mm:ss in Asia/Taipei local time — ECPay's MerchantTradeDate
 * format, documented as needing to reflect the merchant's actual local
 * clock, not UTC (Cloud Functions run in UTC). */
function taipeiTimestamp(date: Date): string {
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${taipei.getUTCFullYear()}/${pad(taipei.getUTCMonth() + 1)}/${pad(taipei.getUTCDate())} ${pad(taipei.getUTCHours())}:${pad(taipei.getUTCMinutes())}:${pad(taipei.getUTCSeconds())}`;
}

export interface CheckoutParams {
  /** Our own internal orderId, reused verbatim as ECPay's MerchantTradeNo —
   * Firestore auto-ids are exactly 20 chars from an alphanumeric alphabet,
   * which already satisfies ECPay's "20 characters, English letters and
   * digits only, unique per merchant" requirement with no reformatting. */
  merchantTradeNo: string;
  amount: number;
  itemName: string;
  returnUrl: string;
  clientBackUrl: string;
}

/** Returns the action URL + fully-signed field set the frontend POSTs as an
 * HTML form to send the buyer to ECPay's hosted checkout page. Credit-card
 * one-time payment only (ChoosePayment=Credit) — this project doesn't
 * support ECPay's ATM/CVS/barcode flows, which settle asynchronously (the
 * buyer pays later, at a convenience store) and can't be refunded via API. */
export function buildCheckoutFields(params: CheckoutParams): { actionUrl: string; fields: Record<string, string> } {
  const base: Record<string, string | number> = {
    MerchantID: ECPAY_MERCHANT_ID.value(),
    MerchantTradeNo: params.merchantTradeNo,
    MerchantTradeDate: taipeiTimestamp(new Date()),
    PaymentType: "aio",
    TotalAmount: Math.round(params.amount),
    TradeDesc: "workingbigandsmall",
    ItemName: params.itemName,
    ReturnURL: params.returnUrl,
    ChoosePayment: "Credit",
    ClientBackURL: params.clientBackUrl,
    EncryptType: 1,
  };
  const checkMacValue = computeCheckMacValue(base);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) fields[k] = String(v);
  fields.CheckMacValue = checkMacValue;
  return { actionUrl: `${baseUrl()}/Cashier/AioCheckOut/V5`, fields };
}

/** Verifies an incoming ReturnURL notify (or any other ECPay callback) by
 * recomputing CheckMacValue from every OTHER field and comparing — same
 * role as paypalClient.ts's verifyWebhookSignature, but ECPay has no
 * separate verification endpoint to call: the checksum algorithm itself
 * *is* the verification, computed locally on both ends. */
export function verifyCheckMacValue(params: Record<string, string>): boolean {
  const { CheckMacValue, ...rest } = params;
  if (!CheckMacValue) return false;
  return computeCheckMacValue(rest) === CheckMacValue.toUpperCase();
}

export interface RefundResult {
  ok: boolean;
  message: string;
}

/** Credit-card-only refund via ECPay's CreditDetail/DoAction API —
 * Action=R (退刷) reverses a captured charge. `ecpayTradeNo` is ECPay's own
 * TradeNo from the original ReturnURL notify (distinct from our
 * MerchantTradeNo). The response is plain text "1|OK" or "0|<reason>", not
 * JSON — mirrors the ReturnURL ack format ECPay uses everywhere. */
export async function refundCreditCard(params: {
  merchantTradeNo: string;
  ecpayTradeNo: string;
  amount: number;
}): Promise<RefundResult> {
  const base: Record<string, string | number> = {
    MerchantID: ECPAY_MERCHANT_ID.value(),
    MerchantTradeNo: params.merchantTradeNo,
    TradeNo: params.ecpayTradeNo,
    Action: "R",
    TotalAmount: Math.round(params.amount),
  };
  const checkMacValue = computeCheckMacValue(base);
  const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, String(v)])), CheckMacValue: checkMacValue });

  const res = await fetch(`${baseUrl()}/CreditDetail/DoAction`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ECPay 退款請求失敗: ${res.status} ${text}`);
  const [code, ...rest] = text.split("|");
  return { ok: code === "1", message: rest.join("|") || text };
}
