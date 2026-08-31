/**
 * github/issue-actions — the /work page's issue-lifecycle write primitives
 * (issue #4010, ADR-0034 §2/§7).
 *
 * `src/github/issues.ts` owns the ONE narrow sweep-facing mutation surface —
 * {@link addIssueLabel} — and its own doc comment explicitly forbids growing it
 * (issue #3755: "do NOT add remove-label / comment / state-mutate / create
 * here"). The dashboard's /work page nevertheless needs the full issue-lifecycle
 * action set ADR-0034 §2 assigns it — relabel, close/reopen — plus the
 * post-write re-read its §7 trust rule demands ("no action may render success
 * it has not verified"). Those primitives live HERE, in a sibling leaf, leaving
 * `issues.ts` byte-identical at its documented minimal surface.
 *
 * Every write routes through the `gh issue …` CLI family on the Adapter's
 * {@link ghExec} write primitive — exactly the seam `addIssueLabel` already
 * rides. NEVER `gh pr edit` (documented broken for labels on this repo,
 * ADR-0034 §7) and never a hand-rolled `gh api …/labels` call duplicating the
 * already-proven command: label writes go through `gh issue edit
 * --add-label`/`--remove-label`, state writes through the native
 * `gh issue close` / `gh issue reopen`.
 *
 * Every accessor returns a discriminated result and NEVER throws
 * (CLAUDE.md: never throw from write/verification-adjacent paths — return a
 * result object and let the caller decide how to report).
 *
 * Like `addIssueLabel`, each write's transport is an injectable parameter
 * (defaulting to the real {@link ghExec}) so tests verify the argv + result
 * mapping without spawning a process. The one READ here ({@link viewIssue}) is
 * the verification re-read — it stays in this leaf because it exists solely to
 * serve the verify-after-write contract; the general list readers stay in
 * `issues.ts`.
 */

