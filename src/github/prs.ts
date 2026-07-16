/**
 * github/prs.ts — the PR-list **Read** surface, extracted out of the GitHub
 * Issue/PR Read seam (`issues.ts`, issue #908) by architecture-scan issue #3370.
 *
 * `issues.ts` is the *domain-read* seam: it owns the repo handle
 * ({@link resolveGithubRepo}), the shared discriminated result type
 * ({@link IssueReadResult} / {@link isIssueReadFailure}), and the issue-list
 * surface (`IssueRow`, `parseIssueRows`, `ISSUE_JSON_FIELDS`,
 * `listIssuesByLabel`, `listIssuesBySearch`, `listOpenIssues`).
 *
 * The **PR-list surface** — `PrRow`, `parsePrRows`, `PR_LIST_JSON_FIELDS`,
 * `listOpenPrs`, `listOpenPrsOrEmpty` — serves a different set of consumers (the
 * PR Lifecycle Bridge in `src/autopilot/pr-lifecycle-bridge.ts`, the lifecycle
 * snapshot projection, and the stuck-items aggregator) and evolves on a distinct
 * change axis (CI-rollup + head-branch fields for OPEN PRs, not board-query
 * metadata). Co-locating it inside the 504-line issue-read module meant reading
 * the whole file to understand either consumer. This module concentrates the
 * PR-list change/bug surface in one focused home, mirroring the `view-pr.ts`
 * extraction precedent (#2224).
 *
 * # Import back-edge (no runtime cycle)
 *
 * This module imports {@link resolveGithubRepo} (a runtime value) and the shared
 * result type/guard ({@link IssueReadResult} / {@link isIssueReadFailure}) back
 * from `issues.ts`, which in turn re-exports this module's symbols via
 * `export ... from "./prs.ts"`. The ESM cycle is benign: `resolveGithubRepo` is
 * referenced only at *call* time (inside {@link listOpenPrs}), never at
 * module-eval time, and `issues.ts` re-exports via `export ... from` (a pure
 * re-export with no eager runtime reference). Unlike the `view-pr.ts` extraction
 * — whose `viewPr` wrapper called `resolveGithubRepo` eagerly across the
 * boundary and so needed a `resolveRepo` injection — {@link listOpenPrs}'s public
 * signature stays byte-for-byte identical (verified against issue #3370's
 * approved design concept).
 *
 * # Never throws (CLAUDE.md)
 *
 * Like the `issues.ts`/`gh.ts` readers it consumes, {@link listOpenPrs} returns
 * the discriminated {@link IssueReadResult}<{@link PrRow}> and NEVER throws;
 * {@link listOpenPrsOrEmpty} folds the failure arm into `[]` after logging the
 * code — the contract the `Promise.allSettled` aggregators expect.
 *
 * # Public surface unchanged
 *
 * `PrRow`, `parsePrRows`, `listOpenPrs`, and `listOpenPrsOrEmpty` are still
 * importable from `../github/issues.ts` (which re-exports them from here), so the
 * existing consumers (`pr-lifecycle-bridge.ts`, `pr-lifecycle-snapshot.ts`,
 * `stuck-items.ts`) and the test surface are unchanged by the move.
 */

import { ghJson } from "./gh.ts";
import { isGhFailure } from "./exec.ts";
import {
  resolveGithubRepo,
  isIssueReadFailure,
  type IssueReadResult,
  type IssueQueryOptions,
  DEFAULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
} from "./issues.ts";

// ---------------------------------------------------------------------------
// The canonical PR-list field set + typed return shape
// ---------------------------------------------------------------------------

/**
 * The canonical open-PR list `--json` field set. Covers BOTH consumer shapes:
 *   - the CI-rollup view (`updatedAt`, `statusCheckRollup`) the merge-queue
 *     readers need, and
 *   - the lifecycle view (`state`, `headRefName`, `createdAt`) the PR Lifecycle
 *     Bridge (`src/autopilot/pr-lifecycle-bridge.ts`, issue #673) needs to diff
 *     OPEN→MERGED/CLOSED transitions and attribute an event to a head branch.
 * Over-fetching a handful of small fields is cheaper than maintaining two
 * divergent field lists — the same posture `ISSUE_JSON_FIELDS` takes.
 */
