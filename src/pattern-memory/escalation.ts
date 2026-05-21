/**
 * learning/escalation.ts — Auto-escalate recurring learning patterns to
 * GitHub issues (issue #512).
 *
 * When `recordPattern()` records a pattern whose hit count crosses the
 * `PROMOTION_THRESHOLD` (3), it fires this escalation. The aim is that
 * chronic friction — the same kebab-case cue showing up across multiple
 * subagent runs — becomes tracked work, not just a feedback-file footnote.
 *
 * Idempotency
 * -----------
 * Each cue maps to a single GitHub issue. Lookup is by title-substring match
 * with the `meta-friction` label so reruns can:
 *   - if an OPEN issue exists, post a comment-bump (no duplicate)
 *   - if a CLOSED issue exists, reopen with a comment
 *   - otherwise, create a new issue with the `meta-friction` label
 *
 * Re-fire policy
 * --------------
 * The caller (`recordPattern`) only invokes this once per "interesting" hit:
 *   - on the threshold-cross (hitCount === PROMOTION_THRESHOLD)
 *   - on every subsequent multiple of 10 (hitCount === 13, 23, 33, ...)
 * This keeps the issue alive for chronic problems without spamming on every
 * single hit.
 *
 * Failure mode
 * ------------
 * Best-effort by design — `escalatePatternToIssue()` swallows all errors and
 * logs `console.error` with context. A missing `gh` binary, a network blip,
 * or a permissions problem must NEVER cause the parent `recordPattern()` call
 * to throw.
 *
 * Test seam
 * ---------
 * `HYDRA_GH_BIN` (env var) lets tests stub the `gh` CLI with a fake script.
 * When unset, the real `gh` on PATH is used. Tests also set
 * `HYDRA_ESCALATION_DISABLED=1` to disable the escalation entirely in
 * tests that exercise the threshold-cross hook without needing the gh path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO = process.env.HYDRA_GH_REPO || "gaberoo322/hydra";
const META_FRICTION_LABEL = "meta-friction";
const META_LESSON_LABEL = "meta-friction"; // share the label; titles distinguish

// ---------------------------------------------------------------------------
// Cue taxonomy (issue #524)
// ---------------------------------------------------------------------------
//
// The lesson-capture pipeline emits kebab-case `cue` strings that become the
// pattern category. Two cues are special-cased because QA reports them on
// nearly every PR with non-trivial acceptance criteria; conflating them caused
// the auto-escalation to fire on every operator-observable AC (issue #516):
//
//   acceptance-criterion-unmet     — the implementation didn't satisfy the
//                                    criterion. This is a true planner-quality
//                                    signal; promote + escalate aggressively.
//
//   acceptance-criterion-deferred  — the criterion requires post-deploy /
//                                    runtime / manual observation that
//                                    pre-merge QA *cannot* verify. This is
//                                    metadata about the AC's shape, not a
//                                    defect. The actionable signal is "the
//                                    pattern of deferred ACs has changed at
//                                    scale", not "this PR had a deferred AC."
//                                    Surface only at much higher thresholds.
//
// Any other cue uses the default threshold (`PROMOTION_THRESHOLD` = 3).
export const ACCEPTANCE_CRITERION_UNMET_CUE = "acceptance-criterion-unmet";
export const ACCEPTANCE_CRITERION_DEFERRED_CUE = "acceptance-criterion-deferred";

/**
 * Per-cue escalation thresholds. Cues not listed fall back to the caller's
 * `defaultThreshold` (currently `PROMOTION_THRESHOLD = 3` for both the
 * memory and friction namespaces).
 *
 * `acceptance-criterion-deferred` is the only escalator-only override today —
 * 20+ hits across distinct skills before opening a GitHub issue, because the
 * cue is expected to fire on nearly every PR with operator-observable ACs.
 */
const CUE_ESCALATION_THRESHOLDS: Record<string, number> = {
  [ACCEPTANCE_CRITERION_DEFERRED_CUE]: 20,
};

/**
 * Resolve the escalation threshold for a given cue. Returns the cue's
 * override when one is registered, otherwise the supplied default. Exported
 * for tests and for `agent-memory.ts`'s `maybeEscalate()`.
 */
export function escalationThresholdForCue(
  cue: string,
  defaultThreshold: number,
): number {
  if (typeof cue !== "string") return defaultThreshold;
  const override = CUE_ESCALATION_THRESHOLDS[cue];
  return typeof override === "number" && override > 0 ? override : defaultThreshold;
}

