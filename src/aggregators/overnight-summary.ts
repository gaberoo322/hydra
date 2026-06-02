/**
 * Overnight summary aggregator (issue #616, PRD #615).
 *
 * "Since you were gone" — the first deep module of Dashboard v2. Pulls
 * five numbers (merge count, autopilot run count, $ spent, issues opened,
 * quota headroom) from disparate sources and returns one typed shape.
 *
 * # Design contract
 *
 * - **Pure aggregator.** No Express, no caches, no module-global side
 *   effects. Every dependency is either injected via the `deps` parameter
 *   (for tests) or resolved at call time from the canonical module
 *   (`src/cost/`, `src/redis/autopilot-runs.ts`).
 * - **Never throws.** Each sub-source is wrapped — a failed sub-call
 *   degrades that one field to 0 / "unknown" and the rest of the
 *   aggregate still ships. The caller (an HTTP route) gets a shape it
 *   can render without try/catch wrapping around the aggregator itself.
 * - **Clock injection.** `now` is a parameter, not `new Date()` inside.
 *   Tests pin a fixed instant and exercise window boundaries deterministically.
 * - **Exec / Redis / gh injection.** The same `deps` knob that tests use
 *   to stub `execFileAsync`, the autopilot runs index reader, the cost
 *   surrogate, and the usage snapshot. Production callers pass nothing
 *   and we resolve the real implementations.
 *
 * # Why this isn't five smaller routes
 *
 * The PRD scopes one banner — "Since you were gone: N merged, M runs,
 * $X spent, K issues, headroom Y." Splitting the read into five
 * endpoints would mean five round-trips for one banner. The
 * aggregator collapses them server-side; the dashboard polls one URL.
 */

import { resolve } from "node:path";

import { execFileViaSeam } from "../github/exec-file-compat.ts";

import type { HeadroomLevel } from "./types.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OvernightSummary {
  mergeCount: number;
  runCount: number;
  costSpent: number;
  issuesOpened: number;
  headroom: HeadroomLevel;
  windowHours: number;
  generatedAt: string;
}

/**
 * Dependency-injection shape — every external touchpoint of the aggregator
 * lives here so tests can stub them and the aggregator stays pure. All
 * fields are optional; defaults wire up the real implementations.
 */
export interface OvernightSummaryDeps {
  /** Wall-clock anchor — defaults to `new Date()`. */
  now?: Date;
  /** Repo path used by the `git log` count — defaults to `process.env.HYDRA_ROOT || ~/hydra`. */
  repoPath?: string;
  /**
   * Async exec used for `git` and `gh` sub-shells. Defaults to
   * `promisify(execFile)`. Tests stub this to return canned stdout
   * without spawning subprocesses.
   */
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * GitHub repo handle for `gh issue list` (`owner/name`). Defaults to
   * `gaberoo322/hydra`. Tests can pass an empty string to skip the
   * subprocess.
   */
  githubRepo?: string;
  /**
   * Autopilot runs reader — returns IDs of runs started at or after
   * `windowStartEpoch` (seconds). Defaults to a ZRANGEBYSCORE on
   * `hydra:autopilot:runs:index`.
   */
  countAutopilotRunsSince?: (windowStartEpoch: number) => Promise<number>;
  /**
   * Daily USD spend reader. The surrogate's dollar machinery was removed in
   * #704, so the default returns 0. Exposed so callers (and tests) can inject
   * a dollar figure if they have an authoritative source.
   */
  readCostUsd?: () => Promise<number>;
  /**
   * Usage tracker snapshot reader — returns `{ pacingState, emergencyStop,
   * calibrated, projectedWeeklyPercent }`. Defaults to `getUsage()` from
   * `src/cost/`.
   */
  readUsageHeadroom?: () => Promise<{
    pacingState: "under" | "on" | "over";
    emergencyStop: boolean;
    calibrated: boolean;
    projectedWeeklyPercent: number;
  }>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Compute the overnight summary for the last `windowHours` hours.
 *
 * The five sub-reads run in parallel under `Promise.allSettled` — a
 * single slow / failing source can't drag the whole banner offline.
 */
export async function getOvernightSummary(
  windowHours: number,
  deps: OvernightSummaryDeps = {},
): Promise<OvernightSummary> {
  const now = deps.now ?? new Date();
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);

  const [merges, runs, cost, issues, headroom] = await Promise.allSettled([
    countMerges(windowStart, deps),
    countAutopilotRuns(windowStart, deps),
    readCostUsd(deps),
    countIssuesOpened(windowStart, deps),
    readHeadroom(deps),
  ]);

  return {
    mergeCount: settledOr(merges, 0),
    runCount: settledOr(runs, 0),
    costSpent: settledOr(cost, 0),
    issuesOpened: settledOr(issues, 0),
    headroom: settledOr<HeadroomLevel>(headroom, "unknown"),
    windowHours,
    generatedAt: now.toISOString(),
  };
}

