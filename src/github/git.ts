/**
 * github/git.ts — the `git` adapter of the **GitHub CLI Adapter** seam (issue #896).
 *
 * Sibling to `gh.ts`, split by external interface (`git` is a different binary
 * with its own argv alphabet) but riding the SAME private spawn primitive in
 * `exec.ts`. No raw `child_process` leaks past this module.
 *
 * Every accessor returns a discriminated `GhResult<T>` and NEVER throws
 * (CLAUDE.md). The `gh-*` failure codes are shared with `gh.ts` — they describe
 * the external-process boundary, not the specific binary — and are result-object
 * literals on the `HydraErrorCode` union, never thrown subclasses.
 *
 * Note on the `HYDRA_GIT_BIN` override: symmetric with `HYDRA_GH_BIN`, it lets
 * tests stub `git` the same way the escalation test stubs `gh`. Production falls
 * back to `git` on PATH.
 */

import {
  gitBin,
  runExec,
  classifyFailure,
  isGhFailure,
  type GhResult,
  type GhExecOptions,
} from "./exec.ts";

/**
 * Run an arbitrary `git` argv and return its trimmed stdout on success.
 *
 * The orchestrator's `git` callers are read-shaped (`git rev-parse`,
 * `git log`, `git diff --name-only`, ...) — they want stdout, not a structured
 * parse. On a non-zero exit / spawn failure / timeout the result is the failure
 * arm with a machine-readable `code`.
 *
 * @param args — the `git` argv WITHOUT the leading `git` (e.g. `["rev-parse","HEAD"]`).
 */
export async function gitExec(
  args: string[],
  opts: GhExecOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  const raw = await runExec(gitBin(), args, opts);
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode) {
    return { ok: true, data: { stdout: raw.stdout, stderr: raw.stderr } };
  }
  const code = classifyFailure(raw);
  console.error(
    `[github/git] git ${args.join(" ")} failed (${code}): ${raw.stderr.slice(0, 300)}`,
  );
  return { ok: false, code, stderr: raw.stderr };
}

/** One `git ls-remote --heads` row. */
export interface RemoteHead {
  sha: string;
  /** Short branch name (the `refs/heads/` prefix stripped). */
  branch: string;
}

/**
 * Parse `git ls-remote --heads` stdout (`<sha>\t<ref>` lines) into
 * {@link RemoteHead}s. Pure; malformed lines are dropped.
 */
export function parseLsRemoteHeads(stdout: string): RemoteHead[] {
  const out: RemoteHead[] = [];
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || !ref.startsWith("refs/heads/")) continue;
    out.push({ sha, branch: ref.slice("refs/heads/".length) });
  }
  return out;
}

/**
 * `git ls-remote --heads origin <pattern>` (issue #4686 — the GLM pick phase's
 * resumable-branch listing). Never throws; a failure is the `ok:false` arm.
 */
export async function lsRemoteHeads(
  pattern: string,
  opts: GhExecOptions = {},
): Promise<GhResult<RemoteHead[]>> {
  const res = await gitExec(["ls-remote", "--heads", "origin", pattern], opts);
  if (isGhFailure(res)) return res;
  return { ok: true, data: parseLsRemoteHeads(res.data.stdout) };
}

// ---------------------------------------------------------------------------
// Write-shaped git helpers (issue #4685 — the GLM finish phase's effects)
// ---------------------------------------------------------------------------

/**
 * The injectable transport the finish-phase git helpers ride — structurally
 * identical to `gitExec` itself and to `issue-actions.ts`'s
 * `IssueActionTransport`, so production defaults to the real `git` invocation
 * while a test injects a fake that records the argv and returns a canned
 * result WITHOUT spawning a process (ADR-0040 Decision 2).
 */
export type GitActionTransport = (
  args: string[],
  opts: GhExecOptions,
) => Promise<GhResult<{ stdout: string; stderr: string }>>;

/** Options shared by the three helpers below. `cwd` is the `-C` directory. */
export type GitActionOptions = GhExecOptions & { transport?: GitActionTransport };

function splitTransport(opts: GitActionOptions): {
  transport: GitActionTransport;
  execOpts: GhExecOptions;
} {
  const { transport = gitExec, ...execOpts } = opts;
  return { transport, execOpts };
}

/**
 * `git worktree remove --force <path>` (run from the repo root, like the bash
 * `git -C "$REPO_ROOT" worktree remove --force "$wt"` it replaces). Never
 * throws; a failure is the `ok:false` arm the caller logs as non-fatal.
 */
export async function worktreeRemove(
  worktreePath: string,
  opts: GitActionOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  const { transport, execOpts } = splitTransport(opts);
  return transport(["worktree", "remove", "--force", worktreePath], execOpts);
}

/**
 * `git push -u origin <branch> --quiet` (run from INSIDE the worktree, like
 * the bash defensive push). Never throws.
 */
export async function pushBranchUpstream(
  branch: string,
  opts: GitActionOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  const { transport, execOpts } = splitTransport(opts);
  return transport(["push", "-u", "origin", branch, "--quiet"], execOpts);
}

/**
 * `git push origin --delete <branch>` (run from the repo root). Never throws.
 */
export async function deleteRemoteBranch(
  branch: string,
  opts: GitActionOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  const { transport, execOpts } = splitTransport(opts);
  return transport(["push", "origin", "--delete", branch], execOpts);
}
