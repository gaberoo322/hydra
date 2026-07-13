/**
 * Builder-Health Scorecard aggregator (issue #732).
 *
 * The builder-side counterpart to Target Outcomes (CONTEXT.md: **Builder
 * Health**). ADR-0013 elevates the builder itself to the durable asset and
 * the Orchestrator Vision (vector 6) mandates surfacing builder-health
 * honestly; ADR-0003's 25% self-improvement floor is an input budget with no
 * output signal today. This scorecard is that output signal: a small, trended
 * set of metrics answering "is the 25% investment producing a measurably
 * better builder?".
 *
 * # Composition, not green-field
 *
 * Almost every metric is composed read-only from existing, mostly-trended
 * substrate:
 *
 *   - Self-Improvement Share  — `capacity-floor.ts::getCapacitySnapshot`
 *                               (native window 20, ORCHESTRATOR_FLOOR=0.25).
 *   - Rework rate             — `metrics/aggregate.ts` regressionRate +
 *                               noOpMergeRate (heartbeat window 50).
 *   - Mutation-kill-rate trend — `metrics/trend.ts` getMetricsTrend
 *                               mutationKillRate series.
 *   - Learning throughput     — `lessons-trend.ts` promotionRate +
 *                               metaFrictionOpened, plus design-concept
 *                               production via getDesignConceptProductionCountForDate.
 *
 * Two metrics are NEW and derive from the dispatch->PR link (issue #732's
 * one new write) joined against GitHub on read:
 *
 *   - Autonomy Rate  — the headline metric (CONTEXT.md: **Autonomy Rate**).
 *                      A dispatch is autonomous iff its PR was merged by the
 *                      auto-merge bot AND its issue/PR timeline never carried
 *                      an `operator-approved` or `ready-for-human` label AND no
 *                      human authored a review or commit — i.e. nothing on the
 *                      closed escalation list (ADR-0005) was touched. An
 *                      automated rebase is NOT intervention.
 *   - Time-to-merge  — dispatch-open -> merged latency, median + p90.
 *
 * Plus the scope-violation-rate from the one other new persisted signal
 * (`redis/scope-violations.ts`).
 *
 * # Design contract
 *
 * - **Never throws.** Every sub-source runs under `Promise.allSettled` and
 *   degrades to an empty/zero slot — same contract as friction-patterns.ts
 *   and lessons-trend.ts. The digest section and dashboard widget must
 *   render "no data yet" rather than error.
 * - **Per-metric native windows.** Each metric echoes its own `window` +
 *   provenance; there is no false-precision single global window.
 * - **Pure classifier.** `classifyAutonomy` (autonomy-classifier.ts) and the
 *   `percentileInterpolated` primitive (metrics/math.ts, issue #2613) are pure
 *   functions exported for tests; the GitHub and Redis readers are overridable
 *   via `deps`. Both live in their own canonical modules — this file imports
 *   the percentile's output via `computeAutonomyRate` and no longer re-exports
 *   it.
 * - **Autonomy Rate fan-out lives in its own module.** `computeAutonomyRate`
 *   (autonomy-rate.ts, issue #2068) owns the dispatch->PR link + GitHub fan-out
 *   that produces the autonomy-rate + time-to-merge slices; this file composes
 *   it alongside the other six metrics.
 */

import { type GhPrView } from "./autonomy-classifier.ts";
import {
  computeAutonomyRate,
  type AutonomyRateMetric,
  type TimeToMergeMetric,
} from "./autonomy-rate.ts";
import { getCapacitySnapshot, ORCHESTRATOR_FLOOR, DEFAULT_WINDOW_CYCLES } from "../capacity-floor.ts";
import { getAggregateStats } from "../metrics/aggregate.ts";
import { getMetricsTrend } from "../metrics/trend.ts";
import { getLessonsTrend, type LessonsTrendDeps } from "./lessons-trend.ts";
import { getScopeViolationsByDay } from "../redis/scope-violations.ts";
import { settledOrNull } from "../settled-fold.ts";
import { dayKey, type TrendPoint } from "./trend-series.ts";
import {
  computeStagnationPanel,
  type StagnationPanel,
  type TrendRow,
} from "./builder-health-stagnation-panel.ts";

// Heartbeat merge-rate window (env-overridable, matches the rolling merge
// rate's native window). Used for the rework metric's "of N cycles" framing.
const MERGE_RATE_WINDOW = (() => {
  const n = Number(process.env.HYDRA_ROLLING_MERGE_RATE_WINDOW);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
})();

// The stagnation panel (ADR-0028) trails a 50-cycle baseline; fetch a deeper
// window so the newest cycle has a full trailing baseline to compare against.
// Still inside the 7-day Redis TTL, so no backfill requirement.
const STAGNATION_TREND_WINDOW = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface SelfImprovementShareMetric {
  share: number;
  floor: number;
  floorMet: boolean;
  orchestratorCount: number;
  window: number;
}

