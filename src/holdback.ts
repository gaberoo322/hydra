/**
 * Outcome Holdback producer (issue #786, ADR-0004 step 4).
 *
 * This is the *producer* half of the Outcome Holdback mechanism — the thing
 * that was a documented no-op until now. `src/digest.ts` has long consumed
 * `holdback.reverted` / `holdback.cap-reached` / `holdback.revert_failed`
 * events, but nothing produced them since the in-process `src/holdback.ts`
 * watcher was deleted in the ADR-0006 codex cut-over. This module rebuilds the
 * producer in the autopilot-only execution model:
 *
 *   - It is **request-scoped**, invoked by the hydra-qa post-merge path which
 *     is dispatched by the autopilot poll loop after a merge. There is NO
 *     timer, NO sampler, NO long-lived loop here — re-introducing one would
 *     reintroduce the orphaned-recorder failure mode that retired the
 *     stuckness detector (ADR-0010) and violate ADR-0006/0012 (autopilot is
 *     the single brain).
 *   - It is **read-only with respect to merge**: `enroll` runs strictly AFTER
 *     a merge; `check` can only signal that a revert should happen. A merge is
 *     never blocked or delayed by holdback. The actual `git revert` + PR is
 *     performed by the playbook caller (which shells `gh`), not here.
 *   - It watches **leading** Target Outcomes only (terminal outcomes are too
 *     slow for the window) and reverts only when a leading outcome regresses
 *     past its `noise_epsilon` in the unfavorable direction vs the pre-merge
 *     baseline.
 *   - It enforces the ADR-0004 step-4 **per-day revert cap**: once the cap is
 *     hit it emits `holdback.cap-reached` and SUPPRESSES further reverts for
 *     the UTC day rather than reverting.
 *
 * Event payloads are fixed by the existing consumer (`src/digest.ts`):
 * `holdback.reverted` carries `payload.commitSha` (string) and
 * `payload.regressedOutcomes` (string[]); `holdback.cap-reached` and
 * `holdback.revert_failed` are also consumed. Emitting any other event name
 * leaves the consumer orphaned — the exact no-op this issue fixes.
 *
 * Per CLAUDE.md: never throws — returns structured result objects so the
 * caller (the API route, then the playbook) decides how to report. Every
 * catch logs with the `[holdback]` prefix.
 */

import {
  recordBaseline,
  loadBaseline,
  clearBaseline,
  getRevertCount,
  incrRevertCount,
  utcDateKey,
  type HoldbackBaseline,
} from "./redis/holdback.ts";
import { isEnrolledTier, windowCyclesForTier } from "./holdback-policy.ts";
import {
  snapshotLeadingOutcomes,
  decideHoldback,
  type LeadingOutcomeSample,
} from "./outcome-regression.ts";
import { markMergeReverted } from "./redis/attribution.ts";

/** Stream the digest consumer reads from (see src/index.ts startConsumers). */
const NOTIFICATIONS_STREAM = "hydra:notifications";

/** Minimal shape of the event bus this module needs. */
export interface HoldbackEventBus {
  publish(stream: string, event: { type: string; source: string; payload: unknown }): Promise<unknown>;
}

// The pure Outcome Regression Policy (snapshotLeadingOutcomes,
// isOutcomeRegressed, detectRegressions, decideHoldback, cycleDurationMs, and
// the LeadingOutcomeSample / OutcomeRegression / DecideHoldbackInput types)
// lives in the sibling `src/outcome-regression.ts` (issue #2507). This module
// is the Redis-touching *coordinator* half: it imports the policy from that
// sibling and applies the side effects (Redis reads/writes + event-bus
// publish) the pure decision asks for.

// ---------------------------------------------------------------------------
// Enroll — snapshot the pre-merge baseline of the leading outcomes.
// ---------------------------------------------------------------------------

export interface EnrollInput {
  commitSha: string;
  prNumber?: number | null;
  /** Post-#767 monotonic tier of the merged diff (T1–T4). */
  tier?: number | null;
  /**
   * Override the watch window length (cycles). When omitted, the window is
   * derived from `tier` via the tier-aware map (deeper = at least as long;
   * #741). An explicit override always wins (operator/test escape hatch).
   */
  windowCycles?: number;
  /** Test seam — explicit outcomes.yaml path. */
  outcomesFile?: string;
}

export type EnrollResult =
  | { ok: true; enrolled: true; leadingCount: number; baseline: HoldbackBaseline }
  | { ok: true; enrolled: false; reason: string }
  | { ok: false; error: string };

