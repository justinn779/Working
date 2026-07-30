import { buildComboKey } from "./combo";
import { generateEventRemote } from "./remoteEvent";
import { recordEvent, spendStamina, unlockOption, type GameState } from "./state";
import type { GameEvent, Localized, Selection } from "./types";

export interface ResolveResult {
  event: GameEvent;
  isNewDiscovery: boolean;
  /** True only if event.featuredOption existed and wasn't already unlocked
   * for this specific player — gates the "🎉 newly unlocked" toast. The
   * featured tag itself is still shown either way. */
  isFeaturedOptionNewToMe: boolean;
  /** Where this event's content came from this time around — 'cached' means
   * it was already known locally and no generation happened at all. */
  source: "cached" | "remote";
  /** Set to the new title only when this event actually moved
   * state.jobTitle forward (promotion or a switch to a different job) —
   * null otherwise. Gates the "🎉 職稱異動" toast the same way
   * isFeaturedOptionNewToMe gates the material-unlock one. */
  jobTitleChanged: Localized | null;
}

/** Discriminated outcome instead of the old `ResolveResult | null` — there
 * are now two distinct ways this can fail (not enough stamina vs. the AI
 * genuinely never responded even after retrying), and the caller needs to
 * tell them apart to show the right message. */
export type ResolveOutcome =
  | { ok: true; result: ResolveResult }
  | { ok: false; reason: "insufficient-stamina" | "generation-failed" };

/** Milliseconds to wait between retries — short, then longer, so a genuine
 * one-off blip resolves fast without hammering the function relentlessly. */
const RETRY_DELAYS_MS = [800, 1500, 3000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** There is deliberately no local fallback generator — a story with no AI
 * behind it can't guarantee the "the new material must actually appear in
 * the text" invariant the rest of the game relies on (see
 * functions/src/index.ts's tryGenerate), so a failed generation must
 * actually fail and let the player retry, rather than silently substituting
 * a lesser experience that skips that guarantee. Tries once, then up to
 * RETRY_DELAYS_MS.length more times with backoff before giving up. */
async function generateWithRetry(
  selection: Selection,
  durationUnits: number,
  state: GameState
): Promise<GameEvent | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateEventRemote(
        selection,
        durationUnits,
        state.playerName,
        state.knownMaterials,
        state.jobTitle
      );
    } catch (err) {
      console.warn(`雲端事件生成失敗(第 ${attempt + 1} 次嘗試)`, err);
      if (attempt >= RETRY_DELAYS_MS.length) return null;
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function resolveAction(
  state: GameState,
  selection: Selection,
  durationUnits: number
): Promise<ResolveOutcome> {
  if (!spendStamina(state, durationUnits)) return { ok: false, reason: "insufficient-stamina" };

  const comboKey = buildComboKey(selection, durationUnits, state.jobTitle.zh);
  const cached = state.eventsByCombo[comboKey];
  let event = cached;
  let source: ResolveResult["source"] = "cached";

  if (!event) {
    const generated = await generateWithRetry(selection, durationUnits, state);
    if (!generated) {
      // Nothing was produced — refund the stamina we speculatively spent
      // rather than charging the player for a failed attempt.
      state.staminaUnits += durationUnits;
      return { ok: false, reason: "generation-failed" };
    }
    event = generated;
    source = "remote";
  }

  const { isNewDiscovery } = recordEvent(state, event);

  const isFeaturedOptionNewToMe = event.featuredOption
    ? unlockOption(state, event.featuredOption.optionId)
    : false;

  // Same decision every time this exact comboKey resolves (it's baked into
  // the cached event) — harmless to re-apply on a repeat visit, since once
  // jobTitle actually moves, the old comboKey (built from the old title)
  // can never be reached again through normal play.
  let jobTitleChanged: Localized | null = null;
  if (event.newJobTitle && event.newJobTitle.zh !== state.jobTitle.zh) {
    state.jobTitle = event.newJobTitle;
    jobTitleChanged = event.newJobTitle;
  }

  return { ok: true, result: { event, isNewDiscovery, isFeaturedOptionNewToMe, source, jobTitleChanged } };
}