interface ReworkRateMetric {
  regressionRate: number;
  noOpMergeRate: number;
  window: number;
}

interface MutationTrendMetric {
  series: TrendPoint[];
  window: number;
}

interface ScopeViolationMetric {
  series: TrendPoint[];
  total: number;
  windowDays: number;
}

interface LearningThroughputMetric {
  promotionRate: TrendPoint[];
  metaFrictionOpened: number;
  designConceptsProducedToday: number;
  windowDays: number;
}

export interface BuilderHealthScorecard {
  generatedAt: string;
  selfImprovementShare: SelfImprovementShareMetric | null;
  autonomyRate: AutonomyRateMetric | null;
  reworkRate: ReworkRateMetric | null;
  timeToMerge: TimeToMergeMetric | null;
  mutationKillRateTrend: MutationTrendMetric | null;
  scopeViolations: ScopeViolationMetric | null;
  learningThroughput: LearningThroughputMetric | null;
  /**
   * Per-signal, per-realm stagnation verdicts + window context (ADR-0028,
   * epic #3285). A panel — never a composite index. `null` when the trend
   * source degrades (the never-throws contract).
   */
  stagnation: StagnationPanel | null;
}

export interface BuilderHealthDeps {
  now?: Date;
  /** Rolling window for the GitHub-derived metrics (autonomy, time-to-merge). Default 50. */
  prWindow?: number;
  /** Window in days for the day-bucketed metrics (scope-violations, learning). Default 7. */
  windowDays?: number;
  /** Override the PR-link reader. Tests pass a stub so no Redis is needed. */
  listPrLinksSince?: (sinceMs: number) => Promise<Array<Record<string, string>>>;
  /** Override the GitHub PR-view reader (one call per PR). Tests pass a stub. */
  fetchPrView?: (prNumber: number) => Promise<GhPrView | null>;
  /** Override the capacity snapshot reader. */
  getCapacitySnapshot?: typeof getCapacitySnapshot;
  /** Override the aggregate-stats reader. */
  getAggregateStats?: typeof getAggregateStats;
  /** Override the metrics-trend reader. */
  getMetricsTrend?: typeof getMetricsTrend;
  /** Override the lessons-trend reader. */
  getLessonsTrend?: (windowDays: number, deps?: LessonsTrendDeps) => Promise<{
    promotionRate: TrendPoint[];
    metaFrictionOpened: number;
  }>;
  /** Override the scope-violations reader. */
  getScopeViolationsByDay?: (days: number, now?: Date) => Promise<Array<{ date: string; count: number }>>;
  /** Override the design-concept production-count reader. */
  getDesignConceptProductionCountForDate?: (date: string) => Promise<number>;
  /** GitHub repo handle (`owner/name`) for the per-PR view. Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getBuilderHealthScorecard(
  deps: BuilderHealthDeps = {},
): Promise<BuilderHealthScorecard> {
  const now = deps.now ?? new Date();
  const prWindow = clampWindow(deps.prWindow, 50, 1, 200);
  const windowDays = clampWindow(deps.windowDays, 7, 1, 90);

  const [
    capacityResult,
    aggregateResult,
    autonomyResult,
    mutationResult,
    scopeResult,
    learningResult,
    stagnationResult,
  ] = await Promise.allSettled([
    computeSelfImprovementShare(deps),
    computeReworkRate(deps),
    computeAutonomyRate(prWindow, deps),
    computeMutationTrend(deps),
    computeScopeViolations(windowDays, now, deps),
    computeLearningThroughput(windowDays, now, deps),
    computeStagnation(deps),
  ]);

  return {
    generatedAt: now.toISOString(),
    selfImprovementShare: settledOrNull(capacityResult, "self-improvement-share"),
    reworkRate: settledOrNull(aggregateResult, "rework-rate"),
    autonomyRate: settledOrNull(autonomyResult, "autonomy-rate")?.autonomy ?? null,
    timeToMerge: settledOrNull(autonomyResult, "time-to-merge")?.timeToMerge ?? null,
    mutationKillRateTrend: settledOrNull(mutationResult, "mutation-trend"),
    scopeViolations: settledOrNull(scopeResult, "scope-violations"),
    learningThroughput: settledOrNull(learningResult, "learning-throughput"),
    stagnation: settledOrNull(stagnationResult, "stagnation"),
  };
}

function clampWindow(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Metric: Self-Improvement Share (reuse capacity-floor)
// ---------------------------------------------------------------------------

async function computeSelfImprovementShare(
  deps: BuilderHealthDeps,
): Promise<SelfImprovementShareMetric> {
  const reader = deps.getCapacitySnapshot ?? getCapacitySnapshot;
  const snap = await reader(DEFAULT_WINDOW_CYCLES);
  return {
    share: snap.orchestrator.share,
    floor: snap.orchestrator.floor ?? ORCHESTRATOR_FLOOR,
    floorMet: snap.floorMet,
    orchestratorCount: snap.orchestrator.count,
    window: snap.orchestrator.window,
  };
}

// ---------------------------------------------------------------------------
// Metric: Rework rate (reuse metrics/aggregate)
// ---------------------------------------------------------------------------

async function computeReworkRate(deps: BuilderHealthDeps): Promise<ReworkRateMetric> {
  const reader = deps.getAggregateStats ?? getAggregateStats;
  const stats = await reader(MERGE_RATE_WINDOW);
  return {
    regressionRate: Number(stats.regressionRate) || 0,
    noOpMergeRate: Number(stats.noOpMergeRate) || 0,
    window: Number(stats.cycles) || 0,
  };
}

// ---------------------------------------------------------------------------
// Metric: Mutation-kill-rate trend (reuse metrics/trend)
// ---------------------------------------------------------------------------

async function computeMutationTrend(deps: BuilderHealthDeps): Promise<MutationTrendMetric> {
  const reader = deps.getMetricsTrend ?? getMetricsTrend;
  const trend = await reader(MERGE_RATE_WINDOW);
  const series: TrendPoint[] = [];
  // Oldest-first so the sparkline reads left-to-right chronologically.
  for (const m of [...trend].reverse()) {
    const v = Number(m.mutationKillRate);
    if (!Number.isFinite(v)) continue;
    const t = typeof m.completedAt === "string" && m.completedAt
      ? m.completedAt
      : typeof m.startedAt === "string"
        ? m.startedAt
        : "";
    series.push({ t, v });
  }
  return { series, window: trend.length };
}

// ---------------------------------------------------------------------------
// Metric: Stagnation panel (ADR-0028, epic #3285)
// ---------------------------------------------------------------------------
//
// Runs the pure `computeStagnation` detector (#3287) per signal per realm over
// the cycle-metrics trend. Dispatched-work-only + per-realm are satisfied by
// construction: the cycle-metrics stream is written only for autopilot
// dispatches (no external/human PRs) and only for the orchestrator realm (the
// target realm has no cycle stream on this substrate, so its blocks are null —
// dark, never blended). No composite index — the panel exposes each signal's
// verdict independently (ADR-0028 Decision 1).

async function computeStagnation(deps: BuilderHealthDeps): Promise<StagnationPanel> {
  const reader = deps.getMetricsTrend ?? getMetricsTrend;
  const trend = (await reader(STAGNATION_TREND_WINDOW)) as TrendRow[];
  return computeStagnationPanel(trend);
}

// ---------------------------------------------------------------------------
// Metric: Scope-violation rate (new counter)
// ---------------------------------------------------------------------------

async function computeScopeViolations(
  windowDays: number,
  now: Date,
  deps: BuilderHealthDeps,
): Promise<ScopeViolationMetric> {
  const reader = deps.getScopeViolationsByDay ?? getScopeViolationsByDay;
  const byDay = await reader(windowDays, now);
  // Oldest-first for the sparkline.
  const series = [...byDay]
    .reverse()
    .map((d) => ({ t: `${d.date}T00:00:00.000Z`, v: d.count }));
  const total = byDay.reduce((s, d) => s + (Number(d.count) || 0), 0);
  return { series, total, windowDays };
}

// ---------------------------------------------------------------------------
// Metric: Learning throughput (reuse lessons-trend + design-concept count)
// ---------------------------------------------------------------------------

async function computeLearningThroughput(
  windowDays: number,
  now: Date,
  deps: BuilderHealthDeps,
): Promise<LearningThroughputMetric> {
  const lessonsReader =
    deps.getLessonsTrend ??
    ((days: number) => getLessonsTrend(days));
  const [lessonsSettled, dcSettled] = await Promise.allSettled([
    lessonsReader(windowDays),
    (deps.getDesignConceptProductionCountForDate ?? defaultDcCount)(utcDate(now)),
  ]);
  const lessons =
    lessonsSettled.status === "fulfilled"
      ? lessonsSettled.value
      : { promotionRate: [], metaFrictionOpened: 0 };
  if (lessonsSettled.status === "rejected") {
    console.error(
      `[builder-health] lessons-trend failed: ${(lessonsSettled.reason as any)?.message || lessonsSettled.reason}`,
    );
  }
  const dcCount = dcSettled.status === "fulfilled" ? dcSettled.value : 0;
  if (dcSettled.status === "rejected") {
    console.error(
      `[builder-health] design-concept count failed: ${(dcSettled.reason as any)?.message || dcSettled.reason}`,
    );
  }
  return {
    promotionRate: Array.isArray(lessons.promotionRate) ? lessons.promotionRate : [],
    metaFrictionOpened: Number(lessons.metaFrictionOpened) || 0,
    designConceptsProducedToday: Number(dcCount) || 0,
    windowDays,
  };
}

async function defaultDcCount(date: string): Promise<number> {
  const { getDesignConceptProductionCountForDate } = await import("../redis/design-concept.ts");
  return getDesignConceptProductionCountForDate(date);
}

// The UTC date-only key is the shared trend-series grammar (issue #956).
const utcDate = dayKey;
