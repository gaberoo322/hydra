/**
 * Friction-patterns aggregator (issue #620, PRD #615) — Explore page Friction tab.
 *
 * Surfaces the full set of `hydra:friction:{skill}:patterns` rows grouped by
 * skill, so the operator can browse what every subagent is quietly working
 * around (vs. `lessons-overnight` which only shows promotion candidates inside
 * a recent window). Three slots:
 *
 *   - `bySkill`                     — one group per friction-bearing skill,
 *                                     newest-`lastSeen`-first.
 *   - `thresholdCandidates`         — items within `candidateWindow` hits of
 *                                     `PROMOTION_THRESHOLD` and not yet
 *                                     promoted. Sorted closest-to-promotion
 *                                     first so the dashboard hero row is the
 *                                     pattern most likely to escalate next.
 *   - `recentMetaFrictionIssues`    — `meta-friction` GitHub issues opened in
 *                                     the last `windowHours` (default 168 =
 *                                     7d), so the operator can correlate the
 *                                     escalation history with the live
 *                                     pattern set.
 *
 * # Design contract
 *
 * - **Pure classifier core.** Grouping, sorting, and the
 *   `nearPromotion` filter are pure functions exported for tests.
 * - **Never throws.** Each sub-source runs under `Promise.allSettled`; a
 *   failure degrades to `[]` for that bucket.
 * - **Reuses lessons-overnight's runtime shape.** The Redis scan and the
 *   `gh issue list` parser are written here rather than re-using the
 *   lessons-overnight ones because the slice-5 surface needs the FULL set
 *   (not just promotion candidates) and a longer window (7d not 24h). The
 *   two aggregators stay independent so the Today and Explore pages can
 *   evolve their queries separately.
 */

import { promisify } from "node:util";
import { execFile as execFileSync } from "node:child_process";

import { PROMOTION_THRESHOLD } from "../pattern-memory/agent-memory.ts";
import { readFrictionPatterns } from "./friction-source.ts";

const execFile = promisify(execFileSync);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One friction-pattern row, as the Explore page renders it. Mirrors the
 * `MemoryPattern` fields the operator actually reads — the full
 * `MemoryPattern` carries promotion bookkeeping (hitsAtPromotion,
 * demotedReason, …) that the Explore tab doesn't surface.
 */
/**
 * Issue #843 — the **Escalation Outcome** stamped on a pattern when its most
 * recent escalation actually fired. Mirrors `MemoryPattern.lastEscalation`;
 * surfaced verbatim so a systematic gh/auth outage shows as a column of
 * `error` statuses on the Explore Friction tab.
 */
export interface FrictionLastEscalation {
  status: "created" | "commented" | "reopened" | "skipped" | "error";
  issueNumber?: number;
  error?: string;
  at: string;
}

export interface FrictionPatternRow {
  skill: string;
  cue: string;
  severity: "prevent" | "reinforce";
  hitCount: number;
  hitsToPromotion: number;
  promoted: boolean;
  lastSeen: string;
  firstSeen: string;
  examples: string[];
  /** True iff hitCount is in `[PROMOTION_THRESHOLD - candidateWindow, PROMOTION_THRESHOLD)` and not promoted. */
  nearThreshold: boolean;
  /**
   * Issue #843 — the **Escalation Outcome** of this pattern's last fired
   * escalation, or `null` when no escalation has ever fired (pre-#843 records
   * lack the field entirely). A column of `error` statuses across skills is the
   * operator-visible signal of a systematic escalation outage.
   */
  lastEscalation: FrictionLastEscalation | null;
}

export interface FrictionGroup {
  skill: string;
  /** Patterns for this skill, newest-`lastSeen`-first. */
  patterns: FrictionPatternRow[];
}

