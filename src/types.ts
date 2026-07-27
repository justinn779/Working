export type Category = "person" | "matter" | "place" | "object";

export const CATEGORY_ORDER: Category[] = ["person", "matter", "place", "object"];

export const CATEGORY_LABEL: Record<Category, string> = {
  person: "人",
  matter: "事",
  place: "地",
  object: "物",
};

export interface GameOption {
  id: string;
  category: Category;
  label: string;
  /** true if this option is not available until unlocked by an event */
  locked: boolean;
}

export interface UnlockRef {
  category: Category;
  optionId: string;
}

export interface GameEvent {
  /** deterministic key derived from the chosen combo, doubles as an id */
  comboKey: string;
  title: string;
  description: string;
  /** duration (in 10-minute units) used the first time this event was generated */
  durationUnits: number;
  unlocks: UnlockRef[];
  createdAt: number;
}

export interface Selection {
  person: string | null;
  matter: string | null;
  place: string | null;
  object: string | null;
}
