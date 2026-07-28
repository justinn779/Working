// Central tunable knobs so game pacing can be adjusted without hunting through logic files.

/** One stamina unit represents this many minutes of in-game time. */
export const UNIT_MINUTES = 10;

/** Cumulative in-game time cap: 8 hours worth of 10-minute units. */
export const MAX_STAMINA_UNITS = (8 * 60) / UNIT_MINUTES; // 48

/** Real-world minutes that must pass to regenerate a single stamina unit. */
export const REGEN_MINUTES_PER_UNIT = 3;

export const STORAGE_KEY = "workplace-game-state-v1";
