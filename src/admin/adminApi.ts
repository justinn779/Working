import { httpsCallable } from "firebase/functions";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  QueryConstraint,
  setDoc,
  where,
} from "firebase/firestore";
import { db, functions } from "../firebase";
import type { Announcement, Localized } from "../types";
import type { OrderStatus, TopupOrder } from "../paypalTopup";

// --- Types mirrored from functions/src/topupTypes.ts — this project
// duplicates shared shapes between frontend/backend rather than sharing a
// package (see src/types.ts's PLAYER_TOKEN for the established precedent);
// the admin dashboard is a second frontend consumer of the same backend
// shapes, so it follows the same pattern. ---

/** Fuller than src/paypalTopup.ts's player-facing TopupProduct — the admin
 * dashboard needs enabled/createdAt/updatedAt too, which players never do. */
export interface AdminProduct {
  id: string;
  productCode: string;
  name: Localized;
  currency: string;
  price: number;
  paidCoins: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Fuller than src/paypalTopup.ts's player-facing TopupOrder — adds the
 * timestamp fields the dashboard displays but a player's own order view
 * doesn't need. */
export interface AdminOrder extends TopupOrder {
  createdAt: number;
  capturedAt: number | null;
  creditedAt: number | null;
  refundedAt: number | null;
  updatedAt: number;
}

export interface LedgerEntry {
  orderId: string | null;
  referenceId: string;
  transactionType: string;
  paidCoinDelta: number;
  paidBalanceAfter: number;
  description: string;
  operatorType: string;
  createdAt: number;
}

export interface Dispute {
  paypalDisputeId: string;
  orderId: string;
  userId: string;
  reason: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
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

export interface WebhookLog {
  eventType: string | null;
  resourceId: string | null;
  verificationStatus: string;
  processingStatus: string;
  errorMessage: string | null;
  receivedAt: number;
  processedAt: number | null;
  retryCount: number;
}

export interface PaymentReview {
  underReview: boolean;
  reason: string | null;
  setAt: number | null;
  setBy: string | null;
}

export interface PlayerWallet {
  playerName?: string;
  paidCoinBalance?: number;
  paymentReview?: PaymentReview | null;
}

export interface PlayerSearchResult {
  uid: string;
  playerName: string;
  paidCoinBalance: number;
}

/** Every list query in the dashboard takes the same shape: an optional
 * [startMs, endMs] window, always sorted newest-first and capped at 100 —
 * "最近 100 筆" is the default view (no dates set), and setting either date
 * narrows it to that window instead. */
export interface DateRange {
  startMs?: number;
  endMs?: number;
}

const RESULT_LIMIT = 100;

function dateRangeClauses(range: DateRange | undefined, field: string): QueryConstraint[] {
  const clauses: QueryConstraint[] = [];
  if (range?.startMs != null) clauses.push(where(field, ">=", range.startMs));
  if (range?.endMs != null) clauses.push(where(field, "<=", range.endMs));
  return clauses;
}

// --- Admin allowlist check (client reads only its own admins/{uid} doc —
// see firestore.rules) ---
export async function isCurrentUserAdmin(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, "admins", uid));
  return snap.exists();
}

// --- Direct Firestore reads (admins get broad read access — see rules) ---

export async function fetchPlayerWallet(uid: string): Promise<PlayerWallet | null> {
  const snap = await getDoc(doc(db, "players", uid));
  return snap.exists() ? (snap.data() as PlayerWallet) : null;
}

/** 入職名稱 isn't unique and isn't the doc id (uid is), so this is a
 * "starts with" range query — the standard Firestore trick for prefix
 * search (no full-text/contains search without a third-party index). */
export async function searchPlayersByName(namePrefix: string): Promise<PlayerSearchResult[]> {
  const prefix = namePrefix.trim();
  if (!prefix) return [];
  const q = query(
    collection(db, "players"),
    where("playerName", ">=", prefix),
    where("playerName", "<=", prefix + ""),
    limit(RESULT_LIMIT)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data() as PlayerWallet;
    return { uid: d.id, playerName: data.playerName ?? "", paidCoinBalance: data.paidCoinBalance ?? 0 };
  });
}

export async function fetchPlayerLedger(uid: string, range?: DateRange): Promise<LedgerEntry[]> {
  const q = query(
    collection(db, "players", uid, "ledger"),
    ...dateRangeClauses(range, "createdAt"),
    orderBy("createdAt", "desc"),
    limit(RESULT_LIMIT)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as LedgerEntry);
}

export async function fetchAllProducts(): Promise<AdminProduct[]> {
  const snap = await getDocs(query(collection(db, "products"), orderBy("price")));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AdminProduct, "id">) }));
}

