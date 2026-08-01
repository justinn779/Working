/** Shared enums/types for the ECPay top-up system. Mirrors (loosely) onto
 * src/types.ts on the frontend, but this file is the source of truth for
 * anything that only the backend needs to reason about (transitions,
 * ledger bookkeeping). */

/** ECPay's flow has no equivalent of PayPal's separate buyer-approved/
 * capture steps — a credit-card AioCheckOut settles in one shot, and the
 * ReturnURL notify (see ecpayCallback.ts) is the *only* path to CREDITED,
 * not a backup for a client-triggered capture. CAPTURED still exists as a
 * brief internal checkpoint (amount/currency verified against the order
 * snapshot) before crediting, same defensive split topupService.ts already
 * used for PayPal, just reached from a single caller now instead of two
 * racing ones. */
export type OrderStatus =
  | "CREATED"
  | "ECPAY_CREATED"
  | "CAPTURED"
  | "CREDITED"
  | "FAILED"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "DISPUTED"
  | "CHARGEBACK";

export type LedgerType =
  | "PURCHASE_PAID"
  | "SPEND"
  | "REFUND"
  | "CHARGEBACK"
  | "EXPIRED"
  | "ADMIN_ADJUSTMENT"
  | "REVERSAL";

/** Legal order-status transitions. Any write that isn't listed here must be
 * rejected rather than applied — this is what stops e.g. a refunded order
 * from being credited again. `CREDITED` and the terminal refund/chargeback
 * states intentionally have no outgoing edges relevant to Stage 2. */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["ECPAY_CREATED", "CANCELLED"],
  ECPAY_CREATED: ["CAPTURED", "FAILED", "CANCELLED"],
  CAPTURED: ["CREDITED", "FAILED"],
  CREDITED: ["REFUND_PENDING", "DISPUTED"],
  FAILED: [],
  CANCELLED: [],
  REFUND_PENDING: ["REFUNDED", "PARTIALLY_REFUNDED", "FAILED"],
  PARTIALLY_REFUNDED: ["REFUND_PENDING", "DISPUTED"],
  REFUNDED: [],
  DISPUTED: ["CHARGEBACK", "CREDITED"],
  CHARGEBACK: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface LedgerEntry {
  orderId: string | null;
  referenceId: string;
  transactionType: LedgerType;
  paidCoinDelta: number;
  paidBalanceAfter: number;
  description: string;
  operatorType: "system" | "admin" | "paypal_webhook";
  createdAt: number;
}

export interface TopupOrder {
  orderId: string;
  userId: string;
  productId: string;
  productName: { zh: string; en: string };
  currency: "TWD";
  amount: number;
  paidCoins: number;
  /** Always equal to `orderId` once set (see ecpayClient.ts's buildCheckoutFields
   * doc comment) — kept as its own field, not derived, so "has the ECPay
   * checkout form actually been generated yet" stays a plain null check,
   * same shape as the old paypalOrderId. */
  ecpayMerchantTradeNo: string | null;
  /** ECPay's own transaction number for this trade, distinct from our
   * MerchantTradeNo — only known once the ReturnURL notify arrives, and
   * required to refund the charge later. */
  ecpayTradeNo: string | null;
  status: OrderStatus;
  failureReason: string | null;
  createdAt: number;
  capturedAt: number | null;
  creditedAt: number | null;
  refundedAt: number | null;
  updatedAt: number;
}


/** Lives on players/{uid}, not on an order — a review freeze applies to the
 * whole wallet (blocks new top-ups and spending) since coins are pooled and
 * a refund/chargeback clawback can't be scoped to "just this order's coins"
 * once merged into the shared balance. Cleared manually by an admin once
 * looked into. */
export interface PaymentReview {
  underReview: boolean;
  reason: string | null;
  setAt: number | null;
  setBy: "system" | "admin" | null;
}

export interface AdminActionLog {
  operatorUid: string;
  action: string;
  targetOrderId: string | null;
  targetUserId: string | null;
  before: unknown;
  after: unknown;
  reason: string;
  createdAt: number;
}

export interface TopupProduct {
  productCode: string;
  name: { zh: string; en: string };
  description: { zh: string; en: string };
  currency: "TWD";
  price: number;
  paidCoins: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