/**
 * True when a cue is metadata about the AC's shape rather than a defect
 * signal. Used by `agent-memory.ts` to skip the `to-{agent}.md` feedback-file
 * promotion — deferred ACs aren't actionable rules for the planner, so
 * surfacing them as cardinal rules would just create noise (issue #524).
 *
 * Pattern recording still happens, so the dashboard / friction-patterns
 * endpoint can show deferred-cue hit counts; only the file write is skipped.
 */
export function isMetadataCue(cue: string): boolean {
  return cue === ACCEPTANCE_CRITERION_DEFERRED_CUE;
}

export type EscalationKind = "friction" | "lesson";

export type EscalationInput = {
  /** Pattern namespace — `friction` or `lesson` (memory). */
  kind: EscalationKind;
  /** kebab-case cue / category, used as the title anchor for idempotency. */
  cue: string;
  /** Current hit count when the escalation fires. */
  hitCount: number;
  /** Skill(s) that have hit this cue (best-known list, possibly just the latest). */
  skills: string[];
  /**
   * Workarounds and recent context lines. Each entry should be a single line;
   * the body builder formats them as a bullet list.
   */
  workarounds?: string[];
  /**
   * Optional last cycle ID / PR reference. Surfaces in the body so an
   * operator can jump back to the originating run.
   */
  lastReference?: string;
};

export type EscalationResult =
  | { status: "created"; issueNumber: number }
  | { status: "commented"; issueNumber: number }
  | { status: "reopened"; issueNumber: number }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

function ghBin(): string {
  return process.env.HYDRA_GH_BIN || "gh";
}

