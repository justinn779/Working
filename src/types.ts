export type Category = "person" | "matter" | "place" | "object";

export const CATEGORY_ORDER: Category[] = ["person", "matter", "place", "object"];

/** A piece of text that exists in both supported UI languages — every label,
 * title, and description in the game carries both at once so switching
 * languages never requires re-generating or re-looking-up content. */
export interface Localized {
  zh: string;
  en: string;
}

/** Story text (title/description) never contains a real name — the AI writes
 * this literal token wherever the protagonist would be named (see
 * functions/src/index.ts's buildPrompt), and the frontend substitutes the
 * *viewing* player's own name at display time (see main.ts's personalize()).
 * A shared event replayed by a different player therefore always reads as
 * "you", never as whoever originally discovered it — that's what
 * `discovererName` is for instead. Must match the backend's copy exactly. */
export const PLAYER_TOKEN = "{{player}}";

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
  /** The acting player's 職稱 (job title) *before* this event — baked into
   * the comboKey (see combo.ts's buildComboKey), so the same materials
   * produce a different cached story for a different job title. Stored
   * directly on the event (like durationUnits) so it can be displayed
   * without re-decoding the key. */
  jobTitle: Localized;
  /** GPT's decision on whether this event should change the acting player's
   * job title going forward (promotion within the same job, or a switch to
   * a different one entirely) — null means no change. Since this is baked
   * into the cached event, it applies identically to every player who ever
   * resolves this exact combo from this exact starting job title — that's
   * consistent with how the rest of the shared-discovery model already
   * works, not a special case. */
  newJobTitle: Localized | null;
}

export interface Selection {
  person: string | null;
  matter: string | null;
  place: string | null;
  object: string | null;
}

/** Admin-authored modal shown on load (see admin.html). `id` is regenerated
 * every time an admin saves the announcement (even for a small edit) — this
 * is a deliberate simplification over versioning "is this really new
 * content": re-showing it once after any edit is a safe default, and it
 * keeps the dismissal-tracking logic on the player side trivial (just
 * compare ids). Lives in Firestore's `announcements/current` doc, publicly
 * readable, only admin-writable (see firestore.rules). */
export interface Announcement {
  id: string;
  title: Localized;
  body: Localized;
  enabled: boolean;
  /** false = shows on every single load with no way to permanently
   * dismiss it (just a close button); true = the modal also offers a
   * "don't show again" checkbox that persists past this id. */
  dismissible: boolean;
  updatedAt: number;
}

/** A limited-time (or standing) event the admin publicises on the 活動 tab.
 * Deliberately all free-text, not a structured/tracked goal system — what
 * counts as "the goal" or "the reward" varies completely from one campaign
 * to the next (a material-collection challenge, a real-world giveaway, a
 * seasonal theme...), so this is a content/CMS record, not something the
 * game verifies or auto-grants. Any actual reward fulfillment happens
 * out-of-band (e.g. admin manually adjusts a winner's balance) — this just
 * publishes what the campaign is and what winning it looks like. Lives in
 * Firestore's `campaigns` collection, publicly readable, only
 * admin-writable (see firestore.rules), same trust model as Announcement. */
export interface Campaign {
  id: string;
  title: Localized;
  /** 活動內容 — what the campaign actually is. */
  content: Localized;
  /** 活動目標 — what a player needs to do, described in plain language. */
  goal: Localized;
  /** 活動說明 — rules/details/fine print. */
  rules: Localized;
  /** 活動獎勵 — what winning gets you. */
  reward: Localized;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
