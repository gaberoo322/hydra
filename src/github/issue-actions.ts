/**
 * github/issue-actions.ts — the issue-lifecycle WRITE leaf (issue #4010,
 * ADR-0034 §7, design-concept `hydra:design-concept:issue-4010`).
 *
 * `src/github/issues.ts` deliberately forbids issue mutation beyond its ONE
 * narrow label-add ({@link addIssueLabel}, issue #3755: "do NOT add
 * remove-label / comment / state-mutate / create here"). The /work page's
 * issue-lifecycle actions (relabel, close, reopen — issue #4010) need exactly
 * the primitives that file refuses to grow, so they live HERE, in a sibling
 * leaf inside the `src/github/` child-process fence, one layer under the
 * POST action routes on `src/api/autopilot-board.ts`.
 *
 * # Command-shape contract (ADR-0034 §7, design-concept invariant 7)
 *
 * Every write rides the `gh issue …` CLI family through the Adapter's
 * {@link ghExec} primitive — the already-proven command shape
 * {@link addIssueLabel} uses (`gh issue edit <n> --add-label <l>`):
 *
 *   - removeIssueLabel → `gh issue edit <n> --remove-label <l>`
 *   - closeIssue       → `gh issue close <n>`
 *   - reopenIssue      → `gh issue reopen <n>`
 *
 * NEVER `gh pr edit` (documented broken for labels on this repo) and NEVER a
 * hand-rolled `gh api repos/.../labels` call duplicating the proven command
 * (`gh api` is reserved for the PR-label case /runs hits later). Label ADDS
 * stay on `issues.ts`'s {@link addIssueLabel} — this leaf does not re-implement
 * them, it composes them.
 *
 * # Post-write verification read (design-concept invariant 6)
 *
 * Every /work action must re-read the issue's ACTUAL post-write state before
 * the UI reports success — "no action renders success it has not verified".
 * {@link viewIssueState} is that read-back: one `gh issue view --json` fetch
 * of the identity/labels/state fields, shaped defensively like the read seam
 * parses its list rows.
 *
 * # Never throws (CLAUDE.md)
 *
 * Same posture as the rest of the seam: every function returns a typed
 * discriminated result and NEVER throws; a non-zero exit / spawn failure /
 * timeout maps to the seam's machine-readable `gh-*` `code` so callers
 * discriminate on the code, not stderr prose. Transports are injectable so
 * tests pin the argv + result mapping without spawning a real `gh`.
 */

import { ghExec, ghJson } from "./gh.ts";
import {
  resolveGithubRepo,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  type IssueQueryOptions,
  type IssueLabelTransport,
  type IssueLabelWriteResult,
} from "./issues.ts";
import {
  isGhFailure,
  type GhErrorCode,
  type GhExecOptions,
  type GhResult,
} from "./exec.ts";

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

/**
 * Per-call knobs for every primitive here. Reuses {@link IssueQueryOptions}
 * (repo override + timeout/maxBuffer dials) and adds the injectable write
 * {@link IssueActionTransport | transport} — the same shape as the read/write
 * helpers share, so production defaults to the real `gh` invocation while a
 * test injects a fake that records the argv WITHOUT spawning a process.
 */
export type IssueActionOptions = IssueQueryOptions & {
  transport?: IssueLabelTransport;
};

/**
 * The discriminated result every write primitive returns — structurally the
 * label-write result {@link addIssueLabel} already defined (issue #3755):
 * `ok:true` confirms the write; `ok:false` carries the seam's
 * machine-readable `gh-*` `code` plus `stderr` for logging. NEVER thrown.
 */
export type IssueActionWriteResult = IssueLabelWriteResult;

/**
 * The transport an issue-state READ rides on. Structurally identical to the
 * Adapter's {@link ghJson} read primitive so production defaults to the real
 * `gh` invocation while a test injects a canned result.
 */
export type IssueStateReader = (
  args: string[],
  opts: GhExecOptions,
) => Promise<GhResult<unknown>>;

/** Extended options for {@link viewIssueState} — adds the injectable reader. */
export type IssueStateOptions = IssueQueryOptions & {
  reader?: IssueStateReader;
};

/**
 * The post-write verification snapshot: exactly the fields an action's
 * verified result needs (identity + labels + state), defensively normalised
 * like the read seam's `IssueRow` (missing labels flatten to `[]`, a missing
 * title/url synthesise from the number, a missing state defaults to OPEN).
 * Carries the issue BODY too — the promote route's guard read needs it for
 * the Files-in-scope + strict-blocker checks (issue #4010); the queue rows
 * the GET strips it back out of.
 */
export interface IssueStateSnapshot {
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: string;
  body: string;
}

/**
 * The discriminated result {@link viewIssueState} returns: the snapshot on
 * success, the seam's `gh-*` `code` + `stderr` on failure. NEVER thrown —
 * the route decides how to report an unverifiable read.
 */
export type IssueStateResult =
  | { ok: true; data: IssueStateSnapshot }
  | { ok: false; code: GhErrorCode; stderr: string };

/**
 * Type guard narrowing an {@link IssueStateResult} to its failure arm. The
 * orchestrator's `tsconfig.json` runs `strict: false` (no
 * `strictNullChecks`), so a boolean `ok` does not narrow via plain
 * `if (!res.ok)` — see `isIssueReadFailure`'s rationale in `issues.ts`.
 */
