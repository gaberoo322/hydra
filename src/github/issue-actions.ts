/**
 * github/issue-actions — the /work page's issue-lifecycle write + verify
 * surface (issue #4010, ADR-0034 §7).
 *
 * `src/github/issues.ts` is the Read seam plus exactly ONE narrow write
 * (`addIssueLabel`, issue #3755) whose doc comment explicitly forbids adding
 * "remove-label / comment / state-mutate / create" THERE — to keep the
 * sweep-facing surface minimal. The /work page's issue-lifecycle actions
 * (promote / relabel / close / reopen) need exactly those primitives, so they
 * live in this NEW sibling leaf instead, per the approved design concept for
 * issue #4010 (INV-7/INV-8): all writes are `gh issue` subcommands routed
 * through the Adapter's `ghExec` write primitive — never `gh pr edit`
 * (documented broken for labels on this repo, ADR-0034 §7) and never a
 * hand-rolled `gh api` REST call duplicating the already-proven command
 * shapes.
 *
 * ADR-0034 §7's trust contract applied to writes — "no action may render
 * success it has not verified" — needs a single-issue READ too, so this leaf
 * also owns {@link viewIssueRow}: the post-write re-read every action performs
 * before the dashboard may report success.
 *
 * Every function here mirrors `addIssueLabel`'s contract: an injectable
 * transport (tests never spawn a real `gh`), a discriminated
 * `IssueActionWriteResult` that NEVER throws, and the seam's machine-readable
 * `gh-*` failure codes so callers discriminate on `code`, not stderr prose.
 */

import { ghExec, ghJson } from "./gh.ts";
import {
  isGhFailure,
  type GhErrorCode,
  type GhExecOptions,
  type GhResult,
} from "./exec.ts";
import { parseIssueRows, resolveGithubRepo, type IssueRow } from "./issues.ts";

// ---------------------------------------------------------------------------
// Result + transport shapes — mirrored from issues.ts's label-write path
// ---------------------------------------------------------------------------

/**
 * The discriminated result every write here returns — structurally identical
 * to `issues.ts`'s `IssueLabelWriteResult`. NEVER thrown; the caller (the
 * /work action routes) decides how to report a failure.
 */
export type IssueActionWriteResult =
  | { ok: true }
  | { ok: false; code: GhErrorCode; stderr: string };

/** The transport a write rides on — same shape as `issues.ts`'s label transport. */
export type IssueActionTransport = (
  args: string[],
  opts: GhExecOptions,
) => Promise<GhResult<{ stdout: string; stderr: string }>>;

/** Per-call knobs, mirroring `AddIssueLabelOptions` (repo override + dials + transport). */
export type IssueActionOptions = {
  /** Repo override — resolves through {@link resolveGithubRepo} like every seam reader. */
  repo?: string;
  /** Per-call timeout (ms). Defaults to the seam's 10_000. */
  timeout?: number;
  /** Per-call stdout cap (bytes). Defaults to the seam's 4MB. */
  maxBuffer?: number;
  /** Write transport. Defaults to the Adapter's real {@link ghExec}. */
  transport?: IssueActionTransport;
};

function actionExecOpts(opts: IssueActionOptions): GhExecOptions {
  return {
    timeout: opts.timeout ?? 10_000,
    maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Remove ONE label from ONE issue — `gh issue edit <n> --remove-label <label>`
 * (the sibling of `issues.ts`'s `--add-label` command; same binary, same
 * argv family, deliberately NOT bolted onto that file — issue #3755).
 * Never throws; returns the discriminated {@link IssueActionWriteResult}.
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
    actionExecOpts(opts),
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true };
}

/**
 * Close ONE issue — `gh issue close <n>` (the canonical state-mutate
 * subcommand; `gh issue edit` has no close form). Never throws.
 */
export async function closeIssue(
  issueNumber: number,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueActionTransport = opts.transport ?? ghExec;
  const res = await transport(
    ["issue", "close", String(issueNumber), "--repo", repo],
    actionExecOpts(opts),
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true };
}

/**
 * Reopen ONE issue — `gh issue reopen <n>`. Never throws.
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
    actionExecOpts(opts),
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The post-write verification read
// ---------------------------------------------------------------------------

/** The transport the verification read rides on — a `ghJson`-shaped reader. */
export type IssueViewTransport = (
  args: string[],
  opts: GhExecOptions,
) => Promise<GhResult<unknown>>;

/**
 * Read ONE issue as an {@link IssueRow} — `gh issue view <n> --json …`,
 * parsed through the seam's existing `parseIssueRows` (defensive, normalized,
 * one spelling of the issue shape). Returns `null` on ANY failure (transport
 * failure, malformed JSON, dropped row) — mirroring `viewPr`'s null contract;
 * callers treat null as "could not verify", never as an asserted empty state.
 * Never throws.
 */
export async function viewIssueRow(
  issueNumber: number,
  opts: Omit<IssueActionOptions, "transport"> & {
    /** Read transport. Defaults to the Adapter's real {@link ghJson}. */
    readTransport?: IssueViewTransport;
  } = {},
): Promise<IssueRow | null> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return null;
  const read: IssueViewTransport = opts.readTransport ?? ghJson;
  const res = await read(
    [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "number,title,url,createdAt,labels,body,state,updatedAt",
    ],
    actionExecOpts(opts),
  );
  if (isGhFailure(res)) return null;
  const rows = parseIssueRows([res.data], repo);
  return rows.length === 1 ? rows[0] : null;
}
