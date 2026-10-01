/**
 * src/glm/finish.ts — the GLM drainer's FINISH phase (ADR-0040 Decisions 1–3;
 * epic #4681, issue #4685).
 *
 * Replaces everything `scripts/glm/drainer-loop.sh`'s `attempt_one_issue` did
 * AFTER the author session: the post-author arms (driver fault / fail-closed
 * not-run / ran-and-ended), the evidence-driven salvage ladder (issue #4337
 * INV-2/3/4), preflight, the open-PR adopt-on-collision fallback (issue
 * #3900), the label writes, the timeout note (INV-3), the per-issue timeout
 * counters (INV-6), the z.ai quota-block recording (issue #4273) and the daily
 * cap increment.
 *
 * Shape (ADR-0040 Decision 2): one PURE {@link decideFinish} core over a flat
 * input, re-evaluated as evidence arrives (`preflightOk` / `prOpened` are
 * `boolean | null`; `null` = not gathered yet, and the `next` field names the
 * evidence to gather next), plus a {@link runFinish} orchestration over
 * injected deps. Effects ride the GitHub CLI Adapter seams — label writes
 * through `editIssueLabels` (issue-actions.ts), PR creation through `createPr`
 * (prs.ts), worktree/push effects through `git.ts` (INV-9) — never raw
 * `node:child_process`.
 *
 * Behaviour-preserving (ADR-0040 Decision 6) with exactly five deliberate
 * deltas, each named in the PR body: (a) dry-run is hermetic (zero gh / git /
 * preflight / file-write dep calls, one `would-` line per skipped effect);
 * (b) the adopted-PR relabel uses `gh issue edit` on the PR number, not
 * `gh pr edit` (broken for labels here, ADR-0034 §7); (c) the remote branch is
 * deleted only after an `ls-remote` check shows it exists; (d) an unparseable
 * author outcome takes the driver-fault ARM (a salvage release), not a driver
 * FAULT; (e) the adopt lookup filters the open-PR list by head branch
 * client-side.
 *
 * File-backed state keeps today's `$CAP_DIR` paths and formats (ADR-0040
 * Decision 3), reusing gate.ts's path/count helpers so the read side (gate)
 * and the write side (finish) share one definition.
 *
 * {@link runFinish} never throws: every effect is individually guarded (a
 * failure or rejection logs a WARN and the arm continues, so the claim release
 * still happens when worktree removal fails), and an unexpected fault is
 * caught at the top level, logged, followed by a best-effort plain release and
 * reported as `action: "finish-fault"`. Journal lines go to stderr through
 * `deps.log` with the `hydra-glm-drainer:` prefix; stdout carries only the
 * driver's one JSON line.
 */

import { readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../logger.ts";
import { ORCH_BOARD_LABELS } from "../board-labels.ts";
import { isGhFailure } from "../github/exec.ts";
import { isIssueReadFailure } from "../github/issues.ts";
import { capFilePath, quotaBlockFilePath, parseCapCount, epochToIso } from "./gate.ts";
import { loadDrainerConfig, type DrainerConfig } from "./drainer-config.ts";
import {
  preflightBeforePr,
  type PreflightOptions,
  type PreflightResult,
} from "./drainer-runner.ts";
import { editIssueLabels, viewIssue, type IssueActionWriteResult } from "../github/issue-actions.ts";
import { createPr, listOpenPrs, type PrRow } from "../github/prs.ts";
import {
  gitExec,
  worktreeRemove,
  pushBranchUpstream,
  deleteRemoteBranch,
  lsRemoteHeads,
} from "../github/git.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** z.ai quota block clamp floor — 15 min (issue #4273, bash parity). */
export const QUOTA_BLOCK_MIN_SECONDS = 900;
/** z.ai quota block clamp ceiling — 35 days. */
export const QUOTA_BLOCK_MAX_SECONDS = 3024000;
/** z.ai quota block fallback — 60 min (no parseable reset, or one in the past). */
export const QUOTA_BLOCK_FALLBACK_SECONDS = 3600;

/**
 * The PR-side provenance label (ADR-0032 Decision 5). Deliberately NOT in
 * `board-labels.ts`'s vocabulary (see its own comment): it labels PRs, not
 * board issues.
 */
export const GLM_LABEL_AUTHORED = "glm-authored";

const LABEL_READY = ORCH_BOARD_LABELS.ready_for_agent;
const LABEL_IN_PROGRESS = ORCH_BOARD_LABELS.in_progress;
const LABEL_NEEDS_QA = ORCH_BOARD_LABELS.needs_qa;
const LABEL_WITHHOLD = ORCH_BOARD_LABELS.glm_withhold;

/**
 * The timeout disclosure (issue #4337 INV-3), appended to the salvaged
 * session's PR body before the PR is opened — byte-identical to the bash
 * heredoc it replaces. PLAIN TEXT ONLY: a backticked code-span in the PR body
 * is a scope entry to CI's scope-check parser.
 */
export const TIMEOUT_NOTE = `
## GLM drainer note

The authoring session behind this PR hit the drainer's 50-minute timeout and
was cut off at that point; the supervising loop salvaged what had been
committed. The diff is exactly what was committed at cutoff — judge it as a
partial delivery that may still need follow-up, not as a session that
reported completion.
`;

/** The PR body file name at the worktree root (the authoring session's hand-off). */
export const PR_BODY_FILENAME = ".glm-drainer-pr-body.md";

// ---------------------------------------------------------------------------
// Pure rules — the author outcome
// ---------------------------------------------------------------------------

/**
 * What the author session's stdout line + exit code say happened, classifying
 * bash's three post-author arms (issue #4337 INV-2):
 *   - `driver-fault` — non-zero driver exit, or missing/empty/unparseable
 *     JSON (delta d: the ARM, not a mode fault);
 *   - `not-run`      — the driver ran and reported `{ok:false, code, message}`
 *     (a fail-closed env/args build);
 *   - `ran`          — the session ran and ended (cleanly, non-zero, or cut
 *     off by the timeout — an authoring outcome the ladder salvages).
 */
export type AuthorOutcome =
  | { kind: "driver-fault" }
  | { kind: "not-run"; code: string; message: string }
  | { kind: "ran"; timedOut: boolean; code: number | null; stdout: string };

/** Pure. See {@link AuthorOutcome}. */
export function parseAuthorOutcome(raw: string, exitCode: number): AuthorOutcome {
  if (exitCode !== 0) return { kind: "driver-fault" };
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { kind: "driver-fault" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "driver-fault" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "driver-fault" };
  const c = parsed as {
    ok?: unknown;
    code?: unknown;
    message?: unknown;
    stdout?: unknown;
    timedOut?: unknown;
  };
  if (c.ok !== true) {
    return {
      kind: "not-run",
      code: c.code === undefined || c.code === null ? "null" : String(c.code),
      message: typeof c.message === "string" ? c.message : "",
    };
  }
  return {
    kind: "ran",
    timedOut: c.timedOut === true,
    code: typeof c.code === "number" && Number.isFinite(c.code) ? c.code : null,
    stdout: typeof c.stdout === "string" ? c.stdout : "",
  };
}

// ---------------------------------------------------------------------------
// Pure rules — the z.ai quota block (issue #4273, D16)
// ---------------------------------------------------------------------------

/**
 * Parse z.ai's 429 payload into the block instant, or `null` when the text is
 * not a quota rejection. Pure: `nowSec` is injected, the wall clock is read in
 * `tzOffset` (a `[+-]HHMM` string, default `+0800` via
 * `config.quotaResetTzOffset`).
 *
 * Only a literal `Request rejected (429)` sets a block. On a 429 the FIRST
 * `reset at YYYY-MM-DD HH:MM:SS` clause is read as a wall clock in
 * `tzOffset`; no clause, an out-of-range clause, an unparseable offset, or an
 * instant at or before `nowSec` gives `nowSec + 3600`. A future instant is
 * clamped to `[nowSec + 900, nowSec + 3024000]` — the clamp makes a wrong
 * offset assumption cheap in both directions.
 */
export function parseQuotaBlockStdout(
  text: string,
  nowSec: number,
  tzOffset: string,
): number | null {
  if (typeof text !== "string" || !text.includes("Request rejected (429)")) return null;
  const fallback = nowSec + QUOTA_BLOCK_FALLBACK_SECONDS;
  const m = /reset at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return fallback;
  const om = /^([+-])(\d{2})(\d{2})$/.exec(tzOffset.trim());
  if (!om) return fallback; // unparseable offset
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return fallback; // out-of-range clause (bash: `date` refuses it too)
  }
  const offsetSec = (om[1] === "-" ? -1 : 1) * (Number(om[2]) * 3600 + Number(om[3]) * 60);
  const epoch = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000) - offsetSec;
  if (!Number.isFinite(epoch) || epoch <= nowSec) return fallback;
  const floor = nowSec + QUOTA_BLOCK_MIN_SECONDS;
  const ceiling = nowSec + QUOTA_BLOCK_MAX_SECONDS;
  return Math.min(Math.max(epoch, floor), ceiling);
}

// ---------------------------------------------------------------------------
// Pure rules — the salvage ladder (issue #4337 INV-3/4, D13/D15)
// ---------------------------------------------------------------------------

/** The ladder's six actions — the issue's five outcomes plus `release-not-authored`. */
export type FinishAction =
  | "release-not-authored"
  | "release-nothing-produced"
  | "keep-partial-for-resume"
  | "withhold-preflight-blocked"
  | "release-after-failed-pr"
  | "open-pr";

/**
 * The verdict, carrying its label transition (INV-3): a release names whether
 * `glm-withhold` rides along; the open-pr path names the NEXT evidence to
 * gather (`preflight` while `preflightOk` is null, `create-pr` while
 * `prOpened` is null, `advance` once both are true).
 */
