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
 * - **Pure classifier.** `classifyAutonomy`, `percentile`, and the
 *   composition helpers are pure functions exported for tests; the GitHub
 *   and Redis readers are overridable via `deps`.
 */

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import { resolveGithubRepo } from "../github/issues.ts";

import { getCapacitySnapshot, ORCHESTRATOR_FLOOR, DEFAULT_WINDOW_CYCLES } from "../capacity-floor.ts";
import { getAggregateStats } from "../metrics/aggregate.ts";
import { getMetricsTrend } from "../metrics/trend.ts";
import { getLessonsTrend, type LessonsTrendDeps } from "./lessons-trend.ts";
import { listAutopilotPrLinksSince } from "../redis/autopilot-runs.ts";
import { getScopeViolationsByDay } from "../redis/scope-violations.ts";
import { settledOrNull } from "./settle.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

// Heartbeat merge-rate window (env-overridable, matches the rolling merge
// rate's native window). Used for the rework metric's "of N cycles" framing.
const MERGE_RATE_WINDOW = (() => {
  const n = Number(process.env.HYDRA_ROLLING_MERGE_RATE_WINDOW);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
})();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SelfImprovementShareMetric {
  share: number;
  floor: number;
  floorMet: boolean;
  orchestratorCount: number;
  window: number;
}

export interface AutonomyRateMetric {
  rate: number;
  autonomous: number;
  total: number;
  window: number;
  /** Per-dispatch breakdown so the dashboard can show why a PR was non-autonomous. */
  breakdown: AutonomyDecision[];
}

export interface AutonomyDecision {
  prNumber: number;
  autonomous: boolean;
  reason: string;
}

export interface ReworkRateMetric {
  regressionRate: number;
  noOpMergeRate: number;
  window: number;
}

export interface TimeToMergeMetric {
  medianMinutes: number | null;
  p90Minutes: number | null;
  samples: number;
  window: number;
}

export interface MutationTrendMetric {
  series: { t: string; v: number }[];
  window: number;
}

export interface ScopeViolationMetric {
  series: { t: string; v: number }[];
  total: number;
  windowDays: number;
}

export interface LearningThroughputMetric {
  promotionRate: { t: string; v: number }[];
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
}

/** Minimal shape of `gh pr view --json mergedBy,labels,reviews,commits` output. */
export interface GhPrView {
  number?: number;
  mergedAt?: string | null;
  mergedBy?: { login?: string; is_bot?: boolean } | null;
  labels?: Array<{ name?: string }>;
  reviews?: Array<{ author?: { login?: string; is_bot?: boolean } | null }>;
  commits?: Array<{
    authors?: Array<{ login?: string; is_bot?: boolean }>;
    author?: { login?: string; is_bot?: boolean } | null;
  }>;
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
    promotionRate: { t: string; v: number }[];
    metaFrictionOpened: number;
  }>;
  /** Override the scope-violations reader. */
  getScopeViolationsByDay?: (days: number, now?: Date) => Promise<Array<{ date: string; count: number }>>;
  /** Override the design-concept production-count reader. */
  getDesignConceptProductionCountForDate?: (date: string) => Promise<number>;
  githubRepo?: string;
  execFileAsync?: typeof execFile;
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
  ] = await Promise.allSettled([
    computeSelfImprovementShare(deps),
    computeReworkRate(deps),
    computeAutonomyAndLatency(prWindow, deps),
    computeMutationTrend(deps),
    computeScopeViolations(windowDays, now, deps),
    computeLearningThroughput(windowDays, now, deps),
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
  const series: { t: string; v: number }[] = [];
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

// ---------------------------------------------------------------------------
// Metric: Autonomy rate + time-to-merge (new — dispatch->PR link + GitHub)
// ---------------------------------------------------------------------------

async function computeAutonomyAndLatency(
  prWindow: number,
  deps: BuilderHealthDeps,
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
      medianMinutes: latencies.length > 0 ? percentile(latencies, 50) : null,
      p90Minutes: latencies.length > 0 ? percentile(latencies, 90) : null,
      samples: latencies.length,
      window: prWindow,
    },
  };
}

function makeDefaultFetchPrView(
  deps: BuilderHealthDeps,
): (prNumber: number) => Promise<GhPrView | null> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = resolveGithubRepo(deps.githubRepo);
  return async (prNumber: number) => {
    try {
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          repo,
          "--json",
          "number,mergedAt,mergedBy,labels,reviews,commits",
        ],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      if (!stdout.trim()) return null;
      return JSON.parse(stdout) as GhPrView;
    } catch (err: any) {
      console.error(`[builder-health] gh pr view ${prNumber} failed: ${err?.message || err}`);
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

const INTERVENTION_LABELS = new Set(["operator-approved", "ready-for-human"]);
/** GitHub bot login suffix + the known auto-merge bot logins. */
const KNOWN_BOT_LOGINS = new Set(["github-actions[bot]", "web-flow"]);

/**
 * Pure helper — exported for tests. Classify a merged PR as autonomous or not.
 *
 * A dispatch is autonomous iff (grounded in ADR-0005's CLOSED escalation
 * list, CONTEXT.md: **Autonomy Rate**):
 *   1. its PR was merged by a bot (auto-merge), AND
 *   2. its labels never carried `operator-approved` or `ready-for-human`, AND
 *   3. no human authored a review, AND
 *   4. no human authored a commit on the branch.
 *
 * An automated rebase / bot squash-merge is NOT intervention. A human merge,
 * a human review, a human commit, or an escalation label is intervention.
 */
export function classifyAutonomy(view: GhPrView): { autonomous: boolean; reason: string } {
  // 1. Merged by a human?
  if (!isBotActor(view.mergedBy)) {
    return { autonomous: false, reason: "merged-by-human" };
  }
  // 2. Escalation label ever present?
  const labels = Array.isArray(view.labels) ? view.labels : [];
  for (const l of labels) {
    if (l && typeof l.name === "string" && INTERVENTION_LABELS.has(l.name)) {
      return { autonomous: false, reason: `escalation-label:${l.name}` };
    }
  }
  // 3. Human-authored review?
  const reviews = Array.isArray(view.reviews) ? view.reviews : [];
  for (const r of reviews) {
    if (r && r.author && !isBotActor(r.author)) {
      return { autonomous: false, reason: "human-review" };
    }
  }
  // 4. Human-authored commit?
  const commits = Array.isArray(view.commits) ? view.commits : [];
  for (const c of commits) {
    const authors = Array.isArray(c?.authors) && c.authors.length > 0
      ? c.authors
      : c?.author
        ? [c.author]
        : [];
    for (const a of authors) {
      if (a && !isBotActor(a)) {
        return { autonomous: false, reason: "human-commit" };
      }
    }
  }
  return { autonomous: true, reason: "autonomous" };
}

/** True iff the actor is a bot (is_bot flag or a known bot login). */
function isBotActor(actor: { login?: string; is_bot?: boolean } | null | undefined): boolean {
  if (!actor) return false;
  if (actor.is_bot === true) return true;
  const login = typeof actor.login === "string" ? actor.login : "";
  if (login.endsWith("[bot]")) return true;
  return KNOWN_BOT_LOGINS.has(login);
}

/**
 * Pure helper — exported for tests. Linear-interpolated percentile (p in
 * 0..100) over a numeric sample. Returns 0 for empty input.
 */
export function percentile(values: number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length === 1) return round1(xs[0]);
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return round1(xs[lo]);
  const frac = rank - lo;
  return round1(xs[lo] + (xs[hi] - xs[lo]) * frac);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function utcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