/** Direct write — products are catalog/reference content, not money
 * movement, so admins can edit them without going through a Cloud Function
 * (see firestore.rules's isAdmin() write grant). */
export async function saveProduct(id: string, data: Omit<AdminProduct, "id">): Promise<void> {
  await setDoc(doc(db, "products", id), data, { merge: true });
}

export async function deleteProduct(id: string): Promise<void> {
  await deleteDoc(doc(db, "products", id));
}

export async function fetchAnnouncement(): Promise<Announcement | null> {
  const snap = await getDoc(doc(db, "announcements", "current"));
  return snap.exists() ? (snap.data() as Announcement) : null;
}

export async function saveAnnouncement(a: Omit<Announcement, "id" | "updatedAt">): Promise<void> {
  const announcement: Announcement = { ...a, id: String(Date.now()), updatedAt: Date.now() };
  await setDoc(doc(db, "announcements", "current"), announcement);
}

export async function fetchDisputes(range?: DateRange): Promise<Dispute[]> {
  const q = query(
    collection(db, "disputes"),
    ...dateRangeClauses(range, "createdAt"),
    orderBy("createdAt", "desc"),
    limit(RESULT_LIMIT)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Dispute);
}

export async function fetchWebhookLogs(range?: DateRange): Promise<WebhookLog[]> {
  const q = query(
    collection(db, "webhookLogs"),
    ...dateRangeClauses(range, "receivedAt"),
    orderBy("receivedAt", "desc"),
    limit(RESULT_LIMIT)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as WebhookLog);
}

export async function fetchAdminActions(range?: DateRange): Promise<AdminActionLog[]> {
  const q = query(
    collection(db, "adminActions"),
    ...dateRangeClauses(range, "createdAt"),
    orderBy("createdAt", "desc"),
    limit(RESULT_LIMIT)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as AdminActionLog);
}

/** Orders lookup — a plain admin-read (broad `isAdmin()` read grant in
 * firestore.rules), not a Cloud Function call, since browsing/searching
 * doesn't move money or need an audit entry; only the actions below do.
 * Exactly one of `orderId` / `userId` is expected — `orderId` does a direct
 * doc lookup (date range is meaningless for a single known order), `userId`
 * (with or without a date range) lists that player's orders, and neither
 * set lists the most recent 100 orders overall. */
export async function queryOrders(filter: { orderId?: string; userId?: string } & DateRange): Promise<AdminOrder[]> {
  if (filter.orderId) {
    const snap = await getDoc(doc(db, "orders", filter.orderId));
    return snap.exists() ? [snap.data() as AdminOrder] : [];
  }
  const clauses: QueryConstraint[] = [];
  if (filter.userId) clauses.push(where("userId", "==", filter.userId));
  clauses.push(...dateRangeClauses(filter, "createdAt"));
  const q = query(collection(db, "orders"), ...clauses, orderBy("createdAt", "desc"), limit(RESULT_LIMIT));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as AdminOrder);
}

// --- Audited actions — these all go through Cloud Functions, never a
// direct Firestore write, so the transaction/ledger/adminActions logging in
// functions/src/adminHandlers.ts and refundService.ts always applies. ---

const adminRefundOrderCallable = httpsCallable<
  { orderId: string; reason: string; partialAmount?: number },
  { order: AdminOrder; clawedBackPaid: number; shortfall: number; paypalRefundId: string }
>(functions, "adminRefundOrder");
const adminAdjustCoinsCallable = httpsCallable<
  { userId: string; paidDelta: number; reason: string },
  { paidCoinBalance: number }
>(functions, "adminAdjustCoins");
const adminSetPaymentReviewCallable = httpsCallable<
  { userId: string; underReview: boolean; reason: string },
  PaymentReview
>(functions, "adminSetPaymentReview");
const adminReconcileCallable = httpsCallable<Record<string, never>, Record<string, unknown[]>>(
  functions,
  "adminReconcile"
);

export async function adminRefundOrder(orderId: string, reason: string, partialAmount?: number) {
  return (await adminRefundOrderCallable({ orderId, reason, partialAmount })).data;
}

export async function adminAdjustCoins(userId: string, paidDelta: number, reason: string) {
  return (await adminAdjustCoinsCallable({ userId, paidDelta, reason })).data;
}

export async function adminSetPaymentReview(userId: string, underReview: boolean, reason: string) {
  return (await adminSetPaymentReviewCallable({ userId, underReview, reason })).data;
}

export async function adminReconcile() {
  return (await adminReconcileCallable({})).data;
}

export type { OrderStatus, Localized };
