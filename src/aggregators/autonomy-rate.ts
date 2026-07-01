/**
 * Autonomy Rate fan-out (issue #2068 — extracted from builder-health.ts).
 *
 * The multi-source fan-out behind the **Autonomy Rate** + **Time-to-merge**
 * Builder Health metrics (CONTEXT.md: **Autonomy Rate**). This module owns the
 * *wiring* of the data sources — the dispatch->PR link reader
 * (`listAutopilotPrLinksSince`), one `viewPr` GitHub read per dispatch, and the
 * `classifyAutonomy` verdict — folded into the autonomy-rate + time-to-merge
 * metric slices. It is the sibling of `autonomy-classifier.ts`, which already
 * separated the *pure decision logic* (`classifyAutonomy`): the classifier
 * answers "is THIS PR autonomous?", this fan-out answers "what is the autonomy
 * rate over the window?" by joining the link store against GitHub on read.
 *
 * `getBuilderHealthScorecard` in builder-health.ts imports `computeAutonomyRate`
 * and remains the scorecard composition owner — it assembles this slice
 * alongside the other six metrics under its top-level `Promise.allSettled`.
 *
 * # Design contract
 *
 * - **Independently testable.** `computeAutonomyRate(deps)` takes a focused
 *   `AutonomyRateDeps` — a stubbed `fetchPrView` + `listPrLinksSince` is enough
 *   to exercise it; no full scorecard fixture is needed.
 * - **Never throws on its own.** The fan-out matches the builder-health
 *   contract — a missing PR view counts as non-autonomous-unknown (so a
 *   transient GitHub failure does not silently inflate the rate) rather than
 *   dropping the dispatch. The caller still wraps the whole call under
 *   `Promise.allSettled`.
 */

import { viewPr } from "../github/issues.ts";

import { classifyAutonomy, type GhPrView, type AutonomyDecision } from "./autonomy-classifier.ts";
import { listAutopilotPrLinksSince } from "../redis/autopilot-runs.ts";
import { percentileInterpolated } from "../metrics/math.ts";

/** The Autonomy Rate metric slice: autonomous / total over the PR window. */
export interface AutonomyRateMetric {
  rate: number;
  autonomous: number;
  total: number;
  window: number;
  /** Per-dispatch breakdown so the dashboard can show why a PR was non-autonomous. */
  breakdown: AutonomyDecision[];
}

/** The Time-to-merge metric slice, derived from the same fan-out. */
export interface TimeToMergeMetric {
  medianMinutes: number | null;
  p90Minutes: number | null;
  samples: number;
  window: number;
}

/**
 * Focused dependency surface for the Autonomy Rate fan-out. Tests pass stubs
 * so neither Redis nor a live `gh` process is needed; production omits them
 * and the defaults (`listAutopilotPrLinksSince`, `viewPr`) are used.
 */
export interface AutonomyRateDeps {
  now?: Date;
  /** Override the PR-link reader. Tests pass a stub so no Redis is needed. */
  listPrLinksSince?: (sinceMs: number) => Promise<Array<Record<string, string>>>;
  /** Override the GitHub PR-view reader (one call per PR). Tests pass a stub. */
  fetchPrView?: (prNumber: number) => Promise<GhPrView | null>;
  /** GitHub repo handle (`owner/name`) for the per-PR view. Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
}

/**
 * Fan out over the dispatch->PR links in the window, classify each merged PR's
 * autonomy, and fold into the autonomy-rate + time-to-merge metric slices.
 *
 * Behaviour (unchanged from the in-line `computeAutonomyAndLatency` it replaces):
 *   - Looks back 30 days of PR links, capped at `prWindow` newest.
 *   - Skips non-integer / non-positive PR numbers.
 *   - A missing PR view -> non-autonomous-unknown (reason `pr-view-unavailable`),
 *     kept in the breakdown so the rate does not silently inflate.
 *   - Only merged PRs count toward the rate (a dispatch "reaches merged").
 *   - Time-to-merge latencies are the dispatch-open -> merged span in minutes,
 *     only when both timestamps are finite and ordered.
 */
export async function computeAutonomyRate(
  prWindow: number,
  deps: AutonomyRateDeps,
): Promise<{ autonomy: AutonomyRateMetric; timeToMerge: TimeToMergeMetric }> {
  const now = deps.now ?? new Date();
  // Look back over the day-window's worth of PR links; cap at prWindow newest.
  const sinceMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const linkReader = deps.listPrLinksSince ?? listAutopilotPrLinksSince;
  const links = (await linkReader(sinceMs)).slice(0, prWindow);

  const decisions: AutonomyDecision[] = [];
  const latencies: number[] = [];

  for (const link of links) {
    const prNumber = Number(link.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const view = await (deps.fetchPrView ?? makeDefaultFetchPrView(deps))(prNumber);
    if (!view) {
      // No view — count as non-autonomous-unknown rather than dropping, so
      // the rate doesn't silently inflate on transient GitHub failures.
      decisions.push({ prNumber, autonomous: false, reason: "pr-view-unavailable" });
      continue;
    }
    // Only merged PRs count toward the rate (a dispatch "reaches merged").
    if (!view.mergedAt) continue;
    const decision = classifyAutonomy(view);
    decisions.push({ prNumber, autonomous: decision.autonomous, reason: decision.reason });

    const openedMs = Number(link.openedAtMs);
    const mergedMs = Date.parse(view.mergedAt);
    if (Number.isFinite(openedMs) && Number.isFinite(mergedMs) && mergedMs >= openedMs) {
      latencies.push((mergedMs - openedMs) / 60000); // minutes
    }
  }

  const total = decisions.length;
  const autonomous = decisions.filter((d) => d.autonomous).length;
  return {
    autonomy: {
      rate: total > 0 ? autonomous / total : 0,
      autonomous,
      total,
      window: prWindow,
      breakdown: decisions,
    },
    timeToMerge: {
      medianMinutes: latencies.length > 0 ? percentileInterpolated(latencies, 50) : null,
      p90Minutes: latencies.length > 0 ? percentileInterpolated(latencies, 90) : null,
      samples: latencies.length,
      window: prWindow,
    },
  };
}

function makeDefaultFetchPrView(
  deps: AutonomyRateDeps,
): (prNumber: number) => Promise<GhPrView | null> {
  return (prNumber: number) =>
    // viewPr reads through the Issue/PR Read seam (issue #908/#915): it owns
    // the `gh pr view` argv + repo handle and returns the raw parsed object
    // (typed `GhPrView` here, the caller's responsibility) or null on any
    // failure (never throws).
    viewPr<GhPrView>(prNumber, "number,mergedAt,mergedBy,labels,reviews,commits", {
      repo: deps.githubRepo,
    });
}

