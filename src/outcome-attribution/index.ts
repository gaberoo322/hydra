/**
 * src/outcome-attribution/index.ts — public surface of the **Outcome-Attribution**
 * Module (epic #2628, spine slices #2629/#2630/#2631/#2632).
 *
 * The Outcome-Attribution Module owns the attribution spine: it turns merge
 * LANDINGS into append-only ledger observations (the recorder + its live
 * Housekeeping-cadence subscription) and, PER LEADING METRIC, fits a
 * ridge-regularized linear model over those raw rows to assign each producer
 * class its **marginal effect** — the credit the spine attributes to it. This
 * replaces the biased write-time heuristic credit split the epic rejects.
 *
 * This file is the ONLY public import surface. Everything outside
 * `src/outcome-attribution/` imports from here (`from "../outcome-attribution/index.ts"`);
 * the internal split — the estimator, the recorder, the live subscription, and
 * the three lifecycle phase leaves (`phase-open.ts`, `phase-close.ts`,
 * `phase-void.ts`) plus `windows.ts` — is an implementation detail. The phase
 * lifecycle files are private to the module: external callers bind to the domain
 * interface here, never to a sub-file.
 */

// ---------------------------------------------------------------------------
// Estimator — the ridge marginal-effect read surface (issue #2630)
// ---------------------------------------------------------------------------
// The pure ridge-fit estimator: given the recorder's raw observation rows it
// fits, per leading metric, `delta_w = b0 + sum_c b_c * count_{c,w}` and returns
// the per-class marginal effects. Consumed read-only by the autopilot
// class-stats scoreboard and the `/api/attribution` route.
export { estimateMarginalEffects } from "./estimator.ts";
export type { MetricEstimate, AttributionEstimate } from "./estimator.ts";

// ---------------------------------------------------------------------------
// Recorder subscription — live merge-landing -> ledger writer (issue #2632)
// ---------------------------------------------------------------------------
// The autonomous producer of ledger rows: reacts to merge LANDINGS at the
// Housekeeping cadence (NOT a long-lived EventBus loop, per ADR-0010/-0012) and
// appends the raw observations the estimator later fits. Driven by the
// Scheduler's housekeeping chore.
export { runAttributionRecord } from "./subscribe.ts";
