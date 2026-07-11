/**
 * Usage-eligibility aggregator leaf (issue #3182, arch-scan #788).
 *
 * The pure multi-source composition behind `GET /api/usage/eligibility`: the
 * autopilot dispatch verdict `decide.py` gates every dispatch on. It joins the
 * pure snapshot projection (`projectEligibility`) with three durable-Redis
 * overlay inputs — the operator pause flag (#988), the session-limit hard block
 * (#1089), and the workless-board backoff hint (#2956) — and folds them onto the
 * verdict through the four-level `overlay*` chain owned by `cost/eligibility.ts`.
 *
 * Extracted from the `GET /usage/eligibility` route handler (`src/api/usage.ts`).
 * This is the PURE composition layer, mirroring `aggregators/autopilot-idle.ts`:
 * every external touchpoint — the three Redis reads and the clock — arrives via
 * the resolved `EligibilityViewDeps` bag. The route layer owns the IO-defaulting
 * (readers default to the live Redis accessors, clock defaults to `Date.now`)
 * and hands this fully-resolved bag in.
 *
 * Fail-SAFE contract (matches the route's original semantics EXACTLY): each of
 * the three overlay-input reads is independently guarded. A rejected read logs a
 * fail-loud `console.error` and degrades ITS slice to the safe default that
 * cannot wedge the loop off:
 *   - pause read fails      → treat as NOT paused (never blocks)
 *   - session-block read fails → treat as NO block  (`null`)
 *   - workless read fails   → treat as NOT workless (`null`)
 * The composition itself never throws — the `getUsage` snapshot read is the only
 * un-guarded await, and it is intentionally left to the route's outer try/catch
 * (a snapshot failure is a genuine 500, not a fail-safe degrade), exactly as the
 * original handler had it: the snapshot read sat OUTSIDE the three inner guards.
 *
 * Each read failure degrades independently, so the fallback branches — invisible
 * end-to-end in the pre-extraction route — are now first-class unit-test cases
 * against the injected deps (e.g. "workless read throws → worklessUntil null").
 */

import {
  projectEligibility,
  overlayPauseEligibility,
  overlaySessionBlockEligibility,
  overlayWorklessEligibility,
  type UsageEligibility,
  type UsageSnapshot,
} from "../cost/index.ts";

// ---------------------------------------------------------------------------
// Resolved deps bag (the pure boundary)
// ---------------------------------------------------------------------------

/**
 * The RESOLVED (non-optional) deps bag the aggregator composes over. The route
 * layer owns the IO-defaulting (readers already defaulted to the live Redis
 * accessors, clock already a function) and hands this fully-resolved bag in —
 * keeping default-resolution in the route and pure composition in the leaf.
 */
export interface EligibilityViewDeps {
  /** The already-read usage snapshot to project. The route reads this via
   * `getUsage({ force })` OUTSIDE the fail-safe guards — a snapshot failure is a
   * genuine 500, not a degradable slice — so it arrives pre-read here. */
  snapshot: UsageSnapshot;
  /** Reader for the operator-only Autopilot pause flag (#988). A REJECTED
   * promise degrades to NOT paused (fails safe to running). */
  readPaused: () => Promise<boolean>;
  /** Reader for the session-limit hard-block instant (#1089), epoch-ms or null.
   * A REJECTED promise degrades to `null` (no block). */
  readSessionBlockedUntil: () => Promise<number | null>;
  /** Reader for the workless-board backoff hint instant (#2956), epoch-ms or
   * null. A REJECTED promise degrades to `null` (not workless). */
  readWorklessUntil: () => Promise<number | null>;
  /** Clock — epoch-ms `now`, injected so the future-vs-past overlay comparisons
   * stay deterministic/testable. */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Fail-safe read helper
// ---------------------------------------------------------------------------

/**
 * Run one overlay-input read under its fail-safe guard: on rejection, log a
 * fail-loud `console.error` (so the bad read is visible) and return the safe
 * `fallback` that cannot wedge the loop off. Mirrors the three inline
 * `try/catch` blocks the route handler carried before this extraction.
 */
async function readFailSafe<T>(
  read: () => Promise<T>,
  fallback: T,
  failMessage: string,
): Promise<T> {
  try {
    return await read();
  } catch (err: any) {
    console.error(`${failMessage}: ${err?.message || err}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Pure composition
// ---------------------------------------------------------------------------

/**
 * Compose the eligibility verdict from the projected snapshot and the three
 * fail-safe overlay-input reads, then fold them through the four-level overlay
 * chain (`projectEligibility → overlayPause → overlaySessionBlock →
 * overlayWorkless`). Every external touchpoint arrives via `deps`; the three
 * overlay-input reads are each guarded and degrade to their safe default on
 * rejection, so the composition never throws.
 *
 * The overlay chain is the SAME order the route ran (verbatim): pause and
 * session-block flip `allow=false` (hard-stop drain path); the workless hint is
 * advisory-only and never flips `allow`.
 */
export async function getEligibilityView(
  deps: EligibilityViewDeps,
): Promise<UsageEligibility> {
  const {
    snapshot,
    readPaused,
    readSessionBlockedUntil,
    readWorklessUntil,
    now,
  } = deps;

  const paused = await readFailSafe(
    readPaused,
    false,
    "[usage] /api/usage/eligibility pause read failed (treating as not paused)",
  );
  const sessionBlockedUntilMs = await readFailSafe<number | null>(
    readSessionBlockedUntil,
    null,
    "[usage] /api/usage/eligibility session-block read failed (treating as no block)",
  );
  const worklessUntilMs = await readFailSafe<number | null>(
    readWorklessUntil,
    null,
    "[usage] /api/usage/eligibility workless-hint read failed (treating as not workless)",
  );

  const nowMs = now();
  return overlayWorklessEligibility(
    overlaySessionBlockEligibility(
      overlayPauseEligibility(projectEligibility(snapshot), paused),
      sessionBlockedUntilMs,
      nowMs,
    ),
    worklessUntilMs,
    nowMs,
  );
}
