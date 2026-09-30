/**
 * Stalled-PRs aggregator — the rank-1 `prs-not-landing` source of the
 * attention feed (issue #4624, ADR-0034 §8.1 rank 1).
 *
 * Admits each open, non-draft Orchestrator PR to AT MOST ONE admission line,
 * with precedence `conflicted` > `failed-required` > `unshepherded`:
 *
 *   - `conflicted`      — `mergeable == CONFLICTING`. Does not depend on checks.
 *   - `failed-required` — ≥ 1 REQUIRED context (the branch-protection set, read
 *                         over REST) whose latest rollup entry is failing.
 *   - `unshepherded`    — `mergeable == MERGEABLE`, auto-merge unset, and every
 *                         required context's latest entry is green (a required
 *                         context missing from the rollup is NOT green).
 *
 * `mergeable` UNKNOWN (or absent / unparseable) never admits to any line, and
 * a draft never admits. An UNKNOWN required set (the REST read failed) admits
 * no check-dependent line and names `required-contexts` in `sourceErrors` —
 * deliberately stricter than stuck-items' legacy "count every failure" posture
 * (ADR-0034 §5.1: unverifiable → UNKNOWN, never a confident row).
 *
 * # Single classifier definition
 *
 * The failing / green conclusion sets and the per-context latest-wins collapse
 * live HERE as exported pure helpers; stuck-items' `selectPrsWithFailedCi`
 * delegates to them rather than keeping a second copy.
 *
 * # Design contract
 *
 * - **Never throws.** Both sub-reads are settled; a failed PR-list read yields
 *   `sourcesOk:false` + `sourceErrors:["pr-list"]`, never an asserted zero.
 * - **One `gh pr list` call** with a per-caller fields override — the canonical
 *   `PR_LIST_JSON_FIELDS` is NOT widened (other consumers would pay GitHub's
 *   mergeability computation for nothing).
 * - **Orchestrator repo only** — Target PRs belong to rank 3 (#4625).
 */

import {
  listOpenPrs,
  listRequiredStatusContextsOrNull,
  PR_LIST_JSON_FIELDS,
  type PrRow,
} from "../github/prs.ts";
import { isIssueReadFailure } from "../github/issues.ts";
import { settledOr } from "../settled-fold.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StalledPrLine = "conflicted" | "failed-required" | "unshepherded";

export interface StalledPr {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  line: StalledPrLine;
  /** Required contexts whose winning entry is failing (failed-required only). */
  failedChecks: string[];
  /** Required contexts whose winning entry is green. */
  requiredGreen: number;
  /** Size of the known required set (0 when UNKNOWN). */
  requiredTotal: number;
}

export interface StalledPrsResult {
  items: StalledPr[];
  /** Open PR rows the PR-list read returned (proof the lookup ran). */
  scanned: number;
  /** True iff both sub-reads resolved (PR list ok AND required set known). */
  sourcesOk: boolean;
  /** Named failed sources: `pr-list`, `required-contexts`. */
  sourceErrors: string[];
}

export interface StalledPrsDeps {
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /** Override the PR-list seam reader (tests inject a stub). */
  listOpenPrs?: typeof listOpenPrs;
  /** Override the branch-protection required-contexts reader. */
  listRequiredStatusContextsOrNull?: typeof listRequiredStatusContextsOrNull;
}

/**
 * The canonical PR-list fields plus the three this aggregator needs. A
 * per-caller override — `PR_LIST_JSON_FIELDS` itself is unchanged.
 */
export const STALLED_PR_FIELDS = `${PR_LIST_JSON_FIELDS},isDraft,mergeable,autoMergeRequest`;

// ---------------------------------------------------------------------------
// Pure classifier helpers — the single definition (stuck-items delegates)
// ---------------------------------------------------------------------------

/** CheckRun conclusions that count as a failed check. */
export const FAILING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/** StatusContext states that count as a failed check. */
export const FAILING_STATUS_STATES: ReadonlySet<string> = new Set(["FAILURE", "ERROR"]);

/** Conclusions / states that count as green. */
export const GREEN_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
]);

export type RollupEntry = PrRow["statusCheckRollup"][number];
export type CheckVerdict = "failing" | "green" | "pending";

/** The context name a rollup entry reports under (CheckRun name, else StatusContext context). */
export function rollupEntryName(entry: RollupEntry): string {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  if (typeof entry.context === "string" && entry.context.length > 0) return entry.context;
  return "check";
}

function entryTimestamp(entry: RollupEntry): number {
  const completed = entry.completedAt ? Date.parse(entry.completedAt) : NaN;
  if (Number.isFinite(completed)) return completed;
  const started = entry.startedAt ? Date.parse(entry.startedAt) : NaN;
  if (Number.isFinite(started)) return started;
  return Number.NEGATIVE_INFINITY;
}

