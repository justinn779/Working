import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, verifyWebhookSignature } from "./paypalClient";
import { notifyTelegram, TELEGRAM_SECRETS } from "./telegram";
import { captureAndCredit } from "./topupService";
import { handlePaypalInitiatedRefund, recordDispute, resolveDispute } from "./refundService";

const db = getFirestore();

/** A refund/reversal event's resource doesn't always carry our own
 * `custom_id` directly (unlike a capture event) — fall back to the
 * `paypalCaptures/{captureId}` mapping this project already maintains for
 * idempotency, keyed by whatever capture id the event references. Never
 * guessed against live PayPal data (no real refund/dispute event has been
 * exercised yet) — if PayPal's real payload shape differs, this logs
 * clearly instead of silently doing nothing. */
async function resolveOrderIdFromResource(resource: Record<string, unknown>): Promise<string | null> {
  if (typeof resource.custom_id === "string") return resource.custom_id;

  const captureId =
    (resource.id as string | undefined) ??
    (Array.isArray(resource.disputed_transactions)
      ? ((resource.disputed_transactions[0] as Record<string, unknown> | undefined)?.seller_transaction_id as
          | string
          | undefined)
      : undefined);
  if (!captureId) return null;

  const mapping = await db.collection("paypalCaptures").doc(captureId).get();
  return mapping.exists ? ((mapping.data()?.orderId as string) ?? null) : null;
}

/**
 * PayPal's server-to-server notification endpoint — the one path that's
 * guaranteed to fire even if the buyer closes the tab right after paying.
 * Handles PAYMENT.CAPTURE.COMPLETED by calling the exact same
 * `captureAndCredit` the frontend-triggered capture flow uses (never a
 * separate code path), so whichever of the two gets there first wins and
 * the other is a no-op. PAYMENT.CAPTURE.REFUNDED/REVERSED and
 * CUSTOMER.DISPUTE.* route into refundService.ts (Stage 4).
 */