export type FinishVerdict =
  | { action: "release-not-authored"; withhold: false }
  | {
      action: "release-nothing-produced" | "keep-partial-for-resume" | "release-after-failed-pr";
      withhold: boolean;
    }
  | { action: "withhold-preflight-blocked"; withhold: true }
  | { action: "open-pr"; next: "preflight" | "create-pr" | "advance" };

export interface DecideFinishInput {
  authorOutcome: AuthorOutcome;
  commitCount: number;
  prBodyPresent: boolean;
  timedOut: boolean;
  /** The per-issue timeout count AFTER this session's increment (INV-3). */
  timeoutCount: number;
  timeoutResumeCap: number;
  /** `null` = not gathered yet. */
  preflightOk: boolean | null;
  /** `null` = not gathered yet. */
  prOpened: boolean | null;
  dryRun: boolean;
}

/** The INV-6 withhold rule shared by the three timeout-driven release arms. */
function withholdsOnTimeout(input: DecideFinishInput): boolean {
  return input.timedOut && input.timeoutCount >= input.timeoutResumeCap;
}

/**
 * The salvage ladder, pure (no I/O, no clock, no logger). Rule order, first
 * match wins (INV-2):
 *   1. driver-fault / not-run        → `release-not-authored`
 *   2. !dryRun && commitCount === 0  → `release-nothing-produced`
 *   3. !dryRun && pr body absent     → `keep-partial-for-resume`
 *   4. preflightOk === false         → `withhold-preflight-blocked`
 *   5. prOpened === false            → `release-after-failed-pr`
 *   6. otherwise                     → `open-pr` (+ `next`)
 * Rules 2 and 3 are skipped under dry-run (bash parity — DRY_RUN's `!= 1`
 * guards around the commit-count and pr-body checks).
 */
export function decideFinish(input: DecideFinishInput): FinishVerdict {
  if (input.authorOutcome.kind !== "ran") {
    return { action: "release-not-authored", withhold: false };
  }
  if (!input.dryRun && input.commitCount === 0) {
    return { action: "release-nothing-produced", withhold: withholdsOnTimeout(input) };
  }
  if (!input.dryRun && !input.prBodyPresent) {
    return { action: "keep-partial-for-resume", withhold: withholdsOnTimeout(input) };
  }
  if (input.preflightOk === false) {
    return { action: "withhold-preflight-blocked", withhold: true };
  }
  if (input.prOpened === false) {
    return { action: "release-after-failed-pr", withhold: withholdsOnTimeout(input) };
  }
  if (input.preflightOk === null) return { action: "open-pr", next: "preflight" };
  if (input.prOpened === null) return { action: "open-pr", next: "create-pr" };
  return { action: "open-pr", next: "advance" };
}

// ---------------------------------------------------------------------------
// File-backed state (ADR-0040 Decision 3) — paths + formats shared with gate
// ---------------------------------------------------------------------------

/** `<capDir>/hydra-glm-drainer-timeouts-<issue>` (a bare integer, trailing newline). */
export function timeoutCounterFilePath(capDir: string, issue: number): string {
  return join(capDir, `hydra-glm-drainer-timeouts-${issue}`);
}

// ---------------------------------------------------------------------------
// runFinish
// ---------------------------------------------------------------------------

/** What one finish invocation is asked to salvage. */
export interface FinishInput {
  issue: number;
  /** `null` on the worktree-create-failure path (release only, nothing to remove). */
  worktree: string | null;
  branch: string | null;
  /** The author session's raw stdout line (the driver JSON). */
  authorRaw: string;
  /** The author session driver's exit code (non-zero = driver FAULT). */
  authorExitCode: number;
}

/** The `finish` driver mode's stdout line (INV-10). */
export interface FinishResult {
  action: FinishAction | "finish-fault";
  issue: number;
  /** The labels the action aimed to leave on the issue. */
  labels: string[];
  pr: { number: number | null; url: string; adopted: boolean } | null;
  /** The just-recorded z.ai quota-block instant, or `null`. */
  quotaBlockedUntil: number | null;
  dryRun: boolean;
  detail?: string;
}

/** A minimal `{ok}`-shaped effect result so fakes stay trivial. */
export interface EffectResult {
  ok: boolean;
  stderr?: string;
}

/** Injected seam — every mode is unit-testable with no live gh/git/fs. */
export interface FinishDeps {
  config: DrainerConfig;
  /** The repo root git runs from for repo-scoped effects (fetch, worktree, push --delete). */
  repoRoot: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** Journal line sink (stderr in production, `hydra-glm-drainer:` prefixed by the default). */
  log: (msg: string) => void;
  editIssueLabels: (
    issue: number,
    labels: { remove?: string[]; add?: string[] },
  ) => Promise<IssueActionWriteResult>;
  /** The issue title, or `null` when the read fails (the caller falls back). */
  viewIssueTitle: (issue: number) => Promise<string | null>;
  createPr: (input: {
    base: string;
    head: string;
    title: string;
    bodyFile: string;
    label: string;
  }) => Promise<{ ok: boolean; url?: string; stderr?: string }>;
  /** Open PRs for the adopt lookup (filtered client-side by head branch). */
  listOpenPrs: () => Promise<{ ok: boolean; rows: PrRow[] }>;
  runGit: (
    args: string[],
    cwd: string,
  ) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>;
  removeWorktree: (worktree: string) => Promise<EffectResult>;
  pushBranchUpstream: (branch: string, worktreeCwd: string) => Promise<EffectResult>;
  deleteRemoteBranch: (branch: string) => Promise<EffectResult>;
  /** The delta-(c) ls-remote existence check before a `push --delete`. */
  remoteBranchExists: (branch: string) => Promise<boolean>;
  preflight: (options: PreflightOptions) => Promise<PreflightResult>;
  readFileIfExists: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  unlinkIfExists: (path: string) => void;
  appendToFile: (path: string, text: string) => void;
}

