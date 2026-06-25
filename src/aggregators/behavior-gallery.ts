/**
 * Behavior-gallery aggregator (issue #620, PRD #615) — Explore page Behavior tab.
 *
 * Returns the last N autopilot runs in a compact gallery shape: one row per
 * run with status, trigger, duration, dispatch + merge counts, and total
 * cost (USD surrogate). Each item carries `detailHref = /autopilot/:runId`
 * so the dashboard can link into the existing run-detail page.
 *
 * Filters
 * -------
 * The Explore tab filters by `outcome` and `class`. Both are evaluated
 * client-side against the projected row:
 *
 *   - `outcome` — one of `success | failure | aborted | in-progress`. We
 *     derive this from the run hash's `status` + `term_reason`:
 *       running                              → in-progress
 *       completed, exit_code 0               → success
 *       completed, exit_code != 0            → failure
 *       failed (server-side sweep verdict)   → failure
 *       aborted / cancelled                  → aborted
 *       anything else                        → unknown (filtered out by
 *                                              `outcome` filter; still shown
 *                                              when the operator picks "all")
 *   - `class` — the autopilot dispatch class (`dev_orch`, `dev_target`,
 *     `qa`, …). Because a run typically dispatches multiple classes, the
 *     row exposes `classes: string[]`; the filter passes if the requested
 *     class appears in the set.
 *
 * Both filters are applied BEFORE the limit so paginating doesn't surface
 * an empty page when the limit happens to land on filtered-out rows.
 *
 * # Design contract
 *
 * - **Pure classifiers exported.** `classifyOutcome` and `runMatchesFilters`
 *   are pure functions tested directly.
 * - **Never throws.** Underlying `listRuns` returns a result object; on a
 *   Redis failure we return `[]` with a console.error.
 * - **Reuses the autopilot Module.** We call `listRuns()` instead of
 *   re-reading `hydra:autopilot:run:*` so the projection / sweep behavior
 *   stays in one place.
 */

import { listRuns } from "../autopilot/runs.ts";
import type { AutopilotRunOutcome } from "../schemas/explore-page.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BehaviorRow {
  runId: string;
  startedAt: string;
  durationS: number | null;
  status: string;
  outcome: AutopilotRunOutcome;
  trigger: string;
  turns: number;
  dispatches: number;
  mergedCount: number;
  failedCount: number;
  totalTokens: number;
  exitCode: number | null;
  termReason: string | null;
  /** Distinct autopilot classes dispatched during this run, alphabetised. */
  classes: string[];
  detailHref: string;
}

export interface BehaviorFilters {
  outcome?: AutopilotRunOutcome;
  /** Match against `BehaviorRow.classes` (substring/exact match). */
  class?: string;
}

export interface BehaviorGalleryDeps {
  /** Override the runs fetcher for tests so they don't need a Redis. */
  listRuns?: (limit: number) => Promise<ListRunsLike>;
  /** Resolve dispatch classes per runId. Defaults to scanning `actions` on each turn. */
  fetchClasses?: (runId: string) => Promise<string[]>;
}

/**
 * Minimal shape this aggregator needs from `listRuns`. Matches both the
 * production `ListRunsResult` (`Ok<{ runs }>` | `Err`) and the test stubs
 * (which pass plain `{ ok, error, code }`). We keep the type loose so the
 * stub doesn't have to mimic the full ErrorCode union.
 */
type ListRunsLike =
  | { ok: true; runs: Array<Record<string, unknown>> }
  | { ok: false; code?: string; error?: string; detail?: string };

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_LIST_FETCH_FACTOR = 3; // overfetch so filters can prune

