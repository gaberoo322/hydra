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
 * The per-context latest-wins collapse and the green / pending / red /
 * cancelled classification live in `src/github/check-rollup.ts` (epic #5086).
 * This module owns only the feed-lane policy {@link isFailedRequiredStatus};
 * stuck-items' `selectPrsWithFailedCi` imports it rather than keeping a copy.
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
import { foldRollup, type RollupStatus } from "../github/check-rollup.ts";
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
// Pure classifier helpers — feed-lane policy over the shared rollup fold
// ---------------------------------------------------------------------------

/**
 * The feed lane's "failed" posture over the shared fold's four-way status:
 * red OR cancelled. A cancelled required check still blocks the PR (and has
 * always produced a `failed-required` row), so it admits here. `pending` —
 * including a required context absent from the rollup — never admits.
 * stuck-items imports this so the posture has exactly one definition.
 */
export function isFailedRequiredStatus(status: RollupStatus): boolean {
  return status === "red" || status === "cancelled";
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
    if (required === null || required.size === 0) continue;

    const fold = foldRollup(pr.statusCheckRollup, { required: [...required] });
    const failed: string[] = [];
    let green = 0;
    for (const [ctx, { status }] of fold.contexts) {
      if (isFailedRequiredStatus(status)) failed.push(ctx);
      else if (status === "green") green++;
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
// Public entrypoint (empty/null required set => UNKNOWN)
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
  // An empty set is UNKNOWN too: "every required context is green" would be
  // vacuously true and admit every unarmed MERGEABLE PR as unshepherded.
  if (requiredList === null || requiredList.length === 0) sourceErrors.push("required-contexts");
  const required =
    requiredList === null || requiredList.length === 0 ? null : new Set(requiredList);

  return {
    items: classifyStalledPrs(rows, required),
    scanned: rows.length,
    sourcesOk: sourceErrors.length === 0,
    sourceErrors,
  };
}