/**
 * Collapse rollup entries by context name — across CheckRun and StatusContext
 * shapes — keeping the latest entry by `completedAt` (falling back to
 * `startedAt`). On a timestamp tie (or two untimestamped entries) the later
 * entry in rollup order wins. A superseded CANCELLED/FAILURE run followed by a
 * SUCCESS rerun therefore collapses to green.
 */
export function collapseRollupByContext(
  rollup: readonly RollupEntry[],
): Map<string, RollupEntry> {
  const out = new Map<string, RollupEntry>();
  for (const entry of rollup) {
    const name = rollupEntryName(entry);
    const prev = out.get(name);
    if (!prev || entryTimestamp(entry) >= entryTimestamp(prev)) out.set(name, entry);
  }
  return out;
}

/**
 * Classify one (winning) rollup entry. A CheckRun is judged by `conclusion`
 * (empty while QUEUED / IN_PROGRESS → pending); a StatusContext by `state`
 * (FAILURE / ERROR failing, SUCCESS green, PENDING / EXPECTED pending).
 */
export function classifyRollupEntry(entry: RollupEntry | undefined): CheckVerdict {
  if (!entry) return "pending";
  const conclusion = typeof entry.conclusion === "string" ? entry.conclusion.toUpperCase() : "";
  if (conclusion) {
    if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) return "failing";
    if (GREEN_CHECK_CONCLUSIONS.has(conclusion)) return "green";
    return "pending";
  }
  const state = typeof entry.state === "string" ? entry.state.toUpperCase() : "";
  if (FAILING_STATUS_STATES.has(state)) return "failing";
  if (GREEN_CHECK_CONCLUSIONS.has(state)) return "green";
  return "pending";
}

/**
 * Pure — the rank-1 admission for a batch of PR rows. One item per admitted
 * PR, precedence conflicted > failed-required > unshepherded. `required` null
 * (UNKNOWN) admits only `conflicted`. Sorted by `updatedAt` ascending.
 */
export function classifyStalledPrs(
  rows: readonly PrRow[],
  required: ReadonlySet<string> | null,
): StalledPr[] {
  const out: StalledPr[] = [];
  for (const pr of rows) {
    if (pr.isDraft === true) continue;
    const mergeable = typeof pr.mergeable === "string" ? pr.mergeable.toUpperCase() : "";
    if (mergeable !== "MERGEABLE" && mergeable !== "CONFLICTING") continue;

    const base = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      updatedAt: pr.updatedAt || new Date(0).toISOString(),
    };

    if (mergeable === "CONFLICTING") {
      out.push({
        ...base,
        line: "conflicted",
        failedChecks: [],
        requiredGreen: 0,
        requiredTotal: required?.size ?? 0,
      });
      continue;
    }
    if (required === null) continue;

    const collapsed = collapseRollupByContext(pr.statusCheckRollup);
    const failed: string[] = [];
    let green = 0;
    for (const ctx of required) {
      const verdict = classifyRollupEntry(collapsed.get(ctx));
      if (verdict === "failing") failed.push(ctx);
      else if (verdict === "green") green++;
    }

    if (failed.length > 0) {
      out.push({
        ...base,
        line: "failed-required",
        failedChecks: failed,
        requiredGreen: green,
        requiredTotal: required.size,
      });
      continue;
    }
    if (pr.autoMergeArmed === false && green === required.size) {
      out.push({
        ...base,
        line: "unshepherded",
        failedChecks: [],
        requiredGreen: green,
        requiredTotal: required.size,
      });
    }
  }
  out.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  return out;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getStalledPrs(deps: StalledPrsDeps = {}): Promise<StalledPrsResult> {
  const listPrs = deps.listOpenPrs ?? listOpenPrs;
  const listRequired =
    deps.listRequiredStatusContextsOrNull ?? listRequiredStatusContextsOrNull;
  const repo = deps.githubRepo;

  // Async wrappers so a synchronous throw from an injected dep settles too.
  const [prsR, reqR] = await Promise.allSettled([
    (async () => listPrs({ repo, fields: STALLED_PR_FIELDS }))(),
    (async () => listRequired("stalled-prs/required-contexts", { repo }))(),
  ]);

  const sourceErrors: string[] = [];
  let rows: PrRow[] = [];
  const prs = settledOr(prsR, null, "stalled-prs/pr-list");
  if (prs === null) {
    sourceErrors.push("pr-list");
  } else if (isIssueReadFailure(prs)) {
    console.error(`[stalled-prs] gh pr list failed (${prs.code})`);
    sourceErrors.push("pr-list");
  } else {
    rows = prs.rows;
  }

  const requiredList = settledOr(reqR, null, "stalled-prs/required-contexts");
  if (requiredList === null) sourceErrors.push("required-contexts");
  const required = requiredList === null ? null : new Set(requiredList);

  return {
    items: classifyStalledPrs(rows, required),
    scanned: rows.length,
    sourcesOk: sourceErrors.length === 0,
    sourceErrors,
  };
}
