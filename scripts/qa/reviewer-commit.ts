/**
 * scripts/qa/reviewer-commit.ts — the hydra-qa reviewer-commit EFFECT (issue #5712,
 * ADR-0046 Decision 2 + Decision 7). It lifts the git mechanics that used to be a
 * 184-line fenced shell block in `_fragments/hydra-qa-reference.md` section 9.4
 * into a tested script, the sibling of `route.ts` / `packet.ts` / `preflight.ts`.
 *
 * Decision half stays in `route.ts` (the `reviewer-commit` phase). This script only
 * performs the effect for the plan route paused on; it never re-reads findings,
 * never re-derives a verdict and never re-decides class membership (INV-3). Every
 * predicate (location parsing, hunk adjacency, body scope, case counting) is the
 * imported `src/qa/round-action.ts` function (INV-4).
 *
 *   reviewer-commit.ts open   --plan <plan.json> --pr N [--repo o/r]
 *   ... the reviewer edits files in `prWorktree` and the body in `bodyFile` ...
 *   reviewer-commit.ts finish --state <stateFile>
 *   reviewer-commit.ts abort  --state <stateFile>
 *
 * Each phase prints ONE JSON result on stdout. Exit 0 = ok, 1 = refused (a
 * machine-readable `reason` code), 2 = usage. Result objects, never throws.
 */

import { join } from "node:path";
import { InvariantViolationError } from "../../src/errors.ts";
import {
  checkBodyScopeEdit,
  countTestCases,
  diffHasHunkNearLine,
  reviewerCommitLocationRef,
} from "../../src/qa/round-action.ts";
import { DEFAULT_REPO, flagValue, isEntrypoint, isRecord, tryParse, UsageError, type CmdResult } from "./_lib.ts";

/** The two shared baselines a class-B test edit may regenerate (class `AB`). */
export const SHARED_AB_BASELINES = ["test/fixtures/suite-count-baseline.json", "test/fixtures/test-source-read-baseline.json"] as const;

/** The `reviewerCommit` plan route emits on pass 1 (`ReviewerCommitPlanSchema`, narrowed to the fields the effect needs). */
export interface ReviewerCommitPlanInput {
  action: "none" | "commit-a" | "commit-b" | "commit-ab";
  reviewedHead: string;
  headRef: string;
  fixedSha: string;
  blockingPaths: string[];
  followUpPaths: string[];
  blockingTestPaths: string[];
  followUpTestPaths: string[];
  bodyFix: boolean;
  blockingLocations: string[];
}

export interface ReviewerCommitFs {
  mkdtemp(prefix: string): string;
  /** File text, or null when absent/unreadable. */
  read(path: string): string | null;
  write(path: string, text: string): void;
  exists(path: string): boolean;
  /** Recursive, forced removal. */
  rm(path: string): void;
  symlink(target: string, path: string): void;
}

/** Every outward effect of the script (INV-13: tests inject a recording fake). */
export interface ReviewerCommitPorts {
  /** `git <args>`; `cwd` defaults to the process cwd (the QA session tree). */
  git(args: string[], cwd?: string): Promise<CmdResult>;
  /** `gh <args>`. */
  gh(args: string[]): Promise<CmdResult>;
  /** Run a TRUSTED script (absolute path under the master worktree) with `node --experimental-strip-types`. */
  runTrusted(script: string, args: string[], cwd: string): Promise<CmdResult>;
  fs: ReviewerCommitFs;
}

/** Everything `finish`/`abort` need, written by `open` (the agent never re-supplies the plan). */
export interface ReviewerCommitState {
  plan: ReviewerCommitPlanInput;
  pr: number;
  repo: string;
  workRoot: string;
  prWorktree: string;
  masterWorktree: string;
  bodyFile: string;
  origBodyFile: string;
  sessionRoot: string;
  sessionHead: string;
  sessionStatus: string;
}

export type OpenResult =
  | { ok: true; prWorktree: string; masterWorktree: string; bodyFile: string; stateFile: string }
  | { ok: false; reason: string };

