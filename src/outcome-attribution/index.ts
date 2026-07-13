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
// Impact-ranking lens — the reverse-loop read surface (issue #3283)
// ---------------------------------------------------------------------------
// A pure fold over the estimator's per-metric marginal effects that ranks
// producer classes (anchor types) by FAVORABLE outcome impact PER unit of build
// cost, across every leading metric. This is what the discovery reverse-loop
// consumes (via `GET /api/attribution/impact`) to steer toward high-IMPACT
// areas rather than merely high-NOTICE ones (epic #2628 finding #6). Read-only,
// zero-I/O, never a bare estimate — every row carries its identifiability +
// noise-floor posture.
export { getTopImpactAnchorTypes } from "./impact-ranking.ts";
export type {
  ImpactRanking,
  ImpactRankRow,
  MetricContribution,
  MetricDirection,
  ImpactRankingOptions,
} from "./impact-ranking.ts";

// ---------------------------------------------------------------------------
// Recorder subscription — live merge-landing -> ledger writer (issue #2632)
// ---------------------------------------------------------------------------
// The autonomous producer of ledger rows: reacts to merge LANDINGS at the
// Housekeeping cadence (NOT a long-lived EventBus loop, per ADR-0010/-0012) and
// appends the raw observations the estimator later fits. Driven by the
// Scheduler's housekeeping chore.
export { runAttributionRecord } from "./subscribe.ts";
