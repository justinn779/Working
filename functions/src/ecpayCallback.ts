import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { ECPAY_HASH_IV, ECPAY_HASH_KEY, ECPAY_MERCHANT_ID, verifyCheckMacValue } from "./ecpayClient";
import { notifyTelegram, TELEGRAM_SECRETS } from "./telegram";
import { captureAndCredit, markOrderFailed } from "./topupService";

const db = getFirestore();

/**
 * ECPay's ReturnURL server-to-server notification — unlike PayPal's webhook
 * (a backup safety net for a client-triggered capture), this is the ONLY
 * path that ever credits an order: ECPay's AioCheckOut has no equivalent of
 * a separate client-side "capture" call, so nothing calls captureAndCredit
 * except this handler. Must reply with the literal string "1|OK" on success
 * — that exact string is ECPay's documented ack format, not JSON, and
 * anything else makes ECPay retry the notify.
 */
export const ecpayCallback = onRequest(
  { region: "asia-east1", secrets: [ECPAY_MERCHANT_ID, ECPAY_HASH_KEY, ECPAY_HASH_IV, ...TELEGRAM_SECRETS] },
  async (req, res) => {
    const body = req.body as Record<string, string> | undefined;
    const merchantTradeNo = body?.MerchantTradeNo;
    if (!merchantTradeNo) {
      res.status(400).send("missing MerchantTradeNo");
      return;
    }

    // create() (not set()) — throws if this MerchantTradeNo was already
    // logged. ECPay redelivers a notify whose "1|OK" ack it didn't receive;
    // this is the dedupe guard for that, independent of captureAndCredit's
    // own ecpayCaptures-based guard.
    const logRef = db.collection("ecpayCallbackLogs").doc(merchantTradeNo);
    try {
      await logRef.create({
        rawPayload: body,
        verificationStatus: "PENDING",
        processingStatus: "PENDING",
        errorMessage: null,
        receivedAt: Date.now(),
        processedAt: null,
      });
    } catch {
      // Already seen this MerchantTradeNo — ack immediately so ECPay stops retrying.
      res.status(200).send("1|OK");
      return;
    }

    try {
      if (!verifyCheckMacValue(body!)) {
        console.warn("ECPay 回調驗簽失敗", { merchantTradeNo });
        await logRef.update({
          verificationStatus: "FAILED",
          processingStatus: "REJECTED",
          errorMessage: "CheckMacValue mismatch",
          processedAt: Date.now(),
        });
        await notifyTelegram(`🚨 ECPay 回調驗簽失敗\n訂單:${merchantTradeNo}`);
        res.status(400).send("CheckMacValue verification failed");
        return;
      }
      await logRef.update({ verificationStatus: "SUCCESS" });

      const rtnCode = body!.RtnCode;
      const tradeNo = body!.TradeNo;
      const tradeAmt = Number(body!.TradeAmt);

      if (rtnCode === "1" && tradeNo && Number.isFinite(tradeAmt)) {
        await captureAndCredit(merchantTradeNo, tradeNo, tradeAmt);
      } else {
        await markOrderFailed(merchantTradeNo, `ECPay 回傳 RtnCode=${rtnCode} RtnMsg=${body!.RtnMsg ?? ""}`);
      }

      await logRef.update({ processingStatus: "DONE", processedAt: Date.now() });
      res.status(200).send("1|OK");
    } catch (err) {
      await logRef.update({
        processingStatus: "ERROR",
        errorMessage: (err as Error)?.message ?? String(err),
        processedAt: Date.now(),
      });
      console.error("ECPay 回調處理失敗", err);
      await notifyTelegram(`🚨 ECPay 回調處理失敗\n訂單:${merchantTradeNo}\n錯誤:${(err as Error)?.message ?? String(err)}`);
      // Non-"1|OK" so ECPay retries — the dedupe guard above means a retry is safe.
      res.status(500).send("processing error");
    }
  }
);
