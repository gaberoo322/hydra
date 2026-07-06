/**
 * Outcome-attribution window recorder (issue #2629, epic #2628).
 *
 * This is the policy-carrying module of the attribution spine. Given a CLOSED
 * per-metric watch window — a **baseline** snapshot of the leading outcomes
 * (captured at window open, exactly what `enrollHoldback` captures) and a
 * **current** snapshot (re-sampled at window close, exactly what `checkHoldback`
 * re-samples) — it derives ONE raw observation per LIVE metric and appends it to
 * the append-only ledger (`src/redis/attribution-ledger.ts`).
 *
 * The two snapshots come from `snapshotLeadingOutcomes`
 * (`src/outcome-regression.ts`), reused **read-only** — its signature and
 * behavior are NOT modified here. This slice deliberately does NOT subscribe to
 * the live event stream or schedule windows (that is the final slice #2632); the
 * recorder is a directly-callable function, unit-tested against a fake ledger.
 *
 * Attribution policy (the invariants the whole spine depends on):
 *   - `delta = current.value - baseline.value`, matched by metric `name`.
 *   - A **dark** metric (value null in EITHER snapshot) produces NO row — never
 *     a synthetic zero (mirrors `isOutcomeRegressed`'s null-skip; the whole
 *     outcome stack treats null as no-data, never 0).
 *   - An **empty** (zero-merge) window IS recorded — one null-model row per live
 *     metric with `classCounts = {}` — because zero-merge windows are the
 *     exogenous-drift baseline the #2630 estimator requires. Empty ≠ dark: an
 *     empty window still has metric DATA (both snapshots non-null), just no
 *     producer activity.
 *   - Rows are RAW: no write-time credit split (the parent epic rejects biased
 *     write-time splits; credit is assigned later by ridge regression).
 *
 * Per CLAUDE.md conventions: never throws — a ledger append error is surfaced in
 * the returned result, not raised.
 */

import type { LeadingOutcomeSample } from "../outcome-regression.ts";
import type {
  AttributionLedger,
  AttributionObservation,
} from "../redis/attribution-ledger.ts";

/**
 * Metadata describing the closed window's producer activity. Supplied by the
 * caller (in this slice, tests / a future scheduler in #2632). An empty window
 * has `classCounts = {}` and typically `tier = null`.
 */
export interface WindowContext {
  /** Producer-class → merge count over the window. `{}` = empty window. */
  classCounts: Record<string, number>;
  /** Scope tag of the window's activity (e.g. "orch" | "target"). */
  scopeTouched: string;
  /** Representative tier of the window's merges, or null (e.g. empty window). */
  tier: number | null;
}

/**
 * Derive the raw observation rows for one closed window — PURE, no I/O.
 *
 * One row per LIVE metric (present with a non-null value in BOTH snapshots).
 * Dark metrics (null on either side) are skipped. The `classCounts` /
 * `scopeTouched` / `tier` are copied from `ctx`, so an empty-window `ctx`
 * (`classCounts = {}`) yields the null-model rows verbatim.
 *
 * `nowMs` is injectable so tests can assert `recordedAt` deterministically.
 */
export function deriveObservations(
  baseline: LeadingOutcomeSample[],
  current: Array<{ name: string; value: number | null }>,
  ctx: WindowContext,
  nowMs: number = Date.now(),
): AttributionObservation[] {
  const currentByName = new Map(current.map((c) => [c.name, c.value]));
  const rows: AttributionObservation[] = [];
  for (const b of baseline) {
    const cur = currentByName.has(b.name) ? currentByName.get(b.name)! : null;
    // Dark metric: null on either side → no row (never a synthetic zero).
    if (b.value == null || cur == null) continue;
    if (!Number.isFinite(b.value) || !Number.isFinite(cur)) continue;
    rows.push({
      metric: b.name,
      delta: cur - b.value,
      classCounts: { ...ctx.classCounts },
      scopeTouched: ctx.scopeTouched,
      tier: ctx.tier,
      recordedAt: nowMs,
    });
  }
  return rows;
}

/** Outcome of recording one window's observations. */
export interface RecordWindowResult {
  /** Observation rows appended to the ledger (dark metrics excluded). */
  appended: AttributionObservation[];
  /** Metrics skipped as dark (null on either side). */
  darkMetrics: string[];
  /** Append errors, if any (best-effort — recording never throws). */
  errors: string[];
}

/**
 * Record one closed window: derive the rows and append each through the
 * injected append-only `ledger`. Returns a structured result — never throws.
 *
 * The `ledger` is injected so the policy is unit-testable against a fake seam;
 * production passes `redisAttributionLedger` from `src/redis/attribution-ledger.ts`.
 */
export async function recordWindow(
  ledger: AttributionLedger,
  baseline: LeadingOutcomeSample[],
  current: Array<{ name: string; value: number | null }>,
  ctx: WindowContext,
  nowMs: number = Date.now(),
): Promise<RecordWindowResult> {
  const currentByName = new Map(current.map((c) => [c.name, c.value]));
  const darkMetrics: string[] = [];
  for (const b of baseline) {
    const cur = currentByName.has(b.name) ? currentByName.get(b.name)! : null;
    if (b.value == null || cur == null || !Number.isFinite(b.value) || !Number.isFinite(cur)) {
      darkMetrics.push(b.name);
    }
  }

  const rows = deriveObservations(baseline, current, ctx, nowMs);
  const appended: AttributionObservation[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const res = await ledger.appendObservation(row);
    if (res.ok === true) {
      appended.push(row);
    } else {
      errors.push(res.error);
    }
  }

  return { appended, darkMetrics, errors };
}