function isDisabled(): boolean {
  const raw = process.env.HYDRA_ESCALATION_DISABLED;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

function buildTitle(input: EscalationInput): string {
  const skills = input.skills.length > 0 ? input.skills.join(", ") : "subagents";
  if (input.kind === "friction") {
    return `meta(friction): ${input.cue} hit ${input.hitCount} times across ${skills}`;
  }
  return `meta(lesson): ${input.cue} hit ${input.hitCount} times`;
}

function buildBody(input: EscalationInput): string {
  const parts: string[] = [];
  parts.push(
    `Auto-escalated by the learning system after ${input.hitCount} hits on cue \`${input.cue}\`.`,
  );
  parts.push("");
  parts.push(`**Kind:** ${input.kind}`);
  parts.push(`**Skills:** ${input.skills.length > 0 ? input.skills.join(", ") : "(unknown)"}`);
  parts.push(`**Hit count:** ${input.hitCount}`);
  if (input.lastReference) {
    parts.push(`**Last reference:** ${input.lastReference}`);
  }
  if (input.workarounds && input.workarounds.length > 0) {
    parts.push("");
    parts.push("**Workarounds / context tried:**");
    for (const w of input.workarounds.slice(0, 10)) {
      parts.push(`- ${w}`);
    }
  }
  parts.push("");
  parts.push(
    "<!-- escalated by src/pattern-memory/escalation.ts. Idempotent: re-runs comment-bump or reopen instead of duplicating. -->",
  );
  return parts.join("\n");
}

function buildCommentBody(input: EscalationInput): string {
  const parts: string[] = [];
  parts.push(`Pattern still firing — now ${input.hitCount} hits on \`${input.cue}\`.`);
  if (input.lastReference) {
    parts.push(`Last reference: ${input.lastReference}`);
  }
  if (input.workarounds && input.workarounds.length > 0) {
    parts.push("");
    parts.push("Recent workarounds:");
    for (const w of input.workarounds.slice(0, 5)) {
      parts.push(`- ${w}`);
    }
  }
  return parts.join("\n");
}

async function runGh(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(ghBin(), args, { timeout: 15000 });
  return { stdout, stderr };
}

type ExistingIssue = { number: number; state: "OPEN" | "CLOSED"; title: string };

/**
 * Find an existing meta-friction issue matching this cue. Returns the
 * newest match. Pure-ish — the only side effect is the gh call.
 */
export async function findExistingIssue(cue: string): Promise<ExistingIssue | null> {
  // `gh issue list --search` uses GitHub's search syntax; quoting the cue
  // anchors the title match.
  const args = [
    "issue",
    "list",
    "--repo",
    REPO,
    "--search",
    `in:title "${cue}" label:${META_FRICTION_LABEL}`,
    "--state",
    "all",
    "--json",
    "number,state,title",
    "--limit",
    "5",
  ];
  const { stdout } = await runGh(args);
  let parsed: any[];
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  // gh returns newest first; pick the first whose title actually contains the cue.
  for (const row of parsed) {
    if (typeof row?.title === "string" && row.title.includes(cue)) {
      return {
        number: row.number,
        state: String(row.state).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
        title: row.title,
      };
    }
  }
  return null;
}

/**
 * Ensure the `meta-friction` label exists on the repo. Best-effort; the
 * label-create call is harmless when the label already exists (gh returns
 * a non-zero exit which we swallow).
 */
async function ensureLabel(): Promise<void> {
  try {
    await runGh([
      "label",
      "create",
      META_FRICTION_LABEL,
      "--repo",
      REPO,
      "--description",
      "Auto-escalated friction or lesson pattern from the learning system (issue #512)",
      "--color",
      "FBCA04",
      "--force",
    ]);
  } catch (err: any) {
    // `--force` makes gh treat "exists" as success on modern gh; older gh
    // versions exit non-zero. Either way we swallow — the create-issue call
    // will fail loudly later if the label genuinely doesn't exist.
    const msg = String(err?.stderr || err?.message || "");
    if (!/already exists/i.test(msg)) {
      console.error(`[escalation] ensureLabel best-effort error: ${msg.slice(0, 200)}`);
    }
  }
}

async function createIssue(input: EscalationInput): Promise<number> {
  await ensureLabel();
  const title = buildTitle(input);
  const body = buildBody(input);
  const args = [
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    title,
    "--body",
    body,
    "--label",
    META_FRICTION_LABEL,
  ];
  const { stdout } = await runGh(args);
  // gh prints the issue URL on success. Parse the trailing number.
  const m = stdout.match(/\/issues\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function commentOnIssue(issueNumber: number, input: EscalationInput): Promise<void> {
  const body = buildCommentBody(input);
  await runGh([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    REPO,
    "--body",
    body,
  ]);
}

async function reopenIssue(issueNumber: number): Promise<void> {
  await runGh(["issue", "reopen", String(issueNumber), "--repo", REPO]);
}

/**
 * Public entry — escalate a pattern to a GitHub issue. Best-effort:
 * always resolves; never throws. Caller (`recordPattern`) does not need to
 * await the result for correctness, but awaiting is recommended so the audit
 * log captures the outcome.
 */
export async function escalatePatternToIssue(
  input: EscalationInput,
): Promise<EscalationResult> {
  if (isDisabled()) {
    return { status: "skipped", reason: "HYDRA_ESCALATION_DISABLED set" };
  }
  if (typeof input?.cue !== "string" || input.cue.trim().length === 0) {
    return { status: "skipped", reason: "empty cue" };
  }

  try {
    const existing = await findExistingIssue(input.cue);
    if (existing && existing.state === "OPEN") {
      await commentOnIssue(existing.number, input);
      return { status: "commented", issueNumber: existing.number };
    }
    if (existing && existing.state === "CLOSED") {
      await reopenIssue(existing.number);
      await commentOnIssue(existing.number, input);
      return { status: "reopened", issueNumber: existing.number };
    }
    const num = await createIssue(input);
    return { status: "created", issueNumber: num };
  } catch (err: any) {
    const msg = err?.stderr ? String(err.stderr).slice(0, 500) : err?.message || String(err);
    console.error(`[escalation] escalatePatternToIssue failed for cue "${input.cue}": ${msg}`);
    return { status: "error", error: msg };
  }
}

/**
 * Pure helper — decide whether the current hit count is one that should fire
 * an escalation. Threshold-cross plus every multiple of 10 thereafter.
 * Exported for tests.
 */
export function shouldEscalateAtHitCount(
  hitCount: number,
  promotionThreshold: number,
): boolean {
  if (hitCount === promotionThreshold) return true;
  if (hitCount > promotionThreshold && (hitCount - promotionThreshold) % 10 === 0) return true;
  return false;
}

/**
 * Dispatch helper — call from a `recordPattern()` caller that wants the
 * default "fire if the recording produced an escalation intent" behaviour.
 *
 * The seam is intentional: `recordPattern()` is a pure Redis writer that
 * returns an optional `EscalationInput`; this helper turns that intent into a
 * GitHub-side write. Callers that don't want the dispatch (notably tests
 * exercising pattern accounting in isolation) simply don't call this.
 *
 * Best-effort by design: errors are logged with the caller-supplied `context`
 * label and swallowed. Never throws.
 */
export async function escalateIfNeeded(
  escalation: EscalationInput | null,
  context: string,
): Promise<void> {
  if (!escalation) return;
  try {
    await escalatePatternToIssue(escalation);
  } catch (err: any) {
    // `escalatePatternToIssue` already swallows its own errors and returns an
    // EscalationResult, so this catch is defence-in-depth for a programming
    // error in the dispatcher itself.
    console.error(`[escalation] escalateIfNeeded(${context}) failed: ${err?.message || err}`);
  }
}
