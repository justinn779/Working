import { httpsCallable } from "firebase/functions";
import { getOptionById } from "./combo";
import { functions } from "./firebase";
import { CATEGORY_ORDER } from "./types";
import type { Category, GameEvent, Selection } from "./types";

interface ResolveEventRequest {
  selection: Selection;
  labels: Partial<Record<Category, string | null>>;
  durationUnits: number;
}

const resolveEventCallable = httpsCallable<ResolveEventRequest, GameEvent>(
  functions,
  "resolveEvent"
);

/** Calls the Cloud Function that checks the shared Firestore cache and, on a
 * miss, asks GPT to generate a brand-new event. Throws on any failure
 * (offline, not signed in, function not deployed yet) — callers should catch
 * and fall back to the local template generator. */
export async function generateEventRemote(
  selection: Selection,
  durationUnits: number
): Promise<GameEvent> {
  const labels = Object.fromEntries(
    CATEGORY_ORDER.map((cat) => [
      cat,
      selection[cat] ? getOptionById(selection[cat] as string)?.label ?? null : null,
    ])
  ) as Partial<Record<Category, string | null>>;

  const result = await resolveEventCallable({ selection, labels, durationUnits });
  return result.data;
}
