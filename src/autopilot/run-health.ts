/**
 * Autopilot run-health heuristics — coordinator (issue #1378 — extracted from
 * `aggregators/autopilot-health.ts`; issue #2866 — the four per-heuristic
 * evaluators split into focused leaves under `health-signals/`).
 *
 * This module is the **stable public entry surface** of the autopilot-health
 * analysis core. It composes four focused per-heuristic leaves plus a shared
 * `common` leaf and re-exports their public symbols at this path, so the five
 * historical importers — `aggregators/autopilot-health.ts`,
 * `autopilot/retro-bundle.ts`, `autopilot/status.ts`, `schemas/now-page.ts`,
 * and the `test/*.mts` files — need ZERO import-path edits.
 *
 * The pure analysis core lives under `health-signals/`:
 *   - `common.ts`            — shared `StuckSignal` domain types, the threshold
 *                              bag + defaults, the reader-facing run shapes, the
 *                              coercion helpers, `rankSignals`, and
 *                              `oldestRunStartEpochS`.
 *   - `stalled-dispatch.ts`  — `detectStalledDispatch` (evolves with OS-heartbeat
 *                              policy).
 *   - `unproductive-loop.ts` — `detectUnproductiveLoops` (evolves with the
 *                              real-merge cross-check policy).
 *   - `idle-streak.ts`       — `detectIdleStreak` (evolves with run-termination
 *                              accounting).
 *   - `issue-pr-churn.ts`    — `detectIssuePrChurn` (evolves with
 *                              dispatch-identity tracking).
 *
 * The aggregator (`aggregators/autopilot-health.ts`) is the thin caller: it
 * fans out the two run reads (`getCurrentRun`, `listRuns`) plus the two
 * cross-checks (window-merge count, OS-heartbeat age) and delegates heuristic
 * evaluation here. `autopilot/retro-bundle.ts` consumes the aggregator's
 * public entrypoint, but may import these pure heuristics directly.
 *
 * # Design contract
 *
 * - **Pure heuristic core.** Each heuristic is a pure function over already-
 *   read data, exported so tests pin the boundary without stubbing Redis.
 * - **Never throws.** These functions only read their arguments and coerce
 *   defensively; they cannot throw on malformed input.
 * - **Ranked output.** `rankSignals` sorts by severity (critical → warn →
 *   info), then by type for a deterministic order.
 *
 * The `StuckSignal` domain type stays physically defined in
 * `health-signals/common.ts` and is re-exported here, preserving the
 * `schemas/now-page.ts` domain → schema import direction (issue #2838): the
 * wire schema imports FROM this analysis-core surface, never the reverse.
 */

// Shared core: domain types, thresholds, reader shapes, ranking + epoch helpers.
export {
  type StuckSignalType,
  type StuckSignalSeverity,
  type StuckSignal,
  type AutopilotHealthThresholds,
  type RunDigest,
  type LiveRunView,
  DEFAULT_HEALTH_THRESHOLDS,
  rankSignals,
  oldestRunStartEpochS,
} from "./health-signals/common.ts";

// The four per-heuristic evaluators, each in its own focused leaf.
export { detectStalledDispatch } from "./health-signals/stalled-dispatch.ts";
export { detectUnproductiveLoops } from "./health-signals/unproductive-loop.ts";
export { detectIdleStreak } from "./health-signals/idle-streak.ts";
export { detectIssuePrChurn } from "./health-signals/issue-pr-churn.ts";