/**
 * Capture the pre-merge baseline for a just-merged commit.
 *
 * Enrollment carries **up** the monotonic tier ladder (#741, ADR-0015): T2, T3,
 * and T4 merges enroll; **T1 (prompt-shaped) is always exempt** and a merge
 * whose tier is unknown does not enroll either (no signal). The watch window is
 * tier-aware — deeper tiers watch at least as long — unless the caller passes
 * an explicit `windowCycles` override. This is the server-side enforcement of
 * the carry-up invariant: it holds regardless of what the playbook caller
 * sends, so a forgotten client-side `if tier in {2,3,4}` guard cannot enroll a
 * T1 merge.
 *
 * Skips enrollment (does NOT persist a baseline) when no leading outcome
 * adapter returned data — recording an all-null baseline would make every
 * future "regression" unknowable, so such a merge sits as "no signal" rather
 * than as a false holdback (matches the historical watcher posture).
 */
export async function enrollHoldback(input: EnrollInput): Promise<EnrollResult> {
  if (!input.commitSha) {
    return { ok: false, error: "enrollHoldback: commitSha is required" };
  }

  // Carry-up predicate (#741): only T2/T3/T4 enroll. T1 and null/unknown are
  // exempt — enforced here so the invariant cannot be bypassed by the caller.
  if (!isEnrolledTier(input.tier)) {
    return {
      ok: true,
      enrolled: false,
      reason:
        input.tier == null
          ? "tier unknown — not enrolled (no signal)"
          : `tier T${input.tier} is exempt from Outcome Holdback (only T2/T3/T4 enroll)`,
    };
  }

  let leading: LeadingOutcomeSample[];
  try {
    leading = await snapshotLeadingOutcomes(input.outcomesFile);
  } catch (err: any) {
    const msg = `[holdback] enroll: snapshotLeadingOutcomes threw: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }

  if (leading.length === 0) {
    return { ok: true, enrolled: false, reason: "no leading outcomes declared" };
  }
  if (leading.every((l) => l.value == null)) {
    return {
      ok: true,
      enrolled: false,
      reason: "no leading-outcome adapter returned data at enroll time",
    };
  }

  const baseline: HoldbackBaseline = {
    commitSha: input.commitSha,
    prNumber: input.prNumber ?? null,
    tier: input.tier ?? null,
    enrolledAt: Date.now(),
    windowCycles: input.windowCycles ?? windowCyclesForTier(input.tier),
    leading: leading.map((l) => ({
      name: l.name,
      direction: l.direction,
      noiseEpsilon: l.noiseEpsilon,
      value: l.value,
    })),
  };

  const rec = await recordBaseline(baseline);
  if (rec.ok === false) return { ok: false, error: rec.error };
  return { ok: true, enrolled: true, leadingCount: leading.length, baseline };
}

// ---------------------------------------------------------------------------
// Check — sample the leading outcomes and decide whether to revert.
// ---------------------------------------------------------------------------

export interface CheckInput {
  commitSha: string;
  /** Test seam — explicit outcomes.yaml path. */
  outcomesFile?: string;
  /** Test seam — override "now" for the per-day cap bucket. */
  now?: Date;
}

type CheckDecision =
  /** No enrollment found (expired/never recorded) — nothing to watch. */
  | { decision: "no-enrollment" }
  /** Window completed clean — baseline cleared, no revert. */
  | { decision: "passed"; commitSha: string }
  /** No regression yet; keep watching. */
  | { decision: "watching"; commitSha: string }
  /** Cap reached — revert SUPPRESSED; `holdback.cap-reached` emitted. */
  | { decision: "cap-reached"; commitSha: string; regressedOutcomes: string[] }
  /** Revert WARRANTED — `holdback.reverted` emitted; caller performs the revert. */
  | { decision: "revert"; commitSha: string; prNumber: number | null; regressedOutcomes: string[] };

export type CheckResult =
  | { ok: true; result: CheckDecision }
  | { ok: false; error: string };

/**
 * Evaluate an enrolled commit's window once.
 *
 * Re-samples the leading outcomes, compares against the persisted baseline, and:
 *   - emits `holdback.reverted` + returns `revert` when a leading outcome
 *     regressed past its epsilon AND the per-day cap is not yet reached;
 *   - emits `holdback.cap-reached` + returns `cap-reached` when a regression is
 *     present but the cap is reached (revert suppressed);
 *   - returns `passed` (and clears the baseline) when the watch window has
 *     elapsed with no regression;
 *   - returns `watching` otherwise.
 *
 * The caller (the playbook, via the API) performs the actual `git revert` only
 * on a `revert` decision; on failure it reports back so the producer emits
 * `holdback.revert_failed` via {@link reportRevertFailed}.
 *
 * This is the **thin orchestrator** half of the producer (issue #2096): it
 * performs the Redis reads (`loadBaseline`, `getRevertCount`), delegates the
 * branching logic to the pure {@link decideHoldback}, then applies the side
 * effects (Redis writes + event-bus publish) keyed on the returned decision.
 * The decision itself is bus-free and Redis-free — see {@link decideHoldback}.
 */
export async function checkHoldback(
  eventBus: HoldbackEventBus,
  input: CheckInput,
): Promise<CheckResult> {
  if (!input.commitSha) {
    return { ok: false, error: "checkHoldback: commitSha is required" };
  }

  const loaded = await loadBaseline(input.commitSha);
  if (loaded.ok === false) return { ok: false, error: loaded.error };
  const baseline = loaded.baseline;
  if (!baseline) return { ok: true, result: { decision: "no-enrollment" } };

  let current: LeadingOutcomeSample[];
  try {
    current = await snapshotLeadingOutcomes(input.outcomesFile);
  } catch (err: any) {
    const msg = `[holdback] check: snapshotLeadingOutcomes threw: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }

  const now = input.now ?? new Date();
  const day = utcDateKey(now);
  const revertCount = await getRevertCount(day);

  // Pure decision — no side effects. The discriminant below drives which
  // notifications + Redis mutations fire.
  const decision = decideHoldback({
    baseline,
    current,
    revertCount,
    nowMs: now.getTime(),
  });

  switch (decision.decision) {
    case "passed":
      // Window elapsed clean — leave probation.
      await clearBaseline(baseline.commitSha);
      break;
    case "cap-reached":
      // Regression present but the per-day cap is reached — revert suppressed.
      await publishSafe(eventBus, "holdback.cap-reached", {
        commitSha: baseline.commitSha,
        prNumber: baseline.prNumber,
        regressedOutcomes: decision.regressedOutcomes,
      });
      break;
    case "revert":
      // Revert warranted. Count this revert against today's cap, clear the
      // baseline (the merge is leaving probation either way), and emit.
      await incrRevertCount(day);
      await clearBaseline(baseline.commitSha);
      // Durably register the revert on the attribution reverted-merge registry
      // so the attribution recorder chore (#2632) voids this PR's ledger rows
      // (AC3). Outcome Holdback is the sole revert authority (design-concept
      // invariant #8: the recorder reverts nothing), so this write MUST
      // originate here — the recorder only DRAINS the registry and appends the
      // compensating void tombstone. Fail-loud + never-throw: markMergeReverted
      // logs `[attribution] …` and returns a structured result on error; we
      // surface a non-fatal `[holdback]` line and continue (the revert itself
      // already happened — a registry miss must not break the revert flow).
      {
        const marked = await markMergeReverted({
          commitSha: baseline.commitSha,
          prNumber: baseline.prNumber,
          revertedAt: Date.now(),
        });
        if (marked.ok === false) {
          console.error(
            `[holdback] check: failed to register reverted merge for attribution void ` +
              `(commitSha=${baseline.commitSha} prNumber=${baseline.prNumber ?? "null"}): ${marked.error}`,
          );
        }
      }
      await publishSafe(eventBus, "holdback.reverted", {
        commitSha: baseline.commitSha,
        prNumber: baseline.prNumber,
        regressedOutcomes: decision.regressedOutcomes,
      });
      break;
    case "watching":
      // No regression yet, window still open — no side effects.
      break;
  }

  return { ok: true, result: decision };
}

/**
 * Emit `holdback.revert_failed` when the caller's `git revert` / PR-open failed
 * after a `revert` decision. The watcher will retry next cycle — but the
 * baseline was already cleared on the `revert` decision, so the caller should
 * re-enroll if it wants the next poll to retry. We surface the failure to the
 * digest regardless so the operator sees that a warranted revert did not land.
 */
export async function reportRevertFailed(
  eventBus: HoldbackEventBus,
  commitSha: string,
  reason?: string,
): Promise<void> {
  await publishSafe(eventBus, "holdback.revert_failed", { commitSha, reason: reason ?? null });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Publish best-effort — a bus error must never break the producer flow. */
async function publishSafe(
  eventBus: HoldbackEventBus,
  type: string,
  payload: unknown,
): Promise<void> {
  try {
    await eventBus.publish(NOTIFICATIONS_STREAM, { type, source: "holdback-producer", payload });
  } catch (err: any) {
    console.error(`[holdback] publish ${type} failed: ${err?.message || String(err)}`);
  }
}
