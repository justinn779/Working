import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "./firebase";
import type { Campaign } from "./types";

/** Public read (see firestore.rules) — the 活動 tab needs no auth, same as
 * the shop's product list. Only enabled campaigns are ever shown to
 * players; disabled ones stay visible to the admin dashboard for drafting. */
export async function fetchActiveCampaigns(): Promise<Campaign[]> {
  const snap = await getDocs(
    query(collection(db, "campaigns"), where("enabled", "==", true), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => d.data() as Campaign);
}
