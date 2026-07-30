import { httpsCallable } from "firebase/functions";
import { getOptionById, type KnownMaterials } from "./combo";
import { functions } from "./firebase";
import { CATEGORY_ORDER } from "./types";
import type { Category, GameEvent, Localized, Selection } from "./types";

interface ResolveEventRequest {
  selection: Selection;
  labels: Partial<Record<Category, Localized | null>>;
  durationUnits: number;
  playerName: string;
  jobTitle: Localized;
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
  durationUnits: number,
  playerName: string,
  knownMaterials: KnownMaterials,
  jobTitle: Localized
): Promise<GameEvent> {
  const labels = Object.fromEntries(
    CATEGORY_ORDER.map((cat) => [
      cat,
      selection[cat] ? getOptionById(selection[cat] as string, knownMaterials)?.label ?? null : null,
    ])
  ) as Partial<Record<Category, Localized | null>>;

  const result = await resolveEventCallable({ selection, labels, durationUnits, playerName, jobTitle });
  return result.data;
}