export const PR_LIST_JSON_FIELDS =
  "number,state,title,url,headRefName,createdAt,updatedAt,statusCheckRollup";

/** One open PR as the read seam returns it, including its CI status rollup. */
export interface PrRow {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  /**
   * Upper-cased PR state (`OPEN` / `MERGED` / `CLOSED`), populated when the
   * caller requested `state` in its `--json` field set. Defaults to `OPEN` when
   * the field is present-but-unrecognized, and `""` when not requested at all.
   * Consumed by the PR Lifecycle Bridge (issue #673) to diff state transitions.
   */
  state: string;
  /**
   * Head-branch name, populated only when the caller requested `headRefName`.
   * The lifecycle bridge extracts the dispatch task_id from it; `""` otherwise.
   */
  headRefName: string;
  /**
   * ISO-8601 created timestamp, populated only when the caller requested
   * `createdAt`; `""` otherwise.
   */
  createdAt: string;
  /** Raw status-check rollup entries; the caller decides which conclusions count as failing. */
  statusCheckRollup: Array<{
    conclusion?: string;
    name?: string;
    context?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Pure parser — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parse a `gh pr list --json` payload into {@link PrRow}s. Rows without a
 * positive integer `number` are dropped; `statusCheckRollup` is normalized to
 * an array of `{conclusion,name,context}`. Never throws.
 */
export function parsePrRows(parsed: unknown, repo: string): PrRow[] {
  if (!Array.isArray(parsed)) return [];
  const out: PrRow[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      state?: unknown;
      title?: unknown;
      url?: unknown;
      headRefName?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      statusCheckRollup?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const rollupRaw = Array.isArray(c.statusCheckRollup) ? c.statusCheckRollup : [];
    const statusCheckRollup = rollupRaw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        conclusion: typeof r.conclusion === "string" ? r.conclusion : undefined,
        name: typeof r.name === "string" ? r.name : undefined,
        context: typeof r.context === "string" ? r.context : undefined,
      }));
    out.push({
      number,
      // State requested → upper-cased; absent → "" (the lifecycle bridge maps
      // an unrecognized-but-present value to OPEN at its own layer).
      state: typeof c.state === "string" ? c.state.toUpperCase() : "",
      title: typeof c.title === "string" ? c.title : `PR #${number}`,
      url:
        typeof c.url === "string"
          ? c.url
          : `https://github.com/${repo}/pull/${number}`,
      headRefName: typeof c.headRefName === "string" ? c.headRefName : "",
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
      statusCheckRollup,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The list query — read through the Adapter's ghJson
// ---------------------------------------------------------------------------

function execOpts(opts: IssueQueryOptions) {
  return {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

/**
 * List open PRs with their CI status rollup. Never throws — returns the
 * discriminated {@link IssueReadResult} of {@link PrRow}.
 */
export async function listOpenPrs(
  opts: IssueQueryOptions = {},
): Promise<IssueReadResult<PrRow>> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true, rows: [] };
  const args = [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    opts.state ?? "open",
    "--limit",
    String(opts.limit ?? DEFAULT_LIMIT),
    "--json",
    opts.fields ?? PR_LIST_JSON_FIELDS,
  ];
  const res = await ghJson<unknown>(args, execOpts(opts));
  if (isGhFailure(res)) return { ok: false, code: res.code };
  return { ok: true, rows: parsePrRows(res.data, repo) };
}

/** Like {@link listOpenPrs} but degrades to `[]` after logging. */
export async function listOpenPrsOrEmpty(
  logPrefix: string,
  opts: IssueQueryOptions = {},
): Promise<PrRow[]> {
  const res = await listOpenPrs(opts);
  if (isIssueReadFailure(res)) {
    console.error(`[${logPrefix}] gh pr list failed (${res.code})`);
    return [];
  }
  return res.rows;
}
