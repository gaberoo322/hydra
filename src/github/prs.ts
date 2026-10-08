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

import { ghExec, ghJson } from "./gh.ts";
import {
  isGhFailure,
  type GhErrorCode,
  type GhExecOptions,
  type GhResult,
} from "./exec.ts";
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
  /**
   * PR body, populated only when the caller requested `body` (issue #4686 —
   * the GLM pick phase reads closing keywords out of open/merged PR bodies).
   * Absent otherwise, so existing consumers see no new field.
   */
  body?: string;
  /**
   * Upper-cased mergeability (`MERGEABLE` / `CONFLICTING` / `UNKNOWN`),
   * populated only when the caller requested `mergeable` in its field set
   * (issue #4624 — the stalled-PRs aggregator); `""` otherwise. Optional in the
   * type so hand-built rows need not spell it; {@link parsePrRows} always sets it.
   */
  mergeable?: string;
  /** `isDraft` when requested; `null` when not requested (issue #4624). */
  isDraft?: boolean | null;
  /**
   * Whether auto-merge is armed: `true` when `autoMergeRequest` is an object,
   * `false` when it was requested and is `null`, `null` when not requested
   * (issue #4624).
   */
  autoMergeArmed?: boolean | null;
  /**
   * Raw status-check rollup entries; the caller decides which conclusions count
   * as failing. The rollup mixes two GraphQL shapes: a CheckRun carries
   * `name` / `conclusion` / `status`, a StatusContext carries `context` /
   * `state`. Timestamps (`completedAt` / `startedAt`) let a caller collapse
   * duplicate reruns to the latest entry (issue #4624).
   */
  statusCheckRollup: Array<{
    conclusion?: string;
    name?: string;
    context?: string;
    state?: string;
    status?: string;
    completedAt?: string;
    startedAt?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Pure parser — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parse a `gh pr list --json` payload into {@link PrRow}s. Rows without a
 * positive integer `number` are dropped; `statusCheckRollup` is normalized to
 * an array of `{conclusion,name,context,state,status,completedAt,startedAt}`.
 * `mergeable` / `isDraft` / `autoMergeArmed` default to `""` / `null` / `null`
 * when not requested (issue #4624). Never throws.
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
      body?: unknown;
      mergeable?: unknown;
      isDraft?: unknown;
      autoMergeRequest?: unknown;
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
        state: typeof r.state === "string" ? r.state : undefined,
        status: typeof r.status === "string" ? r.status : undefined,
        completedAt: typeof r.completedAt === "string" ? r.completedAt : undefined,
        startedAt: typeof r.startedAt === "string" ? r.startedAt : undefined,
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
      // Issue #4624: additive, requested only via a per-caller fields override.
      mergeable: typeof c.mergeable === "string" ? c.mergeable.toUpperCase() : "",
      isDraft: typeof c.isDraft === "boolean" ? c.isDraft : null,
      autoMergeArmed:
        !("autoMergeRequest" in c)
          ? null
          : c.autoMergeRequest !== null && typeof c.autoMergeRequest === "object",
      ...(typeof c.body === "string" ? { body: c.body } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The list query — read through the Adapter's ghJson
// ---------------------------------------------------------------------------

function execOpts(opts: Omit<IssueQueryOptions, "state">) {
  return {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

/**
 * {@link IssueQueryOptions} with the `--state` union widened to the values
 * `gh pr list` accepts (`merged` is PR-only; issue #4686 reads MERGED PRs for
 * the drainer's shipped-work skip).
 */
export type PrQueryOptions = Omit<IssueQueryOptions, "state"> & {
  state?: "open" | "closed" | "merged" | "all";
};

/**
 * List PRs (open by default) with their CI status rollup. Never throws —
 * returns the discriminated {@link IssueReadResult} of {@link PrRow}.
 */
export async function listOpenPrs(
  opts: PrQueryOptions = {},
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

// ---------------------------------------------------------------------------
// PR create — the write primitive the GLM finish phase rides (issue #4685)
// ---------------------------------------------------------------------------

/**
 * The injectable transport `createPr` rides — structurally identical to
 * `issue-actions.ts`'s `IssueActionTransport` (`(args, opts) => GhResult<
 * {stdout, stderr}>`), so production defaults to the real `gh` invocation
 * while a test injects a fake that records the argv WITHOUT spawning a
 * process (ADR-0040 Decision 2).
 */
export type PrActionTransport = (
  args: string[],
  opts: GhExecOptions,
) => Promise<GhResult<{ stdout: string; stderr: string }>>;

/** The one shape of PR `createPr` opens — the drainer's provenance-labelled PR. */
export interface CreatePrInput {
  /** Base branch (the drainer always uses `master`). */
  base: string;
  /** Head branch (the per-tick `worktree-agent-glm-<issue>-<ts>` branch). */
  head: string;
  title: string;
  /** Path whose CONTENT becomes the PR body (`--body-file`). */
  bodyFile: string;
  /** The provenance label (`glm-authored`, ADR-0032 Decision 5). */
  label: string;
}

/** Discriminated create result — the URL is `gh pr create`'s last stdout line. */
export type PrCreateResult =
  | { ok: true; url: string }
  | { ok: false; code: GhErrorCode; stderr: string };

/**
 * `gh pr create --repo R --base <base> --head <head> --title <title>
 * --body-file <bodyFile> --label <label>` — the exact argv the drainer's bash
 * `open_pr()` issued (issue #4685). Never throws. The ADOPT-on-collision
 * policy deliberately does NOT live here: `createPr` reports the raw failure
 * and the caller (`src/glm/finish.ts`) decides by LISTING open PRs for the
 * head branch, never by parsing the error text (issue #3900).
 */
export async function createPr(
  input: CreatePrInput,
  opts: IssueQueryOptions & { transport?: PrActionTransport } = {},
): Promise<PrCreateResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: false, code: "gh-failed", stderr: "no repo resolved" };
  const transport: PrActionTransport = opts.transport ?? ghExec;
  const args = [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    input.base,
    "--head",
    input.head,
    "--title",
    input.title,
    "--body-file",
    input.bodyFile,
    "--label",
    input.label,
  ];
  const res = await transport(args, {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
  if (res.ok === false) {
    return { ok: false, code: res.code ?? "gh-failed", stderr: res.stderr ?? "" };
  }
  const lines = res.data.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { ok: true, url: lines.length > 0 ? lines[lines.length - 1] : "" };
}

// ---------------------------------------------------------------------------
// Required status contexts — read from branch protection (issue #4569)
// ---------------------------------------------------------------------------

/** The protected branch whose required contexts gate a merge. */
const DEFAULT_PROTECTED_BRANCH = "master";

/**
 * Pure helper — exported for tests. Lifts `contexts` out of a
 * `branches/<b>/protection/required_status_checks` payload.
 *
 * A genuinely malformed/missing payload (not an object, or no `contexts` key
 * at all) is `null` (UNKNOWN): an invented empty set would silently classify
 * every failing check as non-required. But a well-formed response where
 * `contexts` is legitimately `null` (check-run-based protection, no legacy
 * status contexts) is a **known empty set**, not UNKNOWN — matching the
 * `collect-state.sh` #4460 precedent (`null` or `[]` = healthy empty set) —
 * so it resolves to `[]`, not `null`.
 */
export function parseRequiredStatusContexts(parsed: unknown): string[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  if (!("contexts" in parsed)) return null;
  const contexts = (parsed as { contexts?: unknown }).contexts;
  if (contexts === null) return [];
  if (!Array.isArray(contexts)) return null;
  return contexts.filter((c): c is string => typeof c === "string" && c.length > 0);
}

/**
 * The status contexts branch protection REQUIRES on the protected branch, or
 * `null` when they cannot be read. Required-ness is read, never guessed or
 * hardcoded — `gh pr list`'s `statusCheckRollup` reports `isRequired: null`
 * (the #4460 collect-state precedent). Never throws; logs on failure.
 */
export async function listRequiredStatusContextsOrNull(
  logPrefix: string,
  opts: IssueQueryOptions & { branch?: string } = {},
): Promise<string[] | null> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return null;
  const branch = opts.branch ?? DEFAULT_PROTECTED_BRANCH;
  const res = await ghJson<unknown>(
    ["api", `repos/${repo}/branches/${branch}/protection/required_status_checks`],
    execOpts(opts),
  );
  if (isGhFailure(res)) {
    console.error(`[${logPrefix}] required-status-contexts read failed (${res.code})`);
    return null;
  }
  const contexts = parseRequiredStatusContexts(res.data);
  if (contexts === null) {
    console.error(`[${logPrefix}] required-status-contexts payload malformed`);
  }
  return contexts;
}