export interface MetaFrictionIssueRef {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

export interface FrictionPatternsSnapshot {
  bySkill: FrictionGroup[];
  /** All `nearThreshold` rows across every skill, closest-to-promotion first. */
  thresholdCandidates: FrictionPatternRow[];
  recentMetaFrictionIssues: MetaFrictionIssueRef[];
  /** Echo of the runtime constant so the dashboard can render "K of N hits". */
  promotionThreshold: number;
  /** Hits-shy-of-threshold window used to populate `nearThreshold` / `thresholdCandidates`. */
  candidateWindow: number;
  /** Echo of the window used for `recentMetaFrictionIssues` so the UI can label "last Xh". */
  windowHours: number;
  generatedAt: string;
}

export interface FrictionPatternsDeps {
  now?: Date;
  githubRepo?: string;
  /** Hits short of the threshold that still counts as a candidate. Default 1. */
  candidateWindow?: number;
  /** Window for `recentMetaFrictionIssues`. Default 168h (7d). */
  windowHours?: number;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Override the friction-patterns reader. Returns a list of
   * `{ skill, patterns }` tuples. Defaults to scanning Redis. Tests pass a
   * stub so they don't need a live Redis.
   */
  readFrictionPatterns?: () => Promise<Array<{ skill: string; patterns: RawFrictionPattern[] }>>;
}

/**
 * Minimal shape of one entry in a `hydra:friction:{skill}:patterns` JSON
 * array. Mirrors `MemoryPattern` but only the fields this aggregator reads.
 */
export interface RawFrictionPattern {
  category: string;
  severity?: "prevent" | "reinforce";
  hitCount: number;
  promoted?: boolean;
  lastSeen?: string;
  firstSeen?: string;
  examples?: string[];
  /** Issue #843 — optional Escalation Outcome stamp; absent on pre-#843 records. */
  lastEscalation?: {
    status?: unknown;
    issueNumber?: unknown;
    error?: unknown;
    at?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_HOURS = 168;

export async function getFrictionPatterns(
  deps: FrictionPatternsDeps = {},
): Promise<FrictionPatternsSnapshot> {
  const now = deps.now ?? new Date();
  const candidateWindow = Math.max(1, Math.floor(deps.candidateWindow ?? 1));
  const windowHours = Math.max(1, Math.floor(deps.windowHours ?? DEFAULT_WINDOW_HOURS));
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const [groupsResult, issuesResult] = await Promise.allSettled([
    readGroupedFrictionPatterns(candidateWindow, deps),
    readMetaFrictionIssues(windowStart, deps),
  ]);

  const bySkill = settledOrEmpty(groupsResult, "friction-patterns/by-skill");
  const issues = settledOrEmpty(issuesResult, "friction-patterns/meta-friction");

  const thresholdCandidates: FrictionPatternRow[] = [];
  for (const group of bySkill) {
    for (const p of group.patterns) {
      if (p.nearThreshold) thresholdCandidates.push(p);
    }
  }
  thresholdCandidates.sort((a, b) => a.hitsToPromotion - b.hitsToPromotion);

  return {
    bySkill,
    thresholdCandidates,
    recentMetaFrictionIssues: issues,
    promotionThreshold: PROMOTION_THRESHOLD,
    candidateWindow,
    windowHours,
    generatedAt: now.toISOString(),
  };
}

function settledOrEmpty<T>(result: PromiseSettledResult<T[]>, label: string): T[] {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `[friction-patterns] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Lifts one skill's raw friction rows into
 * the dashboard-facing shape. Drops malformed rows (non-finite hitCount,
 * missing category) rather than throwing.
 *
 * `nearThreshold` is true when the row is un-promoted AND its hitCount falls
 * in `[PROMOTION_THRESHOLD - candidateWindow, PROMOTION_THRESHOLD)` — i.e.
 * the row is one (or fewer) hits short of promotion. Already-promoted rows
 * are surfaced in `bySkill` but never marked `nearThreshold`.
 */
export function liftFrictionPatterns(
  skill: string,
  patterns: readonly RawFrictionPattern[],
  candidateWindow: number,
): FrictionPatternRow[] {
  if (!Array.isArray(patterns)) return [];
  const min = Math.max(0, PROMOTION_THRESHOLD - candidateWindow);
  const out: FrictionPatternRow[] = [];
  for (const p of patterns) {
    if (!p || typeof p !== "object") continue;
    const hitCount = Number(p.hitCount);
    if (!Number.isFinite(hitCount) || hitCount < 0) continue;
    const cue = typeof p.category === "string" && p.category.length > 0 ? p.category : "(unknown cue)";
    const promoted = Boolean(p.promoted);
    const nearThreshold =
      !promoted && hitCount >= min && hitCount < PROMOTION_THRESHOLD;
    out.push({
      skill,
      cue,
      severity: p.severity === "reinforce" ? "reinforce" : "prevent",
      hitCount,
      hitsToPromotion: Math.max(0, PROMOTION_THRESHOLD - hitCount),
      promoted,
      lastSeen: typeof p.lastSeen === "string" ? p.lastSeen : "",
      firstSeen: typeof p.firstSeen === "string" ? p.firstSeen : "",
      examples: Array.isArray(p.examples)
        ? p.examples.filter((e): e is string => typeof e === "string").slice(0, 3)
        : [],
      nearThreshold,
      lastEscalation: normalizeLastEscalation(p.lastEscalation),
    });
  }
  // Newest-lastSeen first; rows without a lastSeen sink to the bottom.
  out.sort((a, b) => {
    const aMs = Date.parse(a.lastSeen) || 0;
    const bMs = Date.parse(b.lastSeen) || 0;
    return bMs - aMs;
  });
  return out;
}

const ESCALATION_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "commented",
  "reopened",
  "skipped",
  "error",
]);

/**
 * Pure helper — narrow the permissive raw `lastEscalation` shape into the
 * dashboard-facing `FrictionLastEscalation`, or `null` when absent/malformed.
 * Issue #843. A row whose `status` isn't one of the known Escalation Outcome
 * statuses is treated as no-stamp rather than surfaced as a half-row.
 */
export function normalizeLastEscalation(
  raw: RawFrictionPattern["lastEscalation"],
): FrictionLastEscalation | null {
  if (!raw || typeof raw !== "object") return null;
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!ESCALATION_STATUSES.has(status)) return null;
  const at = typeof raw.at === "string" ? raw.at : "";
  const out: FrictionLastEscalation = {
    status: status as FrictionLastEscalation["status"],
    at,
  };
  if (typeof raw.issueNumber === "number" && Number.isFinite(raw.issueNumber)) {
    out.issueNumber = raw.issueNumber;
  }
  if (typeof raw.error === "string" && raw.error.length > 0) {
    out.error = raw.error;
  }
  return out;
}

/**
 * Pure helper — exported for tests. Parses `gh issue list --json` output for
 * the meta-friction label query. Re-filters by `createdAt` so sub-day windows
 * don't include items from the search's coarser date-prefix resolution.
 */
export function parseMetaFrictionIssues(
  jsonStdout: string,
  windowStart: Date,
): MetaFrictionIssueRef[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const startMs = windowStart.getTime();
  const out: MetaFrictionIssueRef[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      createdAt?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || createdMs < startMs) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url: typeof c.url === "string" ? c.url : `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt,
    });
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: grouped friction patterns
// ---------------------------------------------------------------------------

async function readGroupedFrictionPatterns(
  candidateWindow: number,
  deps: FrictionPatternsDeps,
): Promise<FrictionGroup[]> {
  const reader =
    deps.readFrictionPatterns ??
    (() => readFrictionPatterns<RawFrictionPattern>("friction-patterns"));
  const groups = await reader();
  const out: FrictionGroup[] = [];
  for (const { skill, patterns } of groups) {
    const lifted = liftFrictionPatterns(skill, patterns, candidateWindow);
    if (lifted.length === 0) continue;
    out.push({ skill, patterns: lifted });
  }
  // Sort skills by their newest-pattern lastSeen so the most-recently-active
  // skill is the first group rendered.
  out.sort((a, b) => {
    const aMs = a.patterns[0] ? Date.parse(a.patterns[0].lastSeen) || 0 : 0;
    const bMs = b.patterns[0] ? Date.parse(b.patterns[0].lastSeen) || 0 : 0;
    return bMs - aMs;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: meta-friction issues opened in window
// ---------------------------------------------------------------------------

async function readMetaFrictionIssues(
  windowStart: Date,
  deps: FrictionPatternsDeps,
): Promise<MetaFrictionIssueRef[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return [];
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
      "--label",
      "meta-friction",
      "--search",
      `created:>=${sinceDate}`,
      "--limit",
      "100",
      "--json",
      "number,title,url,createdAt",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseMetaFrictionIssues(stdout, windowStart);
}
