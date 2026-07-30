import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { Announcement } from "./types";

/** Public read (see firestore.rules) — no auth needed, since this must be
 * checkable before any sign-in flow even runs. */
export async function fetchCurrentAnnouncement(): Promise<Announcement | null> {
  const snap = await getDoc(doc(db, "announcements", "current"));
  return snap.exists() ? (snap.data() as Announcement) : null;
}
