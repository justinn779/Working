import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

interface ClaimFirstJobTitleAchievementResult {
  /** False on a repeat call — already claimed, nothing changed this time.
   * See functions/src/achievementHandlers.ts for why this callable is safe
   * to invoke every time a job title change is detected, not just the
   * first. */
  granted: boolean;
  potions: Record<string, number>;
}

const claimFirstJobTitleAchievementCallable = httpsCallable<Record<string, never>, ClaimFirstJobTitleAchievementResult>(
  functions,
  "claimFirstJobTitleAchievement"
);

export async function claimFirstJobTitleAchievement(): Promise<ClaimFirstJobTitleAchievementResult> {
  const result = await claimFirstJobTitleAchievementCallable({});
  return result.data;
}
