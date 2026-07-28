export type Category = "person" | "matter" | "place" | "object";

export const CATEGORY_ORDER: Category[] = ["person", "matter", "place", "object"];

/** A piece of text that exists in both supported UI languages — every label,
 * title, and description in the game carries both at once so switching
 * languages never requires re-generating or re-looking-up content. */
export interface Localized {
  zh: string;
  en: string;
}

export const CATEGORY_LABEL: Record<Category, Localized> = {
  person: { zh: "人", en: "Person" },
  matter: { zh: "事", en: "Matter" },
  place: { zh: "地", en: "Place" },
  object: { zh: "物", en: "Object" },
};

export interface GameOption {
  id: string;
  category: Category;
  label: Localized;
}

export interface UnlockRef {
  category: Category;
  optionId: string;
  /** The AI invents both language versions together in one generation — see
   * functions/src/index.ts — so this pair is always internally consistent,
   * not independently re-invented per language. */
  label: Localized;
}

export interface GameEvent {
  /** deterministic key derived from the chosen combo, doubles as an id */
  comboKey: string;
  title: Localized;
  description: Localized;
  /** duration (in 10-minute units) used the first time this event was generated */
  durationUnits: number;
  /** The one 人/事/地/物 this event's story features — null only in the rare
   * case nothing could be validated (see functions/src/index.ts). This is
   * the collectible: every event tags one, not just a lucky few. */
  featuredOption: UnlockRef | null;
  /** Display name of whoever first triggered this combo, globally. */
  discovererName: string;
  /** When this combo was first ever generated, globally (not per-player). */
  discoveredAt: number;
}

export interface Selection {
  person: string | null;
  matter: string | null;
  place: string | null;
  object: string | null;
}
