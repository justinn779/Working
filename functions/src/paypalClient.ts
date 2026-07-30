import { defineSecret, defineString } from "firebase-functions/params";

/**
 * Thin wrapper around PayPal's REST API — Orders v2 (create/capture) and the
 * webhook signature verification endpoint. Confirmed against the current
 * official docs during Stage 1 design (not guessed):
 *   https://developer.paypal.com/docs/api/orders/v2/
 *   https://developer.paypal.com/api/rest/webhooks/rest/
 *
 * STAGE 3 STATUS: written and buildable, but NOT yet wired into
 * topupHandlers.ts and NOT deployable-and-working, because
 * PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET/PAYPAL_WEBHOOK_ID have no value set
 * yet (the user's PayPal Sandbox app doesn't exist yet). Once it does:
 *   1. firebase functions:secrets:set PAYPAL_CLIENT_ID
 *   2. firebase functions:secrets:set PAYPAL_CLIENT_SECRET
 *   3. firebase functions:secrets:set PAYPAL_WEBHOOK_ID
 *   4. swap topupHandlers.ts's `MOCK-*` id generation for calls into this
 *      module, add these secrets to those onCall's `secrets: [...]` list,
 *      redeploy, and test against Sandbox.
 */

export const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
export const PAYPAL_CLIENT_SECRET = defineSecret("PAYPAL_CLIENT_SECRET");
export const PAYPAL_WEBHOOK_ID = defineSecret("PAYPAL_WEBHOOK_ID");
/** Not a secret — just picks which base URL to call. Defaults to sandbox so
 * a missing/misconfigured value can never accidentally hit production. */
export const PAYPAL_ENV = defineString("PAYPAL_ENV", { default: "sandbox" });

function baseUrl(): string {
  return PAYPAL_ENV.value() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  const basicAuth = Buffer.from(`${PAYPAL_CLIENT_ID.value()}:${PAYPAL_CLIENT_SECRET.value()}`).toString("base64");
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function paypalFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export interface CreatePaypalOrderParams {
  internalOrderId: string;
  amount: number;
  currency: string;
}

/** `custom_id` carries our internal orderId through PayPal and back — this
 * is the correlation key both the Capture response and the webhook use to
 * find the matching internal order, never anything the client sends. */
export async function createPaypalOrder(params: CreatePaypalOrderParams): Promise<{ paypalOrderId: string }> {
  const res = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: params.internalOrderId,
          amount: { currency_code: params.currency, value: String(params.amount) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            // Digital goods — no physical delivery address to collect.
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`PayPal Create Order failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string };
  return { paypalOrderId: json.id };
}

export interface CapturedPaypalOrder {
  status: string;
  captureId: string;
  amount: number;
  currency: string;
  customId: string | null;
}

export async function capturePaypalOrder(paypalOrderId: string): Promise<CapturedPaypalOrder> {
  const res = await paypalFetch(`/v2/checkout/orders/${paypalOrderId}/capture`, { method: "POST" });
  if (!res.ok) throw new Error(`PayPal Capture Order failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    status: string;
    purchase_units: Array<{
      custom_id?: string;
      payments?: {
        captures?: Array<{
          id: string;
          status: string;
          custom_id?: string;
          amount: { value: string; currency_code: string };
        }>;
      };
    }>;
  };
  const unit = json.purchase_units[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) throw new Error("PayPal Capture Order response missing capture details");
  // custom_id can be echoed at either the purchase_unit level or the
  // capture level depending on response variant — check both rather than
  // assuming one, since a missing/wrong value here would wrongly fail a
  // genuinely successful payment.
  return {
    status: capture.status,
    captureId: capture.id,
    amount: Number(capture.amount.value),
    currency: capture.amount.currency_code,
    customId: capture.custom_id ?? unit.custom_id ?? null,
  };
}

export interface RefundResult {
  refundId: string;
  status: string;
}

/** POST /v2/payments/captures/{id}/refund — omitting `amount` refunds the
 * full remaining captured amount; passing it does a partial refund.
 * Confirmed against a real Sandbox response: a full refund's response has
 * NO `amount` field at all (only echoed back for partial refunds, where we
 * already know the value since we're the one who sent it) — callers must
 * use the amount they already know from the order, not read it back here. */
export async function refundCapture(
  captureId: string,
  partialAmount?: { amount: number; currency: string }
): Promise<RefundResult> {
  const res = await paypalFetch(`/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    body: JSON.stringify(
      partialAmount
        ? { amount: { value: String(partialAmount.amount), currency_code: partialAmount.currency } }
        : {}
    ),
  });
  if (!res.ok) throw new Error(`PayPal Refund failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; status: string };
  return { refundId: json.id, status: json.status };
}

export interface WebhookVerificationInput {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  /** The exact raw request body PayPal sent, parsed to JSON. */
  webhookEvent: unknown;
}

/** Delegates verification to PayPal's own endpoint rather than validating
 * the certificate chain locally — this is PayPal's documented recommended
 * approach, not a shortcut. Returns PayPal's raw `verification_status`
 * string (not just a boolean) plus the configured webhook id's length (never
 * the value itself) so a mismatch is diagnosable without ever logging the
 * secret. */
export async function verifyWebhookSignature(
  input: WebhookVerificationInput
): Promise<{ verified: boolean; verificationStatus: string; configuredWebhookIdLength: number }> {
  const webhookId = PAYPAL_WEBHOOK_ID.value();
  const res = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: input.authAlgo,
      cert_url: input.certUrl,
      transmission_id: input.transmissionId,
      transmission_sig: input.transmissionSig,
      transmission_time: input.transmissionTime,
      webhook_id: webhookId,
      webhook_event: input.webhookEvent,
    }),
  });
  if (!res.ok) throw new Error(`PayPal webhook verification request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { verification_status: string };
  return {
    verified: json.verification_status === "SUCCESS",
    verificationStatus: json.verification_status,
    configuredWebhookIdLength: webhookId.length,
  };
}
