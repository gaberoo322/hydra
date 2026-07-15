/**
 * Pattern-cue demotion chore (issue #3340) — the inverse of the escalation path.
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`). Where the
 * escalation path (`src/pattern-memory/escalation.ts`, issue #512) PROMOTES a
 * chronic friction cue to a `meta-friction` GitHub issue when its hit count
 * crosses `PROMOTION_THRESHOLD`, this chore DEMOTES the cue once that issue is
 * CLOSED: it polls recently-closed meta-friction issues, reverse-maps each to
 * its cue, and reduces the matched friction pattern's hit count so it must
 * re-accumulate before it can re-escalate. That closes the learning feedback
 * loop — "escalate on problem → demote on fix" — so a solved-and-closed issue is
 * not immediately re-filed by the next hit.
 *
 * No Redis time-guard — the chore is intrinsically idempotent (a per-issue Redis
 * marker records which closed issues have already driven a demotion), so an
 * hourly tick against an all-processed set is a guaranteed no-op. It is
 * sequenced AFTER the escalation-driving chores in `runHousekeeping` so a close
 * observed this hour demotes AFTER any same-hour escalation write.
 *
 * Never throws — the underlying `runCueDemotion` is best-effort and returns a
 * result object; this chore additionally swallows any fault, logs it, and folds
 * it to a logged 0. `runChore` wraps it for uniform ran/skipped bookkeeping.
 */

import { runCueDemotion } from "../../pattern-memory/demotion.ts";
import { setLastDemotionCount } from "../../redis/agent-memory.ts";

/**
 * Injectable touchpoints so the chore's wiring is testable without `gh`/Redis.
 * Both default to the real implementation.
 */
export interface PatternCueDemotionDeps {
  runCueDemotion?: typeof runCueDemotion;
  setLastDemotionCount?: typeof setLastDemotionCount;
}

/**
 * Run one cue-demotion pass and persist the run's demotion count for the
 * friction-patterns diagnostic. Best-effort: never throws.
 */
export async function runPatternCueDemotion(
  deps: PatternCueDemotionDeps = {},
): Promise<void> {
  const runDemotion = deps.runCueDemotion ?? runCueDemotion;
  const persistCount = deps.setLastDemotionCount ?? setLastDemotionCount;
  try {
    const result = await runDemotion();
    // Persist the count for observability (surfaced on /learning/friction-patterns).
    // Best-effort: a Redis blip on the stamp must not mask a successful demotion.
    try {
      await persistCount(result.demotions.length);
    } catch (err: any) {
      console.error(
        `[Housekeeping] pattern-cue-demotion count-persist failed: ${err?.message || err}`,
      );
    }
    if (result.demotions.length > 0) {
      console.log(
        `[Housekeeping] pattern-cue-demotion: demoted ${result.demotions.length} cue(s) ` +
          `from ${result.scanned} closed meta-friction issue(s)`,
      );
    }
    if (result.errors.length > 0) {
      console.error(
        `[Housekeeping] pattern-cue-demotion: ${result.errors.length} per-issue error(s): ${result.errors.join("; ")}`,
      );
    }
  } catch (err: any) {
    // Defence-in-depth — runCueDemotion is written to resolve, not raise.
    console.error(`[Housekeeping] pattern-cue-demotion failed: ${err?.message || err}`);
  }
}