export interface FinishResult {
  ok: boolean;
  reason?: string;
  pushed: boolean;
  newHead: string | null;
  qaFixes: string[];
  bodyRestoreFailed?: boolean;
  warnings?: string[];
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const sha12 = (sha: string): string => sha.slice(0, 12);
/** True for the `PR body` pseudo-location (a body row, not a repo path). */
const isPrBodyLocation = (location: string): boolean => location.trim().toLowerCase() === "pr body";

function parsePlan(raw: unknown): ReviewerCommitPlanInput | null {
  if (!isRecord(raw)) return null;
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const action = raw.action;
  if (action !== "none" && action !== "commit-a" && action !== "commit-b" && action !== "commit-ab") return null;
  return {
    action,
    reviewedHead: typeof raw.reviewedHead === "string" ? raw.reviewedHead : "",
    headRef: typeof raw.headRef === "string" ? raw.headRef : "",
    fixedSha: typeof raw.fixedSha === "string" ? raw.fixedSha : "",
    blockingPaths: strList(raw.blockingPaths),
    followUpPaths: strList(raw.followUpPaths),
    blockingTestPaths: strList(raw.blockingTestPaths),
    followUpTestPaths: strList(raw.followUpTestPaths),
    bodyFix: raw.bodyFix === true,
    blockingLocations: strList(raw.blockingLocations),
  };
}

/** Remove both worktrees and the private work root; failures are logged, never swallowed (INV-10). */
async function cleanup(st: ReviewerCommitState, ports: ReviewerCommitPorts): Promise<string[]> {
  const warnings: string[] = [];
  for (const wt of [st.prWorktree, st.masterWorktree]) {
    if (!ports.fs.exists(wt)) continue;
    const r = await ports.git(["worktree", "remove", "-f", wt], st.sessionRoot);
    if (!r.ok) {
      console.error(`[qa-reviewer-commit] ERROR: could not remove worktree ${wt}: ${r.stderr}`);
      warnings.push(`worktree-remove-failed:${wt}`);
    }
  }
  try {
    ports.fs.rm(st.workRoot);
  } catch (err) {
    console.error(`[qa-reviewer-commit] ERROR: could not remove ${st.workRoot}:`, err);
    warnings.push(`work-root-remove-failed:${st.workRoot}`);
  }
  return warnings;
}

/** Assert the QA session tree was never switched or dirtied (INV-1). */
async function sessionWarnings(st: ReviewerCommitState, ports: ReviewerCommitPorts): Promise<string[]> {
  const warnings: string[] = [];
  const head = await ports.git(["rev-parse", "HEAD"], st.sessionRoot);
  if (!head.ok || head.stdout.trim() !== st.sessionHead) {
    console.error(`[qa-reviewer-commit] ERROR: session tree HEAD moved off ${st.sessionHead}`);
    warnings.push("session-head-moved");
  }
  const status = await ports.git(["status", "--porcelain"], st.sessionRoot);
  if (!status.ok || status.stdout.trim() !== st.sessionStatus.trim()) {
    console.error("[qa-reviewer-commit] ERROR: session tree status changed during the reviewer commit");
    warnings.push("session-status-changed");
  }
  return warnings;
}

/** Gate, then build the trusted master worktree and the detached PR worktree. */
export async function openReviewerCommit(
  input: { plan: unknown; pr: number; repo: string; stateFile?: string },
  ports: ReviewerCommitPorts,
): Promise<OpenResult> {
  let st: ReviewerCommitState | null = null;
  try {
    const plan = parsePlan(input.plan);
    if (plan === null || plan.action === "none") return { ok: false, reason: "no-plan" };
    if (plan.reviewedHead === "" || plan.headRef === "" || plan.fixedSha === "") return { ok: false, reason: "plan-incomplete" };

    // INV-2: one live read answers both "did the PR move" and "is it a fork", before any fetch.
    const view = await ports.gh(["pr", "view", String(input.pr), "--repo", input.repo, "--json", "headRefOid,isCrossRepository"]);
    const live = view.ok ? tryParse(view.stdout) : undefined;
    if (!isRecord(live) || typeof live.headRefOid !== "string" || typeof live.isCrossRepository !== "boolean") {
      return { ok: false, reason: "pr-unreadable" };
    }
    if (live.isCrossRepository) return { ok: false, reason: "cross-repository-pr" };
    if (live.headRefOid !== plan.reviewedHead) return { ok: false, reason: "head-moved" };

    const gitDir = await ports.git(["rev-parse", "--git-dir"]);
    if (!gitDir.ok || !/\.git\/worktrees\//.test(gitDir.stdout)) return { ok: false, reason: "not-in-worktree" };
    const top = await ports.git(["rev-parse", "--show-toplevel"]);
    const head = await ports.git(["rev-parse", "HEAD"]);
    const status = await ports.git(["status", "--porcelain"]);
    if (!top.ok || !head.ok || !status.ok) return { ok: false, reason: "session-unreadable" };

    const workRoot = ports.fs.mkdtemp("qa-reviewer-commit-");
    st = {
      plan,
      pr: input.pr,
      repo: input.repo,
      workRoot,
      prWorktree: join(workRoot, "pr"),
      masterWorktree: join(workRoot, "master"),
      bodyFile: join(workRoot, "body.md"),
      origBodyFile: join(workRoot, "body.orig.md"),
      sessionRoot: top.stdout.trim(),
      sessionHead: head.stdout.trim(),
      sessionStatus: status.stdout,
    };

    // TRUST (INV-1): scripts run only from a detached worktree of plan.fixedSha (origin/master).
    const master = await ports.git(["worktree", "add", "--detach", st.masterWorktree, plan.fixedSha], st.sessionRoot);
    if (!master.ok) throw new Refusal("master-worktree-failed");
    const nm = join(st.sessionRoot, "node_modules");
    if (ports.fs.exists(nm)) ports.fs.symlink(nm, join(st.masterWorktree, "node_modules"));

    const fetched = await ports.git(["fetch", "origin", plan.headRef], st.sessionRoot);
    if (!fetched.ok) throw new Refusal("fetch-failed");
    const pr = await ports.git(["worktree", "add", "--detach", st.prWorktree, plan.reviewedHead], st.sessionRoot);
    if (!pr.ok) throw new Refusal("pr-worktree-failed");

    const body = await ports.gh(["pr", "view", String(input.pr), "--repo", input.repo, "--json", "body", "--jq", ".body"]);
    if (!body.ok) throw new Refusal("body-unreadable");
    ports.fs.write(st.origBodyFile, body.stdout);
    ports.fs.write(st.bodyFile, body.stdout);

    const stateFile = input.stateFile ?? join(workRoot, "state.json");
    ports.fs.write(stateFile, JSON.stringify(st));
    return { ok: true, prWorktree: st.prWorktree, masterWorktree: st.masterWorktree, bodyFile: st.bodyFile, stateFile };
  } catch (err) {
    const reason = err instanceof Refusal ? err.reason : "crashed";
    if (!(err instanceof Refusal)) console.error("[qa-reviewer-commit] open crashed:", err);
    if (st !== null) await cleanup(st, ports);
    return { ok: false, reason };
  }
}

/** A refusal carries a machine-readable reason and aborts the open/finish pipeline (STD-ERROR-TYPED-CODE). */
class Refusal extends InvariantViolationError {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function loadState(statePath: string, ports: ReviewerCommitPorts): ReviewerCommitState | null {
  const text = ports.fs.read(statePath);
  const raw = text === null ? undefined : tryParse(text);
  if (!isRecord(raw)) return null;
  const plan = parsePlan(raw.plan);
  const s = (k: string): string | null => (typeof raw[k] === "string" ? (raw[k] as string) : null);
  const workRoot = s("workRoot");
  const prWorktree = s("prWorktree");
  const masterWorktree = s("masterWorktree");
  const bodyFile = s("bodyFile");
  const origBodyFile = s("origBodyFile");
  const sessionRoot = s("sessionRoot");
  const sessionHead = s("sessionHead");
  const sessionStatus = s("sessionStatus");
  const repo = s("repo");
  if (
    plan === null || typeof raw.pr !== "number" || repo === null || workRoot === null || prWorktree === null ||
    masterWorktree === null || bodyFile === null || origBodyFile === null || sessionRoot === null ||
    sessionHead === null || sessionStatus === null
  ) {
    return null;
  }
  return { plan, pr: raw.pr, repo, workRoot, prWorktree, masterWorktree, bodyFile, origBodyFile, sessionRoot, sessionHead, sessionStatus };
}

/** Re-verify each blocking row of one class against the staged diff (the imported TS predicates, INV-4). */
async function reverifyRows(
  st: ReviewerCommitState,
  ports: ReviewerCommitPorts,
  staged: string[],
  klass: "A" | "B",
): Promise<void> {
  for (const loc of st.plan.blockingLocations) {
    if (isPrBodyLocation(loc)) continue; // covered by the body-changed + body-scope checks
    const ref = reviewerCommitLocationRef(loc);
    if (ref === null) {
      // A class-B pass leaves a non-path row to class A (which refuses it).
      if (klass === "A") throw new Refusal("row-location-unparseable");
      continue;
    }
    const isB = st.plan.blockingTestPaths.includes(ref.path);
    if (isB !== (klass === "B")) continue; // the other class's pass verifies this row
    if (ref.line === null) {
      if (!staged.includes(ref.path)) throw new Refusal("row-file-unstaged");
    } else {
      const diff = await ports.git(["diff", "--cached", "-U0", "--", ref.path], st.prWorktree);
      if (!diff.ok || !diffHasHunkNearLine(diff.stdout, ref.line)) throw new Refusal("row-hunk-missing");
    }
  }
}

async function stagedNames(st: ReviewerCommitState, ports: ReviewerCommitPorts): Promise<string[]> {
  const r = await ports.git(["diff", "--cached", "--name-only"], st.prWorktree);
  if (!r.ok) throw new Refusal("staged-unreadable");
  return lines(r.stdout);
}

async function commitOne(st: ReviewerCommitState, ports: ReviewerCommitPorts, subject: string, trailer: string, allowEmpty: boolean): Promise<string> {
  const args = ["commit", "-q", ...(allowEmpty ? ["--allow-empty"] : []), "-m", subject, "-m", trailer];
  const c = await ports.git(args, st.prWorktree);
  if (!c.ok) throw new Refusal("commit-failed");
  const head = await ports.git(["rev-parse", "HEAD"], st.prWorktree);
  if (!head.ok || head.stdout.trim() === "") throw new Refusal("commit-failed");
  return head.stdout.trim();
}

interface FinishFlags {
  bodyEdited: boolean;
}

async function runFinish(
  st: ReviewerCommitState,
  ports: ReviewerCommitPorts,
  flags: FinishFlags,
  commits: string[],
): Promise<FinishResult> {
  const { plan } = st;
  const hasA = plan.action === "commit-a" || plan.action === "commit-ab";
  const hasB = plan.action === "commit-b" || plan.action === "commit-ab";
  const fail = (reason: string): FinishResult => ({ ok: false, reason, pushed: false, newHead: null, qaFixes: [] });
  try {
    const origBody = ports.fs.read(st.origBodyFile) ?? "";
    const newBody = ports.fs.read(st.bodyFile) ?? "";
    const bodyChanged = plan.bodyFix && origBody !== newBody;
    if (plan.bodyFix) {
      if (!bodyChanged) throw new Refusal("body-unchanged");
      if (newBody.trim() === "" || !/Closes #[0-9]+/.test(newBody)) throw new Refusal("body-invalid");
      if (!checkBodyScopeEdit(origBody, newBody).ok) throw new Refusal("body-scope");
    }

    // ---- class A: stage ONLY approved paths (INV-5: never `git add -A`) ----
    if (hasA) {
      if (plan.blockingPaths.length > 0) {
        const add = await ports.git(["add", "--", ...plan.blockingPaths], st.prWorktree);
        if (!add.ok) throw new Refusal("stage-failed");
      }
      for (const p of plan.followUpPaths) {
        await ports.git(["add", "--", p], st.prWorktree); /* intentional: an unedited optional follow-up is not an error */
      }
      const staged = await stagedNames(st, ports);
      const approved = [...plan.blockingPaths, ...plan.followUpPaths];
      if (staged.some((f) => !approved.includes(f))) throw new Refusal("unapproved-staged-path");
      if (plan.blockingPaths.some((f) => !staged.includes(f))) throw new Refusal("blocking-path-unstaged");
      if (staged.length === 0 && !bodyChanged) throw new Refusal("nothing-changed");
      await reverifyRows(st, ports, staged, "A");
      // A body-only round stages nothing: the EMPTY `QA-Fix: A` commit still makes `synchronize` fire.
      commits.push(await commitOne(st, ports, `fix(qa): reviewer class-A fixes for PR #${st.pr}`, "QA-Fix: A", true));
    }

    // ---- class B: ONE separate commit, never a combined trailer ----
    if (hasB) {
      const testPaths = [...plan.blockingTestPaths, ...plan.followUpTestPaths];
      for (const p of testPaths) {
        const after = ports.fs.read(join(st.prWorktree, p));
        // INV-7: a reviewer-added NEW file has no reviewed-head version, so its before-count is 0.
        const existed = await ports.git(["cat-file", "-e", `${plan.reviewedHead}:${p}`], st.prWorktree);
        if (after === null) {
          // An optional path the reviewer never created is fine; deleting an existing test file lowers its count to 0.
          if (existed.ok) throw new Refusal("case-count-lowered");
          continue;
        }
        let before = 0;
        if (existed.ok) {
          const shown = await ports.git(["show", `${plan.reviewedHead}:${p}`], st.prWorktree);
          if (!shown.ok) throw new Refusal("before-copy-unreadable");
          before = countTestCases(shown.stdout);
        }
        if (countTestCases(after) < before) throw new Refusal("case-count-lowered");
      }
      if (plan.blockingTestPaths.length > 0) {
        const add = await ports.git(["add", "--", ...plan.blockingTestPaths], st.prWorktree);
        if (!add.ok) throw new Refusal("stage-failed");
      }
      for (const p of [...plan.followUpTestPaths, ...SHARED_AB_BASELINES]) {
        await ports.git(["add", "--", p], st.prWorktree); /* intentional: an unedited optional path / untouched baseline is not an error */
      }
      const stagedB = await stagedNames(st, ports);
      const approvedB = [...plan.blockingTestPaths, ...plan.followUpTestPaths, ...SHARED_AB_BASELINES] as string[];
      if (stagedB.some((f) => !approvedB.includes(f))) throw new Refusal("unapproved-staged-path");
      if (plan.blockingTestPaths.some((f) => !stagedB.includes(f))) throw new Refusal("blocking-path-unstaged");
      if (stagedB.length === 0) throw new Refusal("nothing-changed");
      await reverifyRows(st, ports, stagedB, "B");
      commits.push(await commitOne(st, ports, `fix(qa): reviewer class-B test fixes for PR #${st.pr}`, "QA-Fix: B", false));
    }

    // ---- INV-8: the local deterministic proof(s), by absolute path under the master worktree, BEFORE any push ----
    const proof = `${st.masterWorktree}/scripts/ci/qa-fix-proof.ts`;
    const bases = hasB ? [plan.fixedSha] : [plan.reviewedHead, plan.fixedSha];
    for (const base of bases) {
      const r = await ports.runTrusted(proof, ["--base", base, "--head", "HEAD"], st.prWorktree);
      if (!r.ok) throw new Refusal("proof-failed");
    }

    // ---- INV-9: body BEFORE push (so `synchronize` carries it), then a plain fast-forward push ----
    if (plan.bodyFix) {
      const edit = await ports.gh(["pr", "edit", String(st.pr), "--repo", st.repo, "--body-file", st.bodyFile]);
      if (!edit.ok) throw new Refusal("body-edit-failed");
      flags.bodyEdited = true;
    }
    const push = await ports.git(["push", "origin", `HEAD:refs/heads/${plan.headRef}`], st.prWorktree);
    if (!push.ok) throw new Refusal("push-rejected");
    // The push returned ok: the outcome is FINAL. At least one commit exists, so the new head is the last commit.
    return { ok: true, pushed: true, newHead: commits[commits.length - 1] ?? null, qaFixes: commits.map(sha12) };
  } catch (err) {
    if (err instanceof Refusal) return fail(err.reason);
    console.error("[qa-reviewer-commit] finish crashed:", err);
    return fail("crashed");
  }
}

/** Stage, verify, commit A then B, prove, edit the body, push, clean up. */
export async function finishReviewerCommit(statePath: string, ports: ReviewerCommitPorts): Promise<FinishResult> {
  const st = loadState(statePath, ports);
  if (st === null) return { ok: false, reason: "state-unreadable", pushed: false, newHead: null, qaFixes: [] };
  const flags: FinishFlags = { bodyEdited: false };
  const commits: string[] = [];
  let result = await runFinish(st, ports, flags, commits);
  if (!result.pushed && flags.bodyEdited) {
    // Restore ONLY an abort after the body edit and before the push; a failed restore is loud.
    const restore = await ports.gh(["pr", "edit", String(st.pr), "--repo", st.repo, "--body-file", st.origBodyFile]);
    if (!restore.ok) {
      console.error(`ERROR: QA body restore FAILED for PR #${st.pr}; report it in the verdict comment`);
      result = { ...result, bodyRestoreFailed: true, reason: `${result.reason ?? "refused"};body-restore-failed` };
    }
  }
  const warnings = [...(await cleanup(st, ports)), ...(await sessionWarnings(st, ports))];
  return warnings.length > 0 ? { ...result, warnings } : result;
}

/** Cleanup only: nothing was committed, pushed or edited by `open`. */
export async function abortReviewerCommit(
  statePath: string,
  ports: ReviewerCommitPorts,
): Promise<{ ok: boolean; reason?: string; warnings?: string[] }> {
  const st = loadState(statePath, ports);
  if (st === null) return { ok: false, reason: "state-unreadable" };
  const warnings = [...(await cleanup(st, ports)), ...(await sessionWarnings(st, ports))];
  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}

/** Production ports: GitHub CLI Adapter + git seam + node fs. */
export async function createReviewerCommitPorts(): Promise<ReviewerCommitPorts> {
  const { ghExec } = await import("../../src/github/gh.ts");
  const { gitExec } = await import("../../src/github/git.ts");
  const { runExec } = await import("../../src/github/exec.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const toCmd = (r: { ok: boolean; data?: { stdout: string }; stderr?: string }): CmdResult =>
    r.ok ? { ok: true, stdout: (r.data as { stdout: string }).stdout } : { ok: false, stderr: r.stderr ?? "" };
  return {
    async git(args, cwd) {
      return toCmd(await gitExec(args, { timeout: 180_000, ...(cwd !== undefined ? { cwd } : {}) }));
    },
    async gh(args) {
      return toCmd(await ghExec(args, { timeout: 60_000 }));
    },
    async runTrusted(script, args, cwd) {
      const raw = await runExec(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd, timeout: 900_000 });
      return raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode
        ? { ok: true, stdout: raw.stdout, stderr: raw.stderr }
        : { ok: false, stderr: raw.stderr, stdout: raw.stdout };
    },
    fs: {
      mkdtemp: (prefix) => fs.mkdtempSync(join(os.tmpdir(), prefix)),
      read(path) {
        try {
          return fs.readFileSync(path, "utf8");
        } catch {
          /* intentional: an absent file is an absent fact, the callers decide */
          return null;
        }
      },
      write: (path, text) => fs.writeFileSync(path, text),
      exists: (path) => fs.existsSync(path),
      rm: (path) => fs.rmSync(path, { recursive: true, force: true }),
      symlink: (target, path) => fs.symlinkSync(target, path),
    },
  };
}

async function main(): Promise<void> {
  let code = 0;
  try {
    const argv = process.argv.slice(2);
    const sub = argv[0];
    const ports = await createReviewerCommitPorts();
    let result: { ok: boolean };
    if (sub === "open") {
      const planPath = flagValue(argv, "--plan");
      const pr = Number(flagValue(argv, "--pr"));
      if (planPath === undefined || !Number.isInteger(pr) || pr < 1) {
        throw new UsageError("usage: reviewer-commit.ts open --plan <plan.json> --pr N [--repo owner/name]");
      }
      const text = ports.fs.read(planPath);
      result = await openReviewerCommit(
        { plan: text === null ? undefined : tryParse(text), pr, repo: flagValue(argv, "--repo") ?? DEFAULT_REPO },
        ports,
      );
    } else if (sub === "finish" || sub === "abort") {
      const state = flagValue(argv, "--state");
      if (state === undefined) throw new UsageError(`usage: reviewer-commit.ts ${sub} --state <stateFile>`);
      result = sub === "finish" ? await finishReviewerCommit(state, ports) : await abortReviewerCommit(state, ports);
    } else {
      throw new UsageError("usage: reviewer-commit.ts open|finish|abort ...");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    code = result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(JSON.stringify({ code: err.code, issues: [{ message: err.message }] }));
      code = 2;
    } else {
      console.error("[qa-reviewer-commit] failed, no result produced:", err);
      code = 1;
    }
  }
  process.stdout.write("", () => process.exit(code));
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
