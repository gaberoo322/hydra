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
 *
 * GitHub CLI Adapter (issue #896)
 * -------------------------------
 * This module was the tracer-bullet caller migrated onto the `src/github/`
 * seam. Its private `runGh()`/`ghBin()` folded into `github/exec.ts` +
 * `github/gh.ts` — `gh` invocations now go through `ghExec()` / `ghJson()`,
 * which own the `HYDRA_GH_BIN` override, the 15s timeout, and the four error
 * modes. The accessors return a discriminated result and never throw; the
 * existing best-effort try/catch in `escalatePatternToIssue()` is preserved as
 * defence-in-depth, but the failure path is now driven by `result.ok === false`.
 */

import { ghExec, ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";

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
const ACCEPTANCE_CRITERION_DEFERRED_CUE = "acceptance-criterion-deferred";

// ---------------------------------------------------------------------------
// Cue alias table (issue #2527)
// ---------------------------------------------------------------------------
//
// The fuzzy cue-deduplication algorithm in cue-matcher.ts (overlap coefficient
// >= 0.6) handles SIMILAR spellings of the same gotcha automatically. But some
// high-recurrence friction clusters fragment across cues that are lexically
// TOO DIFFERENT to merge by token overlap — the five worktree write-fence
// fragments are the canonical example (~135 total hits spread across five cues,
// none individually crossing the auto-escalation threshold):
//
//   worktree-write-fence-blocks-entered-worktree      (51 hits)
//   edit-tool-ghost-writes-to-main-checkout-not-worktree  (50 hits)
//   edit-resolved-to-main-checkout-needs-worktree-path    (17 hits)
//   enterworktree-pinned-agent-write-fence-mismatch   (16 hits)
//   enterworktree-anchor-desync-blocks-write-tool      (1 hit)
//
// The alias table maps every known variant to ONE canonical cue so that
// `canonicalizeCue()` can normalise the incoming cue BEFORE the fuzzy-merge
// step in `recordPattern`. The canonical cue is the one used for escalation,
// pattern storage, and the feedback-file key — variants are demoted to aliases.
//
// When to add a new entry: when a /hydra-retro surfaces a cue cluster whose
// members score < 0.6 against each other (or against the desired canonical)
// and the aggregate hit count is already worth an escalation. Mirror the #2521
// approach for the cleanup cluster: pick the most descriptive spelling as
// canonical, map all siblings to it.
//
// The alias table is FRICTION-NAMESPACE ONLY (design invariant 1 from #1667):
// memory-namespace cues are deliberate identifiers with per-cue escalation
// thresholds; a forced alias there would corrupt those thresholds. The
// `canonicalizeCue()` caller in `agent-memory.ts` applies the mapping only
// when `namespace === "friction"`.
const CUE_ALIAS_TABLE: Readonly<Record<string, string>> = {
  // Worktree write-fence desync cluster (issue #2527).
  // All five cues describe the same root failure: the harness write-fence /
  // anchor not aligned with the worktree the agent is actually in.
  "worktree-write-fence-blocks-entered-worktree": "worktree-write-fence-desync",
  "edit-tool-ghost-writes-to-main-checkout-not-worktree": "worktree-write-fence-desync",
  "edit-resolved-to-main-checkout-needs-worktree-path": "worktree-write-fence-desync",
  "enterworktree-pinned-agent-write-fence-mismatch": "worktree-write-fence-desync",
  "enterworktree-anchor-desync-blocks-write-tool": "worktree-write-fence-desync",
};

/**
 * Map a raw friction cue to its canonical form using the explicit alias table.
 * Returns the canonical cue when a mapping exists, otherwise the original cue
 * unchanged. Applies to FRICTION NAMESPACE ONLY — callers in the memory
 * namespace must not call this (per design invariant 1, #1667).
 *
 * This is the complement to the fuzzy overlap-coefficient merge in
 * `findPatternForCue` (cue-matcher.ts): the fuzzy layer handles SIMILAR
 * spellings automatically; this layer handles lexically DISTANT variants of
 * the same gotcha that score below the 0.6 merge threshold.
 *
 * Exported for tests and for `agent-memory.ts`'s `recordPattern`.
 */
export function canonicalizeCue(cue: string): string {
  if (typeof cue !== "string") return cue;
  return CUE_ALIAS_TABLE[cue] ?? cue;
}

// Expected-telemetry cue (issue #1789). The hydra-target-build Step-2
// inline-mode contract (#1782) mandates a friction-log POST with this exact
// cue on EVERY autopilot-dispatched inline build — by design — because the
// dispatch session never grows an Agent/Task spawn tool. The hit count is
// useful inline-mode frequency telemetry (kept visible on
// /learning/friction-patterns), but it is NOT chronic friction to escalate:
// any finite threshold just defers noise, then the escalator reopens the
// closed #1789 forever. Mapped to POSITIVE_INFINITY so the cue never produces
// an EscalationInput — the inline-mode decision record is the #1782 contract
// itself, not a recurring GitHub issue.
const NO_AGENT_SPAWN_TOOL_RUN_INLINE_CUE = "no-agent-spawn-tool-run-inline";

/**
 * Per-cue escalation thresholds. Cues not listed fall back to the caller's
 * `defaultThreshold` (currently `PROMOTION_THRESHOLD = 3` for both the
 * memory and friction namespaces).
 *
 * `acceptance-criterion-deferred` raises the bar to 20+ hits across distinct
 * skills before opening a GitHub issue, because the cue is expected to fire on
 * nearly every PR with operator-observable ACs.
 *
 * `no-agent-spawn-tool-run-inline` uses `Number.POSITIVE_INFINITY` — the
 * never-escalate sentinel. `escalationThresholdForCue` accepts any override
 * `> 0` (Infinity qualifies) and `shouldEscalateAtHitCount(n, Infinity)` is
 * false for every finite hit count, so the cue never escalates while its hit
 * count keeps accumulating as telemetry (issue #1789).
 */
const CUE_ESCALATION_THRESHOLDS: Record<string, number> = {
  [ACCEPTANCE_CRITERION_DEFERRED_CUE]: 20,
  [NO_AGENT_SPAWN_TOOL_RUN_INLINE_CUE]: Number.POSITIVE_INFINITY,
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

type EscalationKind = "friction" | "lesson";

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

/**
 * Thrown when a `gh` invocation fails at the process level (non-zero exit,
 * timeout, binary missing). Carries the seam's machine-readable `code` so the
 * top-level `escalatePatternToIssue` catch can surface it. This is internal to
 * escalation.ts — the seam itself never throws; this adapts the seam's
 * result-object failure arm back onto the module's existing throw-and-catch
 * best-effort flow.
 */
class GhInvocationError extends Error {
  readonly code: string;
  constructor(code: string, stderr: string) {
    super(stderr || `gh failed: ${code}`);
    this.name = "GhInvocationError";
    this.code = code;
  }
}

type ExistingIssue = { number: number; state: "OPEN" | "CLOSED"; title: string };

/**
 * Find an existing meta-friction issue matching this cue. Returns the
 * newest match. Side effect: the gh call (now via the `src/github/` seam).
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
  const result = await ghJson<any[]>(args);
  if (isGhFailure(result)) {
    // gh-empty / gh-malformed-json mean "no usable existing match" — degrade to
    // null (the create path), matching the pre-seam JSON.parse-failure behavior.
    if (result.code === "gh-empty" || result.code === "gh-malformed-json") return null;
    // A real process failure (non-zero exit, timeout, missing binary) propagates
    // so the top-level catch records status="error", as before.
    throw new GhInvocationError(result.code, result.stderr);
  }
  const parsed = result.data;
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
  const result = await ghExec([
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
  // `--force` makes gh treat "exists" as success on modern gh; older gh
  // versions exit non-zero. Either way we swallow — the create-issue call
  // will fail loudly later if the label genuinely doesn't exist. The seam has
  // already logged the failure with context, so a non-"already exists" miss is
  // visible without an extra log line here.
  if (isGhFailure(result) && !/already exists/i.test(result.stderr)) {
    /* intentional: best-effort label-create; seam logged it, create-issue fails loud later */
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
  const result = await ghExec(args);
  if (isGhFailure(result)) throw new GhInvocationError(result.code, result.stderr);
  // gh prints the issue URL on success. Parse the trailing number.
  const m = result.data.stdout.match(/\/issues\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function commentOnIssue(issueNumber: number, input: EscalationInput): Promise<void> {
  const body = buildCommentBody(input);
  const result = await ghExec([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    REPO,
    "--body",
    body,
  ]);
  if (isGhFailure(result)) throw new GhInvocationError(result.code, result.stderr);
}

async function reopenIssue(issueNumber: number): Promise<void> {
  const result = await ghExec(["issue", "reopen", String(issueNumber), "--repo", REPO]);
  if (isGhFailure(result)) throw new GhInvocationError(result.code, result.stderr);
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
 * Returns the **Escalation Outcome** (the `EscalationResult` produced by
 * `escalatePatternToIssue`) so the caller can thread it up and stamp it on the
 * pattern record (issue #843), or `null` when no escalation fired (the intent
 * was null). Previously the outcome was discarded and this returned `void`,
 * which left a systematic gh/auth outage invisible to operators — now an outage
 * surfaces as a value (`{ status: "error", error }`), strictly better
 * fail-loud posture.
 *
 * Best-effort by design: errors are logged with the caller-supplied `context`
 * label and swallowed. Never throws.
 */
export async function escalateIfNeeded(
  escalation: EscalationInput | null,
  context: string,
): Promise<EscalationResult | null> {
  if (!escalation) return null;
  try {
    return await escalatePatternToIssue(escalation);
  } catch (err: any) {
    // `escalatePatternToIssue` already swallows its own errors and returns an
    // EscalationResult, so this catch is defence-in-depth for a programming
    // error in the dispatcher itself. Return the outcome as a value rather than
    // a bare log line so the caller can stamp it (issue #843).
    const msg = err?.message || String(err);
    console.error(`[escalation] escalateIfNeeded(${context}) failed: ${msg}`);
    return { status: "error", error: msg };
  }
}