/** Await an effect, converting a rejection into a WARN + `undefined` (INV-5). */
async function safe<T>(
  deps: FinishDeps,
  what: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`WARN ${what} threw (non-fatal): ${msg}`);
    return undefined;
  }
}

function lastLine(text: string | undefined): string {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

// --- guarded effects -------------------------------------------------------

async function removeWorktreeIfPassed(deps: FinishDeps, worktree: string | null): Promise<void> {
  if (!worktree) return;
  const r = await safe(deps, `worktree remove (${worktree})`, () => deps.removeWorktree(worktree));
  if (r && r.ok === false) {
    deps.log(`WARN failed to remove worktree ${worktree} (non-fatal — hydra-branch-prune will reap it)`);
  }
}

async function deleteRemoteBranchIfPushed(deps: FinishDeps, branch: string | null): Promise<void> {
  if (!branch) return;
  // Delta (c): check first — `git push origin --delete` on a never-pushed
  // branch errors; bash swallowed that with `|| true`.
  let exists = false;
  try {
    exists = await deps.remoteBranchExists(branch);
  } catch (err) {
    deps.log(
      `WARN ls-remote existence check threw for ${branch} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!exists) return;
  const r = await safe(deps, `delete remote branch ${branch}`, () => deps.deleteRemoteBranch(branch));
  if (r && r.ok === false) {
    deps.log(`WARN failed to delete remote branch ${branch} (non-fatal): ${lastLine(r.stderr)}`);
  }
}

async function defensivePush(deps: FinishDeps, input: FinishInput): Promise<void> {
  if (!input.branch || !input.worktree) return;
  const r = await safe(deps, "git push", () =>
    deps.pushBranchUpstream(input.branch as string, input.worktree as string),
  );
  if (r && r.ok === false) {
    deps.log(`WARN defensive git push failed for branch ${input.branch} (non-fatal): ${lastLine(r.stderr)}`);
  }
}

async function releaseClaim(deps: FinishDeps, issue: number, withhold: boolean): Promise<void> {
  const r = await safe(deps, `release issue #${issue}`, () =>
    deps.editIssueLabels(issue, { remove: [LABEL_IN_PROGRESS], add: [LABEL_READY] }),
  );
  if (r && r.ok === false) deps.log(`WARN failed to release issue #${issue} (non-fatal)`);
  if (withhold) {
    const w = await safe(deps, `add glm-withhold to issue #${issue}`, () =>
      deps.editIssueLabels(issue, { add: [LABEL_WITHHOLD] }),
    );
    if (w && w.ok === false) {
      deps.log(`WARN failed to add glm-withhold to issue #${issue} (non-fatal)`);
    }
  }
}

async function advanceToNeedsQa(deps: FinishDeps, issue: number): Promise<void> {
  const r = await safe(deps, `advance issue #${issue} to needs-qa`, () =>
    deps.editIssueLabels(issue, { remove: [LABEL_READY, LABEL_IN_PROGRESS], add: [LABEL_NEEDS_QA] }),
  );
  if (r && r.ok === false) {
    deps.log(`WARN failed to advance issue #${issue} to needs-qa (non-fatal — relabel by hand)`);
  }
}

function appendTimeoutNote(deps: FinishDeps, bodyFile: string): void {
  try {
    deps.appendToFile(bodyFile, TIMEOUT_NOTE);
    deps.log(`appended GLM drainer timeout note to ${bodyFile}`);
  } catch (err) {
    // Non-fatal by contract (issue #4337): proceed with the unmodified body.
    deps.log(
      `WARN failed to append GLM drainer timeout note to ${bodyFile} (non-fatal — proceeding with the unmodified body): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- evidence gatherers ----------------------------------------------------

async function countCommits(deps: FinishDeps, worktree: string): Promise<number> {
  const r = await safe(deps, "git rev-list --count", () =>
    deps.runGit(["rev-list", "--count", "origin/master..HEAD"], worktree),
  );
  if (!r || r.ok === false) return 0; // bash: `|| echo 0`
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function bodyFileAt(worktree: string): string {
  return join(worktree, PR_BODY_FILENAME);
}

function prBodyPresent(deps: FinishDeps, worktree: string): boolean {
  try {
    const raw = deps.readFileIfExists(bodyFileAt(worktree));
    return raw !== null && raw.length > 0; // bash `! -s` (size > 0)
  } catch {
    return false;
  }
}

async function listChangedFiles(deps: FinishDeps, input: FinishInput): Promise<string[]> {
  await safe(deps, "git fetch origin", () => deps.runGit(["fetch", "origin", "--quiet"], deps.repoRoot));
  const r = await safe(deps, "git diff --name-only", () =>
    deps.runGit(["diff", "--name-only", "origin/master...HEAD"], input.worktree as string),
  );
  if (!r || r.ok === false) return []; // bash: `|| true` — an empty list passes preflight
  return (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
}

async function readTitle(deps: FinishDeps, issue: number): Promise<string> {
  const t = await safe(deps, "issue title read", () => deps.viewIssueTitle(issue));
  return t !== undefined && t !== null && t.trim().length > 0
    ? t
    : `glm-authored: issue #${issue}`;
}

/**
 * The open-PR step with the adopt-on-collision fallback (issue #3900): a
 * create failure is decided by LISTING open PRs for the head branch
 * (client-side filter, delta e) — never by parsing the error text. A match is
 * adopted as success (ANOMALY line + best-effort `glm-authored` relabel via
 * `gh issue edit` on the PR number, delta b); no match, or a failed lookup,
 * is a genuine failure.
 */
async function openOrAdoptPr(
  deps: FinishDeps,
  input: FinishInput,
): Promise<{ opened: boolean; pr: FinishResult["pr"] }> {
  const issue = input.issue;
  const title = await readTitle(deps, issue);
  const created = await safe(deps, "gh pr create", () =>
    deps.createPr({
      base: "master",
      head: input.branch as string,
      title,
      bodyFile: bodyFileAt(input.worktree as string),
      label: GLM_LABEL_AUTHORED,
    }),
  );
  if (created && created.ok) {
    const url = typeof created.url === "string" ? created.url : "";
    deps.log(`issue #${issue}: gh pr create succeeded: ${url}`);
    return { opened: true, pr: { number: prNumberFromUrl(url), url, adopted: false } };
  }
  deps.log(
    `WARN gh pr create failed for issue #${issue} branch=${input.branch}: ${lastLine(created?.stderr)} — checking the open-PR list before treating this as a genuine failure`,
  );
  const listed = await safe(deps, "gh pr list (adopt lookup)", () => deps.listOpenPrs());
  const rows = listed && listed.ok ? listed.rows : [];
  const match = rows.find((row) => row.headRefName === input.branch) ?? null;
  if (match) {
    deps.log(
      `ANOMALY issue #${issue}: gh pr create failed but PR #${match.number} (${match.url}) already exists for branch=${input.branch} — adopting it instead of releasing the claim (see issue #3900)`,
    );
    const relabel = await safe(deps, `re-apply ${GLM_LABEL_AUTHORED} to adopted PR #${match.number}`, () =>
      deps.editIssueLabels(match.number, { add: [GLM_LABEL_AUTHORED] }),
    );
    if (!relabel || relabel.ok === false) {
      deps.log(
        `WARN failed to (re-)apply ${GLM_LABEL_AUTHORED} label to adopted PR #${match.number} (non-fatal)`,
      );
    }
    return { opened: true, pr: { number: match.number, url: match.url, adopted: true } };
  }
  deps.log(
    `ERROR gh pr create failed for issue #${issue} branch=${input.branch} and no existing PR found for that branch — genuine failure`,
  );
  return { opened: false, pr: null };
}

// --- file-backed counters --------------------------------------------------

function readTimeoutCounter(deps: FinishDeps, issue: number): number {
  try {
    return parseCapCount(deps.readFileIfExists(timeoutCounterFilePath(deps.config.capDir, issue)));
  } catch (err) {
    logger.warn({ err, issue }, "[glm-finish] timeout-counter read threw — treating as 0");
    return 0;
  }
}

function incrementTimeoutCounter(deps: FinishDeps, issue: number): number {
  const count = readTimeoutCounter(deps, issue) + 1;
  deps.writeFile(timeoutCounterFilePath(deps.config.capDir, issue), `${count}\n`);
  return count;
}

function removeTimeoutCounter(deps: FinishDeps, issue: number): void {
  try {
    deps.unlinkIfExists(timeoutCounterFilePath(deps.config.capDir, issue));
  } catch (err) {
    logger.warn({ err, issue }, "[glm-finish] timeout-counter removal threw (non-fatal)");
  }
}

function incrementDailyCap(deps: FinishDeps, nowMs: number): void {
  const path = capFilePath(deps.config.capDir, nowMs);
  const count = parseCapCount(deps.readFileIfExists(path));
  deps.writeFile(path, `${count + 1}\n`);
}

/** Only from evidence, AFTER the claim is freed (issue #4273 INV-2/INV-6). */
function recordQuotaBlockIf429(
  deps: FinishDeps,
  stdout: string,
  nowSec: number,
): number | null {
  const until = parseQuotaBlockStdout(stdout, nowSec, deps.config.quotaResetTzOffset);
  if (until === null) return null;
  deps.writeFile(quotaBlockFilePath(deps.config.capDir), `${until}\n`);
  deps.log(`recorded z.ai quota block until ${epochToIso(until)}`);
  return until;
}

// --- the dry-run would-walk (INV-12) ---------------------------------------

function dryRunFinish(
  deps: FinishDeps,
  input: FinishInput,
  outcome: AuthorOutcome,
): FinishResult {
  const issue = input.issue;
  logAuthorArm(deps, input, outcome);
  const timedOut = outcome.kind === "ran" && outcome.timedOut;
  if (timedOut) {
    deps.log(`would-increment timeout-counter for issue #${issue} (DRY_RUN=1)`);
  }
  const verdict = decideFinish({
    authorOutcome: outcome,
    commitCount: 0,
    prBodyPresent: false,
    timedOut,
    timeoutCount: 0,
    timeoutResumeCap: deps.config.timeoutResumeCap,
    preflightOk: null,
    prOpened: null,
    dryRun: true,
  });
  if (verdict.action === "release-not-authored") {
    if (input.worktree) deps.log(`would-remove-worktree ${input.worktree} (DRY_RUN=1)`);
    deps.log(`would-release issue #${issue} (in-progress -> ready-for-agent, withhold=false, DRY_RUN=1)`);
    return {
      action: "release-not-authored",
      issue,
      labels: [LABEL_READY],
      pr: null,
      quotaBlockedUntil: null,
      dryRun: true,
    };
  }
  // The open-pr would-path — rules 2/3 are skipped under dry-run, so every ran
  // outcome walks the happy fence in order (bash parity). No evidence is
  // gathered: zero gh/git/preflight/file-write dep calls (delta a).
  if (timedOut) {
    deps.log(`would-append GLM drainer timeout note to ${bodyFileAt(input.worktree as string)} (DRY_RUN=1)`);
  }
  deps.log("would-preflight (DRY_RUN=1)");
  deps.log(`preflight passed for issue #${issue} — opening PR`);
  deps.log(`would-open-pr issue #${issue} branch=${input.branch} (DRY_RUN=1)`);
  deps.log(`would-remove timeout-counter for issue #${issue} (DRY_RUN=1)`);
  deps.log(`would-advance issue #${issue} to needs-qa (DRY_RUN=1)`);
  deps.log("would-increment daily-cap counter (DRY_RUN=1)");
  deps.log(`issue #${issue}: PR opened (branch=${input.branch}), advanced to needs-qa, daily cap incremented`);
  if (input.worktree) deps.log(`would-remove-worktree ${input.worktree} (DRY_RUN=1)`);
  return {
    action: "open-pr",
    issue,
    labels: [LABEL_NEEDS_QA],
    pr: null,
    quotaBlockedUntil: null,
    dryRun: true,
  };
}

// --- the real path ---------------------------------------------------------

function logAuthorArm(deps: FinishDeps, input: FinishInput, outcome: AuthorOutcome): void {
  const issue = input.issue;
  if (outcome.kind === "driver-fault") {
    deps.log(
      `authoring driver FAULTED (exit=${input.authorExitCode}) for issue #${issue} — see driver stderr above`,
    );
  } else if (outcome.kind === "not-run") {
    deps.log(
      `authoring session did not run for issue #${issue}: ${outcome.code} — ${outcome.message || "no message from driver"}`,
    );
  } else {
    deps.log(
      `authoring session ended for issue #${issue} (timedOut=${outcome.timedOut}, exit=${outcome.code === null ? "null" : String(outcome.code)})`,
    );
  }
}

async function finishInner(deps: FinishDeps, input: FinishInput): Promise<FinishResult> {
  const issue = input.issue;
  const config = deps.config;
  const outcome = parseAuthorOutcome(input.authorRaw, input.authorExitCode);
  const nowMs = deps.now();
  const nowSec = Math.floor(nowMs / 1000);

  if (config.dryRun) return dryRunFinish(deps, input, outcome);

  logAuthorArm(deps, input, outcome);
  const ran = outcome.kind === "ran";
  const timedOut = ran && outcome.timedOut;
  const authorStdout = ran ? (outcome as { stdout: string }).stdout : "";

  // INV-4: a timed-out session FIRST increments the per-issue counter — the
  // count this increment reaches is what decideFinish's withhold rule reads.
  if (timedOut) incrementTimeoutCounter(deps, issue);
  const timeoutCount = readTimeoutCounter(deps, issue);

  const commitCount = ran && input.worktree ? await countCommits(deps, input.worktree) : 0;
  const bodyPresent = ran && input.worktree ? prBodyPresent(deps, input.worktree) : false;

  const base = {
    authorOutcome: outcome,
    timedOut,
    timeoutCount,
    timeoutResumeCap: config.timeoutResumeCap,
    dryRun: false,
  };
  let verdict = decideFinish({
    ...base,
    commitCount,
    prBodyPresent: bodyPresent,
    preflightOk: null,
    prOpened: null,
  });

  // The evidence loop: gather what `next` asks for, re-decide. At most three
  // iterations (preflight → create-pr → advance); rung order lives ONLY in
  // decideFinish (the artifact's rejected-alternative note).
  let preflightOk: boolean | null = null;
  let prOpened: boolean | null = null;
  let pr: FinishResult["pr"] = null;
  while (verdict.action === "open-pr") {
    if (verdict.next === "preflight") {
      // INV-4 open-pr order: defensive push, timeout note, fetch, changed
      // files, preflight.
      await defensivePush(deps, input);
      if (timedOut && input.worktree) appendTimeoutNote(deps, bodyFileAt(input.worktree));
      const changedPaths = await listChangedFiles(deps, input);
      const result = await safe(
        deps,
        "preflight",
        () => deps.preflight({ changedPaths }),
        // a rejecting scanner fails CLOSED (an unreadable gate is a closed gate)
      );
      if (result === undefined) {
        preflightOk = false;
        deps.log(
          `preflight BLOCKED for issue #${issue}: {"ok":false,"code":"glm-preflight-threw","message":"the preflight dependency rejected"}`,
        );
      } else {
        preflightOk = result.ok === true;
        if (preflightOk) {
          deps.log(`preflight passed for issue #${issue} — opening PR`);
        } else {
          deps.log(`preflight BLOCKED for issue #${issue}: ${JSON.stringify(result)}`);
        }
      }
      verdict = decideFinish({ ...base, commitCount, prBodyPresent: bodyPresent, preflightOk, prOpened });
      continue;
    }
    if (verdict.next === "create-pr") {
      const opened = await openOrAdoptPr(deps, input);
      prOpened = opened.opened;
      pr = opened.pr;
      verdict = decideFinish({ ...base, commitCount, prBodyPresent: bodyPresent, preflightOk, prOpened });
      continue;
    }
    break; // advance
  }

  switch (verdict.action) {
    case "release-not-authored": {
      await removeWorktreeIfPassed(deps, input.worktree);
      await releaseClaim(deps, issue, false);
      return {
        action: "release-not-authored",
        issue,
        labels: [LABEL_READY],
        pr: null,
        quotaBlockedUntil: null,
        dryRun: false,
      };
    }
    case "release-nothing-produced": {
      deps.log(`issue #${issue}: nothing usable produced (commits=0) — releasing claim`);
      await removeWorktreeIfPassed(deps, input.worktree);
      await deleteRemoteBranchIfPushed(deps, input.branch);
      if (verdict.withhold) logCapReached(deps, issue, timeoutCount, config.timeoutResumeCap);
      await releaseClaim(deps, issue, verdict.withhold);
      // D17: only from evidence, only on this arm, only AFTER the release.
      const quotaBlockedUntil = recordQuotaBlockIf429(deps, authorStdout, nowSec);
      return {
        action: "release-nothing-produced",
        issue,
        labels: verdict.withhold ? [LABEL_READY, LABEL_WITHHOLD] : [LABEL_READY],
        pr: null,
        quotaBlockedUntil,
        dryRun: false,
      };
    }
    case "keep-partial-for-resume": {
      await defensivePush(deps, input);
      deps.log(
        `issue #${issue}: partial work kept on origin/${input.branch} for resume (commits=${commitCount}, pr-body-present=no)`,
      );
      await removeWorktreeIfPassed(deps, input.worktree);
      // The remote branch deliberately STAYS — it is the resume record the
      // pick phase picks up next tick (issue #4337 INV-4/5).
      if (verdict.withhold) logCapReached(deps, issue, timeoutCount, config.timeoutResumeCap);
      await releaseClaim(deps, issue, verdict.withhold);
      return {
        action: "keep-partial-for-resume",
        issue,
        labels: verdict.withhold ? [LABEL_READY, LABEL_WITHHOLD] : [LABEL_READY],
        pr: null,
        quotaBlockedUntil: null,
        dryRun: false,
      };
    }
    case "withhold-preflight-blocked": {
      await removeWorktreeIfPassed(deps, input.worktree);
      await deleteRemoteBranchIfPushed(deps, input.branch);
      await releaseClaim(deps, issue, true); // always withhold — the T2/T3 fence hit
      // The timeout counter is deliberately untouched (INV-4).
      return {
        action: "withhold-preflight-blocked",
        issue,
        labels: [LABEL_READY, LABEL_WITHHOLD],
        pr: null,
        quotaBlockedUntil: null,
        dryRun: false,
      };
    }
    case "release-after-failed-pr": {
      deps.log(
        `PR creation failed for issue #${issue} — releasing claim (branch/worktree left for operator inspection)`,
      );
      if (verdict.withhold) logCapReached(deps, issue, timeoutCount, config.timeoutResumeCap);
      await releaseClaim(deps, issue, verdict.withhold);
      return {
        action: "release-after-failed-pr",
        issue,
        labels: verdict.withhold ? [LABEL_READY, LABEL_WITHHOLD] : [LABEL_READY],
        pr: null,
        quotaBlockedUntil: null,
        dryRun: false,
      };
    }
    case "open-pr": {
      // The advance: counter reset, needs-qa relabel, daily cap, worktree.
      removeTimeoutCounter(deps, issue); // INV-6: a PR opened — the budget resets
      await advanceToNeedsQa(deps, issue);
      incrementDailyCap(deps, nowMs);
      deps.log(
        `issue #${issue}: PR opened (branch=${input.branch}), advanced to needs-qa, daily cap incremented`,
      );
      await removeWorktreeIfPassed(deps, input.worktree);
      return {
        action: "open-pr",
        issue,
        labels: [LABEL_NEEDS_QA],
        pr,
        quotaBlockedUntil: null,
        dryRun: false,
      };
    }
  }
}

function logCapReached(deps: FinishDeps, issue: number, count: number, cap: number): void {
  deps.log(
    `issue #${issue}: timeout resume cap reached (${count}/${cap}) — releasing with glm-withhold so the Claude dev_orch lane takes this issue and its pushed branch over`,
  );
}

/**
 * Run the finish phase for one authoring attempt. Never throws: effect
 * failures WARN and continue; an unexpected fault is caught here, logged, and
 * followed by a best-effort plain release so the claim never stays
 * `in-progress` on a crash (the 90-min stale-claim recovery is the backstop,
 * not the plan).
 */
export async function runFinish(deps: FinishDeps, input: FinishInput): Promise<FinishResult> {
  try {
    return await finishInner(deps, input);
  } catch (err) {
    logger.error({ err, input }, "[glm-finish] finish phase threw — best-effort plain release");
    try {
      await releaseClaim(deps, input.issue, false);
    } catch (nested) {
      logger.error({ err: nested }, "[glm-finish] best-effort release also threw (non-fatal)");
    }
    return {
      action: "finish-fault",
      issue: input.issue,
      labels: [],
      pr: null,
      quotaBlockedUntil: null,
      dryRun: deps.config.dryRun,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Default (real) dependencies
// ---------------------------------------------------------------------------

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Build the production deps from an env (names match what bash read). */
export function buildDefaultFinishDeps(env: NodeJS.ProcessEnv = process.env): FinishDeps {
  const config = loadDrainerConfig(env);
  const repoRoot = config.repoRoot ?? DEFAULT_REPO_ROOT;
  return {
    config,
    repoRoot,
    now: () => Date.now(),
    log: (msg) => {
      process.stderr.write(`hydra-glm-drainer: ${msg}\n`);
    },
    editIssueLabels: (issue, labels) => editIssueLabels(issue, labels, { repo: config.repo }),
    viewIssueTitle: async (issue) => {
      const r = await viewIssue(issue, { repo: config.repo });
      return r.ok ? r.row.title : null;
    },
    createPr: (input) => createPr(input, { repo: config.repo }),
    listOpenPrs: async () => {
      const r = await listOpenPrs({
        repo: config.repo,
        state: "open",
        fields: "number,url,headRefName",
        limit: 100,
      });
      return isIssueReadFailure(r) ? { ok: false, rows: [] } : { ok: true, rows: r.rows };
    },
    runGit: async (args, cwd) => {
      const r = await gitExec(args, { cwd });
      return isGhFailure(r)
        ? { ok: false, stderr: r.stderr }
        : { ok: true, stdout: r.data.stdout, stderr: r.data.stderr };
    },
    removeWorktree: async (wt) => {
      const r = await worktreeRemove(wt, { cwd: repoRoot });
      return isGhFailure(r) ? { ok: false, stderr: r.stderr } : { ok: true };
    },
    pushBranchUpstream: async (branch, wt) => {
      const r = await pushBranchUpstream(branch, { cwd: wt });
      return isGhFailure(r) ? { ok: false, stderr: r.stderr } : { ok: true };
    },
    deleteRemoteBranch: async (branch) => {
      const r = await deleteRemoteBranch(branch, { cwd: repoRoot });
      return isGhFailure(r) ? { ok: false, stderr: r.stderr } : { ok: true };
    },
    remoteBranchExists: async (branch) => {
      const r = await lsRemoteHeads(branch, { cwd: repoRoot });
      return !isGhFailure(r) && r.data.length > 0;
    },
    preflight: (options) => preflightBeforePr(options),
    readFileIfExists: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if ((err as { code?: unknown })?.code !== "ENOENT") {
          logger.error({ err, path }, "[glm-finish] state file unreadable — treating as absent");
        }
        return null;
      }
    },
    writeFile: (path, content) => {
      try {
        writeFileSync(path, content);
      } catch (err) {
        logger.error({ err, path }, "[glm-finish] state file write failed (non-fatal)");
      }
    },
    unlinkIfExists: (path) => {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        logger.error({ err, path }, "[glm-finish] state file removal failed (non-fatal)");
      }
    },
    appendToFile: (path, text) => {
      appendFileSync(path, text);
    },
  };
}
