import { httpsCallable } from "firebase/functions";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db, functions } from "./firebase";
import type { Localized } from "./types";

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

export interface TopupProduct {
  id: string;
  productCode: string;
  name: Localized;
  /** Shown as a hover/tap tooltip on the product name — spells out the
   * concrete effect (e.g. "補 8 小時工時") since the name itself is now just
   * a size label (大瓶/小瓶) and doesn't say how much stamina it grants. */
  description: Localized;
  currency: string;
  price: number;
  paidCoins: number;
}

export interface TopupOrder {
  orderId: string;
  userId: string;
  productId: string;
  productName: Localized;
  currency: string;
  amount: number;
  paidCoins: number;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  status: OrderStatus;
  failureReason: string | null;
}

/** Products are read straight from Firestore (public-read per firestore.rules)
 * rather than through a callable — there's no per-request logic needed for a
 * public catalog listing. Server-authoritative price/coins still only ever
 * get *trusted* at order-creation time on the backend (see createTopupOrder
 * in functions/src/topupHandlers.ts); this is purely a display list. */
export async function listTopupProducts(): Promise<TopupProduct[]> {
  const snap = await getDocs(query(collection(db, "products"), where("enabled", "==", true), orderBy("price")));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TopupProduct, "id">) }));
}

const createTopupOrderCallable = httpsCallable<{ productId: string }, TopupOrder>(functions, "createTopupOrder");
const captureTopupOrderCallable = httpsCallable<{ orderId: string }, TopupOrder>(functions, "captureTopupOrder");
const getOrderStatusCallable = httpsCallable<{ orderId: string }, TopupOrder>(functions, "getOrderStatus");
const exchangeCoinsForStaminaCallable = httpsCallable<{ units: number }, { paidCoinBalance: number }>(
  functions,
  "exchangeCoinsForStamina"
);
const usePotionCallable = httpsCallable<{ productId: string }, { potions: Record<string, number>; units: number }>(
  functions,
  "usePotion"
);

export async function createTopupOrder(productId: string): Promise<TopupOrder> {
  const result = await createTopupOrderCallable({ productId });
  return result.data;
}

export async function captureTopupOrder(orderId: string): Promise<TopupOrder> {
  const result = await captureTopupOrderCallable({ orderId });
  return result.data;
}

export async function getOrderStatus(orderId: string): Promise<TopupOrder> {
  const result = await getOrderStatusCallable({ orderId });
  return result.data;
}

export async function exchangeCoinsForStamina(units: number): Promise<{ paidCoinBalance: number }> {
  const result = await exchangeCoinsForStaminaCallable({ units });
  return result.data;
}

export async function usePotion(productId: string): Promise<{ potions: Record<string, number>; units: number }> {
  const result = await usePotionCallable({ productId });
  return result.data;
}