export function isIssueStateFailure(
  res: IssueStateResult,
): res is { ok: false; code: GhErrorCode; stderr: string } {
  return res.ok === false;
}

// ---------------------------------------------------------------------------
// Write primitives
// ---------------------------------------------------------------------------

/**
 * Remove ONE label from ONE issue — `gh issue edit <n> --remove-label <l>`.
 *
 * The relabel lane-move on /work composes this with `issues.ts`'s
 * {@link addIssueLabel}: remove the issue's current lane label, add the
 * target one. Runs through the Adapter's {@link ghExec} write primitive (a
 * label-remove succeeds with no structured output to parse), never throws,
 * and returns the discriminated {@link IssueActionWriteResult}.
 */
export async function removeIssueLabel(
  issueNumber: number,
  label: string,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueLabelTransport = opts.transport ?? ghExec;
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
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true };
}

/**
 * Close ONE issue — `gh issue close <n>`. An immediate-tier /work action
 * (ADR-0034 §7: no confirm step); the verified result the UI reports comes
 * from the {@link viewIssueState} read-back the route performs afterwards.
 */
export async function closeIssue(
  issueNumber: number,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueLabelTransport = opts.transport ?? ghExec;
  const res = await transport(
    ["issue", "close", String(issueNumber), "--repo", repo],
    execOpts(opts),
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true };
}

/**
 * Reopen ONE issue — `gh issue reopen <n>`. Immediate-tier like
 * {@link closeIssue}; the post-write {@link viewIssueState} read-back is what
 * lets the UI assert `state: "OPEN"` rather than trusting the write's exit
 * code alone.
 */
export async function reopenIssue(
  issueNumber: number,
  opts: IssueActionOptions = {},
): Promise<IssueActionWriteResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) return { ok: true };
  const transport: IssueLabelTransport = opts.transport ?? ghExec;
  const res = await transport(
    ["issue", "reopen", String(issueNumber), "--repo", repo],
    execOpts(opts),
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Post-write verification read
// ---------------------------------------------------------------------------

/** `--json` field set the verification read fetches — identity + labels + state + body. */
const ISSUE_STATE_FIELDS = "number,title,url,labels,state,body";

/**
 * Read ONE issue's current identity/labels/state — `gh issue view <n>
 * --json number,title,url,labels,state`. This is the post-write verification
 * read every /work action performs before the UI reports success
 * (design-concept invariant 6), and the pre-write guard read the promote
 * route performs (issue body for the Files-in-scope + blocker checks).
 *
 * Never throws: returns the discriminated {@link IssueStateResult}. The
 * reader is injectable (defaults to the Adapter's {@link ghJson}) so tests
 * pin the argv + parse without a live `gh`.
 */
export async function viewIssueState(
  issueNumber: number,
  opts: IssueStateOptions = {},
): Promise<IssueStateResult> {
  const repo = resolveGithubRepo(opts.repo);
  if (!repo) {
    // Mirror the seam's empty-repo skip-guard: an explicit empty-string
    // override means "skip this call". There is no honest snapshot to return,
    // so it surfaces as a failure the caller can distinguish.
    return { ok: false, code: "gh-empty", stderr: "empty repo handle — call skipped" };
  }
  const reader: IssueStateReader = opts.reader ?? ghJson;
  const res = await reader(
    [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      ISSUE_STATE_FIELDS,
    ],
    execOpts(opts),
  );
  if (isGhFailure(res)) {
    return { ok: false, code: res.code, stderr: res.stderr };
  }
  return { ok: true, data: parseIssueState(res.data, issueNumber) };
}

/**
 * Defensively normalise a `gh issue view --json` payload into an
 * {@link IssueStateSnapshot}. Absent fields normalise the same way the read
 * seam's `parseIssueRows` normalises list rows (labels flattened to
 * `string[]`, title/url synthesised from the number, state defaulted OPEN) —
 * a malformed payload degrades to defaults, never a throw.
 */
function parseIssueState(raw: unknown, requested: number): IssueStateSnapshot {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const number = typeof obj.number === "number" && Number.isFinite(obj.number)
    ? obj.number
    : requested;
  const rawLabels = Array.isArray(obj.labels) ? obj.labels : [];
  const labels = rawLabels
    .map((l: any) =>
      typeof l === "string" ? l : l && typeof l === "object" && typeof l.name === "string" ? l.name : null,
    )
    .filter((l: string | null): l is string => typeof l === "string");
  return {
    number,
    title: typeof obj.title === "string" && obj.title.length > 0
      ? obj.title
      : `Issue #${number}`,
    url: typeof obj.url === "string" && obj.url.length > 0
      ? obj.url
      : `https://github.com/gaberoo322/hydra/issues/${number}`,
    labels,
    state: typeof obj.state === "string" && obj.state.length > 0
      ? obj.state.toUpperCase()
      : "OPEN",
    body: typeof obj.body === "string" ? obj.body : "",
  };
}

/** Shared exec-options projection — the dials `issues.ts`'s helpers share. */
function execOpts(opts: IssueQueryOptions): GhExecOptions {
  return {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  };
}