export async function getBehaviorGallery(
  limit: number,
  filters: BehaviorFilters = {},
  deps: BehaviorGalleryDeps = {},
): Promise<BehaviorRow[]> {
  const bounded = clampLimit(limit);
  // Overfetch so filters don't surface a short page. Cap at MAX_LIMIT so a
  // pathological filter doesn't drag us into a huge Redis scan.
  const fetchLimit = Math.min(MAX_LIMIT, bounded * DEFAULT_LIST_FETCH_FACTOR);

  const list = (deps.listRuns ?? listRuns) as (n: number) => Promise<ListRunsLike>;
  const result = await list(fetchLimit);
  if (result.ok !== true) {
    const errBag = result as { code?: string; error?: string; detail?: string };
    const code = errBag.code ?? "unknown";
    const detail = errBag.error ?? errBag.detail ?? "";
    console.error(`[behavior-gallery] listRuns failed: ${code} ${detail}`);
    return [];
  }

  const fetchClasses = deps.fetchClasses ?? defaultFetchClasses;

  const rows: BehaviorRow[] = [];
  for (const raw of result.runs) {
    const row = await liftRunDigest(raw, fetchClasses);
    if (!row) continue;
    if (!runMatchesFilters(row, filters)) continue;
    rows.push(row);
    if (rows.length >= bounded) break;
  }
  return rows;
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Maps `status` + `exit_code` + `term_reason`
 * into the closed set of `AutopilotRunOutcome` values.
 */
export function classifyOutcome(
  status: string,
  exitCode: number | null,
  termReason: string | null,
): AutopilotRunOutcome {
  const s = String(status || "").toLowerCase();
  const reason = String(termReason || "").toLowerCase();
  if (s === "running") return "in-progress";
  if (s === "aborted" || s === "cancelled" || reason === "aborted" || reason === "cancelled") {
    return "aborted";
  }
  if (s === "failed") return "failure";
  if (s === "completed") {
    if (exitCode === 0) return "success";
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) return "failure";
    // No exit code recorded on a completed row — treat as success (the
    // historical pre-issue-#498 schema didn't always stamp exit_code).
    return "success";
  }
  return "unknown";
}

/**
 * Pure helper — exported for tests. Returns true when the row passes both
 * filter predicates. Missing filter fields match everything.
 */
export function runMatchesFilters(row: BehaviorRow, filters: BehaviorFilters): boolean {
  if (filters.outcome && row.outcome !== filters.outcome) return false;
  if (filters.class) {
    const wanted = filters.class.toLowerCase();
    const found = row.classes.some((c) => c.toLowerCase() === wanted);
    if (!found) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function liftRunDigest(
  raw: Record<string, unknown>,
  fetchClasses: (runId: string) => Promise<string[]>,
): Promise<BehaviorRow | null> {
  const runId = typeof raw.run_id === "string" ? raw.run_id : "";
  if (!runId) return null;
  const status = typeof raw.status === "string" ? raw.status : "";
  const exitCode = typeof raw.exit_code === "number" ? raw.exit_code : null;
  const termReason = typeof raw.term_reason === "string" ? raw.term_reason : null;
  const outcome = classifyOutcome(status, exitCode, termReason);
  let classes: string[] = [];
  try {
    classes = await fetchClasses(runId);
  } catch (err: any) {
    console.error(
      `[behavior-gallery] fetchClasses(${runId}) failed: ${err?.message || err}`,
    );
  }
  return {
    runId,
    startedAt: typeof raw.started === "string" ? raw.started : "",
    durationS: typeof raw.duration_s === "number" ? raw.duration_s : null,
    status,
    outcome,
    trigger: typeof raw.trigger === "string" ? raw.trigger : "manual",
    turns: typeof raw.turns === "number" ? raw.turns : 0,
    dispatches: typeof raw.dispatches === "number" ? raw.dispatches : 0,
    mergedCount: typeof raw.merged_count === "number" ? raw.merged_count : 0,
    failedCount: typeof raw.failed_count === "number" ? raw.failed_count : 0,
    totalTokens: typeof raw.total_tokens === "number" ? raw.total_tokens : 0,
    exitCode,
    termReason,
    classes,
    detailHref: `/autopilot/${runId}`,
  };
}

/**
 * Default class resolver — pulls the turn list off Redis and harvests
 * `dispatch.class` from each turn's `actions` array. Returns a deduped,
 * alphabetised list.
 */
async function defaultFetchClasses(runId: string): Promise<string[]> {
  const { listAutopilotRunTurnsDesc } = await import("../redis/autopilot-runs.ts");
  const members = await listAutopilotRunTurnsDesc(runId, 200);
  const classes = new Set<string>();
  for (const member of members) {
    try {
      const turn = JSON.parse(member);
      const actions = Array.isArray(turn?.actions) ? turn.actions : [];
      for (const a of actions) {
        if (a && a.type === "dispatch" && typeof a.class === "string") {
          classes.add(a.class);
        }
      }
    } catch { /* intentional: skip malformed turn rows — caller treats absent classes as "no signal" */ }
  }
  return [...classes].sort();
}
