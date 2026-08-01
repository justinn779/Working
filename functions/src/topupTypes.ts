/** Shared enums/types for the PayPal top-up system. Mirrors (loosely) onto
 * src/types.ts on the frontend, but this file is the source of truth for
 * anything that only the backend needs to reason about (transitions,
 * ledger bookkeeping). */

export type OrderStatus =
  | "CREATED"
  | "PAYPAL_CREATED"
  | "APPROVED"
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
  | "REVERSAL"
  | "ACHIEVEMENT_REWARD";

/** Legal order-status transitions. Any write that isn't listed here must be
 * rejected rather than applied — this is what stops e.g. a refunded order
 * from being credited again. `CREDITED` and the terminal refund/chargeback
 * states intentionally have no outgoing edges relevant to Stage 2. */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["PAYPAL_CREATED", "CANCELLED"],
  PAYPAL_CREATED: ["APPROVED", "CAPTURED", "FAILED", "CANCELLED"],
  APPROVED: ["CAPTURED", "FAILED", "CANCELLED"],
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
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  status: OrderStatus;
  failureReason: string | null;
  createdAt: number;
  approvedAt: number | null;
  capturedAt: number | null;
  creditedAt: number | null;
  refundedAt: number | null;
  updatedAt: number;
}

export interface Dispute {
  paypalDisputeId: string;
  orderId: string;
  userId: string;
  reason: string;
  status: "OPEN" | "RESOLVED_BUYER_FAVOR" | "RESOLVED_SELLER_FAVOR" | "UNKNOWN";
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
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
