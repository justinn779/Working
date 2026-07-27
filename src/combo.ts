import { SEED_OPTIONS } from "./data/options";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "./types";
import type { Category, GameOption, Selection } from "./types";

const OPTIONS_BY_ID: Record<string, GameOption> = Object.fromEntries(
  SEED_OPTIONS.map((o) => [o.id, o])
);

export function getOptionById(id: string): GameOption | undefined {
  return OPTIONS_BY_ID[id];
}

/** Deterministic cache key for a combo — category order is fixed so equal
 * selections always produce the same key regardless of pick order. */
export function buildComboKey(selection: Selection): string {
  return CATEGORY_ORDER.map((cat) => `${cat}:${selection[cat] ?? "none"}`).join("|");
}

export function isEmptySelection(selection: Selection): boolean {
  return CATEGORY_ORDER.every((cat) => selection[cat] === null);
}

export function hasAnySelection(selection: Selection): boolean {
  return !isEmptySelection(selection);
}

/** Reverses buildComboKey back into human-readable labels per category, for
 * displaying past events. Segments for categories that no longer exist (e.g.
 * an old cached "time:xxx" segment from before that category was removed)
 * are silently ignored rather than crashing. */
export function decodeComboKey(comboKey: string): Partial<Record<Category, string>> {
  const result: Partial<Record<Category, string>> = {};
  for (const part of comboKey.split("|")) {
    const [cat, id] = part.split(":");
    if (!id || id === "none") continue;
    if (!(cat in CATEGORY_LABEL)) continue;
    const label = getOptionById(id)?.label;
    if (label) result[cat as Category] = label;
  }
  return result;
}
