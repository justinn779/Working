// Central tunable knobs so game pacing can be adjusted without hunting through logic files.

/** One stamina unit represents this many minutes of in-game time. */
export const UNIT_MINUTES = 10;

/** Cumulative in-game time cap: 24 hours worth of 10-minute units. */
export const MAX_STAMINA_UNITS = (24 * 60) / UNIT_MINUTES; // 144

/** Real-world minutes that must pass to regenerate a single stamina unit. */
export const REGEN_MINUTES_PER_UNIT = 3;

/** Largest number of units a player may commit to a single event. */
export const MAX_UNITS_PER_ACTION = 12; // 2 in-game hours

export const STORAGE_KEY = "workplace-game-state-v1";
