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
type GitActionTransport = (
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

// ---------------------------------------------------------------------------
// Watchdog origin-identity helpers (issue #5098) — every repair is
// `git -C <root> ...`, limited to the three mutations below. No `git remote`,
// push, pull or prune.
// ---------------------------------------------------------------------------

/** `git config --get <key>`: the value, "absent" (exit 1 — a finding), or a tooling failure (exit > 1 / spawn / timeout). */
export type GitConfigRead =
  | { kind: "value"; value: string }
  | { kind: "absent" }
  | { kind: "error"; exitCode: number; stderr: string };

/**
 * Read one git config key under `root`, preserving the exit-code split that
 * `gitExec` drops: `git config --get` exits 1 when the key is ABSENT (a
 * finding: the remote has no URL) but > 1 on a tooling failure (skip the tick).
 * Never throws.
 */
export async function readGitConfig(root: string, key: string, opts: GhExecOptions = {}): Promise<GitConfigRead> {
  const raw = await runExec(gitBin(), ["-C", root, "config", "--get", key], opts);
  if (raw.spawnErrorCode || raw.timedOut) return { kind: "error", exitCode: raw.exitCode, stderr: raw.stderr };
  if (raw.exitCode === 0) return { kind: "value", value: raw.stdout.replace(/\r?\n$/, "") };
  if (raw.exitCode === 1) return { kind: "absent" };
  return { kind: "error", exitCode: raw.exitCode, stderr: raw.stderr };
}

/** Whether `git config --get-all <key>` finds at least one value under `root`. */
export async function hasGitConfigKey(root: string, key: string, opts: GhExecOptions = {}): Promise<boolean> {
  const raw = await runExec(gitBin(), ["-C", root, "config", "--get-all", key], opts);
  return raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode;
}

/** `git -C <root> config <key> <value>`. Never throws. */
export function setGitConfig(
  root: string,
  key: string,
  value: string,
  opts: GhExecOptions = {},
): Promise<GhResult<{ stdout: string; stderr: string }>> {
  return gitExec(["-C", root, "config", key, value], opts);
}

/** Whether `ref` resolves under `root` (`git rev-parse --verify -q`). Read-only; never throws. */
export async function refResolves(root: string, ref: string, opts: GhExecOptions = {}): Promise<boolean> {
  const raw = await runExec(gitBin(), ["-C", root, "rev-parse", "--verify", "-q", ref], opts);
  return raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode;
}

/** Result of the watchdog's `git fetch --quiet origin`. */
export interface FetchOriginResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  /** Raw stderr; callers redact it (remote-url.ts) before logging. */
  stderr: string;
}

/**
 * `GIT_TERMINAL_PROMPT=0 git -C <root> fetch --quiet origin` under `timeoutMs`.
 * Reports the raw exit code and timeout flag (the caller words 'timed out').
 */
export async function fetchOrigin(root: string, timeoutMs: number): Promise<FetchOriginResult> {
  const raw = await runExec(gitBin(), ["-C", root, "fetch", "--quiet", "origin"], {
    timeout: timeoutMs,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  const ok = raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode;
  return { ok, exitCode: raw.exitCode, timedOut: raw.timedOut, stderr: raw.stderr };
}