import { ghExec, ghJson } from "./gh.ts";
import type { GhResult, GhExecOptions, GhErrorCode } from "./exec.ts";
import {
  resolveGithubRepo,
  ISSUE_JSON_FIELDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  type IssueRow,
  type IssueQueryOptions,
} from "./issues.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * The transport an issue write rides on — structurally identical to
 * `issues.ts`'s `IssueLabelTransport` (`(args, opts) => GhResult<{stdout,
 * stderr}>`), so production defaults to the real `gh` invocation while a test
 * injects a fake that records the argv and returns a canned result WITHOUT
 * spawning a process.
 */
type IssueActionTransport = (
  args: string[],
  opts: GhExecOptions,
) => Promise<GhResult<{ stdout: string; stderr: string }>>;

/**
 * The discriminated result every issue write returns. Same shape as
 * `issues.ts`'s `IssueLabelWriteResult`: `ok:true` confirms the CLI accepted
 * the write; `ok:false` carries the seam's machine-readable `code` (a `gh-*`
 * literal) plus `stderr` for logging. NEVER thrown.
 */
export type IssueActionWriteResult =
  | { ok: true }
  | { ok: false; code: GhErrorCode; stderr: string };

/**
 * The single-issue re-read every action verifies through. `ok:false` covers
 * both CLI failures and an unparseable/numberless payload (the defensive-parse
 * miss), so a verification read NEVER fabricates a row.
 */
export type IssueViewResult =
  | { ok: true; row: IssueRow }
  | { ok: false; code: GhErrorCode };

/** Per-call knobs shared by every primitive in this leaf. */
export type IssueActionOptions = IssueQueryOptions & {
  /** Write/read transport. Defaults to the Adapter's real {@link ghExec}. */
  transport?: IssueActionTransport;
};

function execOpts(opts: IssueActionOptions) {
  return {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}

/** Map a transport/gh failure onto the shared write-result failure arm. */
function writeFailure(res: {
  ok: boolean;
  code?: GhErrorCode;
  stderr?: string;
}): IssueActionWriteResult {
  return {
    ok: false,
    code: res.code ?? "gh-failed",
    stderr: res.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Remove ONE label from ONE issue — `gh issue edit <n> --remove-label <label>`
 * (the `--remove-label` twin of `addIssueLabel`'s `--add-label`, on the same
 * proven command). Same skip-guard as `addIssueLabel`: an empty resolved repo
 * short-circuits to `{ ok: true }`.
 */
export async function removeIssueLabel(
  issueNumber: number,
  label: string,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueActionTransport = opts.transport ?? ghExec;
  const res = await transport(
    [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--remove-label",
      label,
    ],
    execOpts(opts),
  );
  if (res.ok === false) return writeFailure(res);
  return { ok: true };
}

/**
 * Close ONE issue — the native `gh issue close`, with GitHub's own optional
 * close-reason vocabulary (`--reason completed | "not planned"`, issue #4028:
 * the /work hitl-grill lane's Dismiss verdict closes `not planned`). The
 * accepted literals are constrained at the route's request schema
 * (`BOARD_CLOSE_REASONS`); this primitive stays a thin pass-through so it
 * mirrors `removeIssueLabel`'s `(number, label, opts)` argument order. No
 * comment is posted (the action's result is verified by the post-write
 * re-read, not by prose).
 */
export async function closeIssue(
  issueNumber: number,
  reason?: string,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueActionTransport = opts.transport ?? ghExec;
  const args = ["issue", "close", String(issueNumber), "--repo", repo];
  if (reason) args.push("--reason", reason);
  const res = await transport(args, execOpts(opts));
  if (res.ok === false) return writeFailure(res);
  return { ok: true };
}

/**
 * Reopen ONE issue — the native `gh issue reopen`.
 */
export async function reopenIssue(
  issueNumber: number,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueActionTransport = opts.transport ?? ghExec;
  const res = await transport(
    ["issue", "reopen", String(issueNumber), "--repo", repo],
    execOpts(opts),
  );
  if (res.ok === false) return writeFailure(res);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The verification re-read
// ---------------------------------------------------------------------------

/**
 * Re-read ONE issue's post-write state — `gh issue view <n> --json` through the
 * Adapter's {@link ghJson}, defensively parsed into an {@link IssueRow} (absent
 * fields normalised the same way `parseIssueRows` normalises them). This is the
 * read half of ADR-0034 §7's "no action may render success it has not
 * verified": the caller re-reads AFTER the write and reports the observed
 * state, never the write's exit code alone.
 *
 * Note the transport injection does not apply here — this is a READ; tests
 * stub it at the route's deps seam instead (the route injects a `view` reader).
 */
export async function viewIssue(
  issueNumber: number,
  opts: IssueQueryOptions = {},
): Promise<IssueViewResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: false, code: "gh-failed" };
  const res = await ghJson<unknown>(
    [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      opts.fields ?? ISSUE_JSON_FIELDS,
    ],
    execOpts(opts),
  );
  if (res.ok === false) return { ok: false, code: res.code };
  const row = parseSingleIssue(res.data, repo, issueNumber);
  if (row === null) return { ok: false, code: "gh-malformed-json" };
  return { ok: true, row };
}

/**
 * Defensively parse one `gh issue view --json` object into an {@link IssueRow}.
 * Mirrors `parseIssueRows`' normalisation for the single-object (non-array)
 * shape `issue view` emits. Null when the payload is not an object or carries
 * no positive integer `number` — never a fabricated row.
 */
function parseSingleIssue(
  parsed: unknown,
  repo: string,
  requestedNumber: number,
): IssueRow | null {
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    createdAt?: unknown;
    labels?: Array<{ name?: unknown }>;
    body?: unknown;
    state?: unknown;
    updatedAt?: unknown;
  };
  const number =
    typeof c.number === "number" && Number.isFinite(c.number) && c.number > 0
      ? c.number
      : requestedNumber;
  return {
    number,
    title: typeof c.title === "string" ? c.title : `Issue #${number}`,
    url:
      typeof c.url === "string" ? c.url : `https://github.com/${repo}/issues/${number}`,
    createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
    labels: (c.labels ?? [])
      .map((l) => (typeof l?.name === "string" ? l.name : ""))
      .filter((name) => name.length > 0),
    body: typeof c.body === "string" ? c.body : "",
    state: typeof c.state === "string" ? c.state.toUpperCase() : "",
  };
}
