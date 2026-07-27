import { MAX_STAMINA_UNITS, REGEN_MINUTES_PER_UNIT, STORAGE_KEY } from "./config";
import { SEED_OPTIONS } from "./data/options";
import type { GameEvent } from "./types";

export interface LogEntry {
  comboKey: string;
  timestamp: number;
  durationUnits: number;
}

export interface GameState {
  staminaUnits: number;
  staminaLastSettled: number; // epoch ms — last time we converted elapsed real time into units
  unlockedOptionIds: string[];
  collectedComboKeys: string[]; // discovery order, unique
  eventsByCombo: Record<string, GameEvent>;
  log: LogEntry[];
}

function freshState(): GameState {
  return {
    staminaUnits: MAX_STAMINA_UNITS,
    staminaLastSettled: Date.now(),
    unlockedOptionIds: SEED_OPTIONS.filter((o) => !o.locked).map((o) => o.id),
    collectedComboKeys: [],
    eventsByCombo: {},
    log: [],
  };
}

export function loadState(): GameState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return freshState();
  try {
    const parsed = JSON.parse(raw) as GameState;
    if (
      typeof parsed.staminaUnits !== "number" ||
      typeof parsed.staminaLastSettled !== "number" ||
      !Array.isArray(parsed.unlockedOptionIds) ||
      !Array.isArray(parsed.collectedComboKeys) ||
      typeof parsed.eventsByCombo !== "object" ||
      !Array.isArray(parsed.log)
    ) {
      return freshState();
    }
    return parsed;
  } catch {
    return freshState();
  }
}

export function saveState(state: GameState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Converts elapsed real-world time into regenerated stamina units, in place. */
export function settleStamina(state: GameState): GameState {
  if (state.staminaUnits >= MAX_STAMINA_UNITS) {
    state.staminaLastSettled = Date.now();
    return state;
  }
  const elapsedMs = Date.now() - state.staminaLastSettled;
  const elapsedMinutes = elapsedMs / 60_000;
  const regeneratedUnits = Math.floor(elapsedMinutes / REGEN_MINUTES_PER_UNIT);
  if (regeneratedUnits <= 0) return state;

  const newUnits = Math.min(MAX_STAMINA_UNITS, state.staminaUnits + regeneratedUnits);
  const unitsActuallyApplied = newUnits - state.staminaUnits;
  state.staminaUnits = newUnits;
  // Only advance the settlement clock by the time we actually consumed, so leftover
  // fractional minutes aren't lost (important once stamina is near the cap).
  state.staminaLastSettled += unitsActuallyApplied * REGEN_MINUTES_PER_UNIT * 60_000;
  return state;
}

export function minutesUntilNextUnit(state: GameState): number {
  if (state.staminaUnits >= MAX_STAMINA_UNITS) return 0;
  const elapsedMs = Date.now() - state.staminaLastSettled;
  const elapsedMinutes = elapsedMs / 60_000;
  const remaining = REGEN_MINUTES_PER_UNIT - (elapsedMinutes % REGEN_MINUTES_PER_UNIT);
  return Math.max(0, remaining);
}

export function spendStamina(state: GameState, units: number): boolean {
  if (units <= 0 || units > state.staminaUnits) return false;
  state.staminaUnits -= units;
  return true;
}

export function isUnlocked(state: GameState, optionId: string): boolean {
  return state.unlockedOptionIds.includes(optionId);
}

export function unlockOption(state: GameState, optionId: string): boolean {
  if (isUnlocked(state, optionId)) return false;
  state.unlockedOptionIds.push(optionId);
  return true;
}

export function recordEvent(
  state: GameState,
  event: GameEvent,
  durationUnits: number
): { isNewDiscovery: boolean } {
  const isNewDiscovery = !(event.comboKey in state.eventsByCombo);
  state.eventsByCombo[event.comboKey] = event;
  if (isNewDiscovery) state.collectedComboKeys.push(event.comboKey);
  state.log.push({ comboKey: event.comboKey, timestamp: Date.now(), durationUnits });
  return { isNewDiscovery };
}