export const paypalWebhook = onRequest(
  { region: "asia-east1", secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, ...TELEGRAM_SECRETS] },
  async (req, res) => {
    const eventId = req.body?.id as string | undefined;
    if (!eventId) {
      res.status(400).send("missing event id");
      return;
    }

    const logRef = db.collection("webhookLogs").doc(eventId);
    try {
      // create() (not set()) — throws if this event id was already logged.
      // PayPal redelivers the same event on transient failures/timeouts;
      // this is the dedupe guard for that, independent of captureAndCredit's
      // own paypalCaptures-based guard (this one covers every event type,
      // not just capture-completed).
      await logRef.create({
        eventType: req.body?.event_type ?? null,
        resourceId: req.body?.resource?.id ?? null,
        rawPayload: req.body,
        verificationStatus: "PENDING",
        processingStatus: "PENDING",
        errorMessage: null,
        receivedAt: Date.now(),
        processedAt: null,
        retryCount: 0,
      });
    } catch {
      // Already seen this event id — ack quickly so PayPal stops retrying.
      res.status(200).send("duplicate");
      return;
    }

    try {
      const headerAuthAlgo = req.header("paypal-auth-algo") ?? "";
      const headerCertUrl = req.header("paypal-cert-url") ?? "";
      const headerTransmissionId = req.header("paypal-transmission-id") ?? "";
      const headerTransmissionSig = req.header("paypal-transmission-sig") ?? "";
      const headerTransmissionTime = req.header("paypal-transmission-time") ?? "";
      const result = await verifyWebhookSignature({
        authAlgo: headerAuthAlgo,
        certUrl: headerCertUrl,
        transmissionId: headerTransmissionId,
        transmissionSig: headerTransmissionSig,
        transmissionTime: headerTransmissionTime,
        webhookEvent: req.body,
      });

      if (!result.verified) {
        console.warn("PayPal webhook 驗簽失敗", {
          verificationStatus: result.verificationStatus,
          configuredWebhookIdLength: result.configuredWebhookIdLength,
          headersPresent: {
            authAlgo: !!headerAuthAlgo,
            certUrl: !!headerCertUrl,
            transmissionId: !!headerTransmissionId,
            transmissionSig: !!headerTransmissionSig,
            transmissionTime: !!headerTransmissionTime,
          },
        });
        await logRef.update({
          verificationStatus: "FAILED",
          processingStatus: "REJECTED",
          errorMessage: `verification_status=${result.verificationStatus} configuredWebhookIdLength=${result.configuredWebhookIdLength}`,
          processedAt: Date.now(),
        });
        await notifyTelegram(
          `🚨 PayPal webhook 驗簽失敗\nevent id:${eventId}\nverification_status:${result.verificationStatus}`
        );
        res.status(400).send("signature verification failed");
        return;
      }
      await logRef.update({ verificationStatus: "SUCCESS" });

      const eventType = req.body?.event_type as string;
      const resource = (req.body?.resource ?? {}) as Record<string, unknown>;
      let note: string | null = null;

      if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
        const orderId = resource.custom_id as string | undefined;
        const captureId = resource.id as string;
        const amountObj = resource.amount as { value?: string; currency_code?: string } | undefined;
        if (orderId && amountObj?.value && amountObj.currency_code) {
          await captureAndCredit(orderId, captureId, Number(amountObj.value), amountObj.currency_code);
        } else {
          note = "缺少 orderId 或金額,略過";
        }
      } else if (eventType === "PAYMENT.CAPTURE.REFUNDED" || eventType === "PAYMENT.CAPTURE.REVERSED") {
        const orderId = await resolveOrderIdFromResource(resource);
        if (orderId) {
          await handlePaypalInitiatedRefund(orderId, resource.id as string);
        } else {
          note = "找不到對應的內部訂單,需人工核對";
        }
      } else if (eventType === "CUSTOMER.DISPUTE.CREATED" || eventType === "CUSTOMER.DISPUTE.UPDATED") {
        const orderId = await resolveOrderIdFromResource(resource);
        if (orderId) {
          const orderSnap = await db.collection("orders").doc(orderId).get();
          const orderUserId = orderSnap.data()?.userId as string | undefined;
          if (orderUserId) {
            await recordDispute({
              paypalDisputeId: resource.dispute_id as string,
              orderId,
              userId: orderUserId,
              reason: (resource.reason as string) ?? "UNKNOWN",
              status: "OPEN",
            });
            if (eventType === "CUSTOMER.DISPUTE.CREATED") {
              await notifyTelegram(
                `🚨 PayPal 爭議成立\n訂單:${orderId}\n玩家:${orderUserId}\n原因:${(resource.reason as string) ?? "UNKNOWN"}\n請盡快到後台處理,PayPal 通常有回應期限`
              );
            }
          } else {
            note = "找不到訂單對應的玩家,需人工核對";
          }
        } else {
          note = "找不到對應的內部訂單,需人工核對";
        }
      } else if (eventType === "CUSTOMER.DISPUTE.RESOLVED") {
        const outcome = resource.dispute_outcome as { outcome_code?: string } | undefined;
        const buyerWon = outcome?.outcome_code === "RESOLVED_BUYER_FAVOUR";
        await resolveDispute(resource.dispute_id as string, buyerWon);
      }

      await logRef.update({ processingStatus: "DONE", processedAt: Date.now(), errorMessage: note });
      res.status(200).send("ok");
    } catch (err) {
      await logRef.update({
        processingStatus: "ERROR",
        errorMessage: (err as Error)?.message ?? String(err),
        processedAt: Date.now(),
        retryCount: 1,
      });
      console.error("PayPal webhook 處理失敗", err);
      await notifyTelegram(
        `🚨 PayPal webhook 處理失敗\nevent id:${eventId}\n錯誤:${(err as Error)?.message ?? String(err)}`
      );
      // 500 so PayPal retries/redelivers — the dedupe guard above means a
      // retry is safe, not a double-count risk.
      res.status(500).send("processing error");
    }
  }
);