function settledOr<T>(result: PromiseSettledResult<T>, fallback: T): T {
  if (result.status === "fulfilled") return result.value;
  // Fail loud per CLAUDE.md: log + continue with a sentinel. The aggregator
  // contract is "never throw" — a single source failure must not blank the
  // whole banner.
  console.error(`[overnight-summary] sub-source failed: ${result.reason?.message || result.reason}`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Sub-source: PRs merged (git log)
// ---------------------------------------------------------------------------

async function countMerges(windowStart: Date, deps: OvernightSummaryDeps): Promise<number> {
  const exec = deps.execFileAsync ?? execFile;
  const cwd = deps.repoPath ?? resolveDefaultRepoPath();
  const since = windowStart.toISOString();
  // --first-parent --merges restricts to merge commits on master (squash-
  // merges from `gh pr merge --squash` show up as merge commits with one
  // parent, but `--merges` requires >1 parent — so we union both shapes by
  // counting all first-parent commits in the window. This matches what an
  // operator sees in the "Merged PRs" tab on GitHub.
  const { stdout } = await exec(
    "git",
    ["log", "master", `--since=${since}`, "--first-parent", "--pretty=format:%H"],
    { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return countNonEmptyLines(stdout);
}

// ---------------------------------------------------------------------------
// Sub-source: autopilot runs (Redis ZRANGEBYSCORE)
// ---------------------------------------------------------------------------

async function countAutopilotRuns(windowStart: Date, deps: OvernightSummaryDeps): Promise<number> {
  if (deps.countAutopilotRunsSince) {
    return deps.countAutopilotRunsSince(Math.floor(windowStart.getTime() / 1000));
  }
  // Default: count members in the runs index ZSET with score >= windowStartEpoch.
  // We use ZCOUNT for a single round-trip — it returns the cardinality of
  // the score range directly without pulling the IDs.
  const { getRedisConnection } = await import("../redis/connection.ts");
  const { redisKeys } = await import("../redis/keys.ts");
  const r = getRedisConnection();
  const min = String(Math.floor(windowStart.getTime() / 1000));
  const count = await r.zcount(redisKeys.autopilotRunsIndex(), min, "+inf");
  return Number(count) || 0;
}

// ---------------------------------------------------------------------------
// Sub-source: cost spent (surrogate)
// ---------------------------------------------------------------------------

async function readCostUsd(deps: OvernightSummaryDeps): Promise<number> {
  if (deps.readCostUsd) return deps.readCostUsd();
  // The cost surrogate's dollar-conversion machinery was removed in #704
  // (`HYDRA_TOKEN_USD_RATE` was structurally $0; no live dollar cap existed).
  // There is no authoritative per-day dollar source, so the default is 0.
  return 0;
}

// ---------------------------------------------------------------------------
// Sub-source: issues opened (gh issue list)
// ---------------------------------------------------------------------------

async function countIssuesOpened(windowStart: Date, deps: OvernightSummaryDeps): Promise<number> {
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return 0;
  const exec = deps.execFileAsync ?? execFile;
  // `gh issue list --search "created:>=YYYY-MM-DD"` is the simplest way to
  // page back exactly the items we want without pulling the entire issue
  // history. We use the ISO date prefix (UTC) — GitHub's search interprets
  // bare date as an inclusive lower bound at 00:00 UTC, which is slightly
  // generous for sub-day windows but harmless for the overnight use case.
  const sinceDate = windowStart.toISOString().split("T")[0];
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      `created:>=${sinceDate}`,
      "--limit",
      "200",
      "--json",
      "number,createdAt",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return countIssuesInWindow(stdout, windowStart);
}

/**
 * Pure helper — exported for tests. Parses `gh issue list --json` output
 * and counts issues whose `createdAt` is strictly within the window.
 *
 * Refines the date-prefix search above: GitHub's search returns anything
 * created on the boundary day, but a 12h overnight window may sit entirely
 * inside that day. We re-filter on the actual `createdAt` timestamp here.
 */
export function countIssuesInWindow(jsonStdout: string, windowStart: Date): number {
  if (!jsonStdout.trim()) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  const startMs = windowStart.getTime();
  let n = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== "string") continue;
    const ms = Date.parse(createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms >= startMs) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Sub-source: headroom (usage tracker)
// ---------------------------------------------------------------------------

async function readHeadroom(deps: OvernightSummaryDeps): Promise<HeadroomLevel> {
  let snap: {
    pacingState: "under" | "on" | "over";
    emergencyStop: boolean;
    calibrated: boolean;
    projectedWeeklyPercent: number;
  };
  if (deps.readUsageHeadroom) {
    snap = await deps.readUsageHeadroom();
  } else {
    const { getUsage } = await import("../cost/index.ts");
    const usage = await getUsage();
    snap = {
      pacingState: usage.pacingState,
      emergencyStop: usage.emergencyStop,
      calibrated: usage.calibrated,
      projectedWeeklyPercent: usage.projectedWeeklyPercent,
    };
  }
  return projectHeadroom(snap);
}

/**
 * Pure helper — exported for tests. Maps a usage snapshot to the
 * discriminated headroom level. Stable so the dashboard can render the
 * verdict from this aggregator OR `/api/usage` and get the same answer.
 */
export function projectHeadroom(snap: {
  pacingState: "under" | "on" | "over";
  emergencyStop: boolean;
  calibrated: boolean;
  projectedWeeklyPercent: number;
}): HeadroomLevel {
  if (!snap.calibrated) return "unknown";
  if (snap.emergencyStop || snap.pacingState === "over") return "red";
  if (snap.pacingState === "on") return "yellow";
  return "green";
}

// ---------------------------------------------------------------------------
// Tiny utilities — pure, exported for tests
// ---------------------------------------------------------------------------

export function countNonEmptyLines(stdout: string): number {
  if (!stdout) return 0;
  let n = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim()) n += 1;
  }
  return n;
}

function resolveDefaultRepoPath(): string {
  const env = process.env.HYDRA_ROOT;
  if (env) return env;
  const home = process.env.HOME;
  if (home) return `${home}/hydra`;
  return process.cwd();
}
