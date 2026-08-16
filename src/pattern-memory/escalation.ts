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
 *   - if an OPEN issue exists, post a comment-bump (no duplicate) — rate-gated
 *     for the two steady-rate cues (issue #3850)
 *   - if a CLOSED issue exists, reopen with a comment — ALSO rate-gated for the
 *     same two steady-rate cues (issue #4073): closing the issue must not be
 *     the thing that routes the next hit around the gate. Non-rate-gated cues
 *     still reopen unconditionally, as before.
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
import { addIssueLabel, isIssueLabelWriteFailure } from "../github/issues.ts";
import { logger } from "../logger.ts";
// Issue #3850 / #4073 — the rate-vs-baseline gate for steady-rate cues is
// composed of a pure parser/decision pair in the zero-IO cue-policy leaf
// (parseEscalationBumpSeries / shouldRateEscalate) plus the rate-gated-cue
// predicate. escalation.ts owns the GitHub-IO fetch that feeds them; cue-policy
// owns the math. Import direction is one-way, as for the existing policy helpers.
// The gate now applies to BOTH the OPEN-issue comment-bump branch (#3850) and
// the CLOSED-issue reopen branch (#4073) — see `rateGateSkipReason` below.
import {
  isRateGatedCue,
  parseEscalationBumpSeries,
  shouldRateEscalate,
  RATE_ESCALATION_WINDOW_DAYS,
  RATE_ESCALATION_MULTIPLIER,
} from "./cue-policy.ts";

const REPO = process.env.HYDRA_GH_REPO || "gaberoo322/hydra";
const META_FRICTION_LABEL = "meta-friction";
const META_LESSON_LABEL = "meta-friction"; // share the label; titles distinguish

// ---------------------------------------------------------------------------
// Cue policy moved out (issue #2569)
// ---------------------------------------------------------------------------
//
// The pure cue-promotion *policy* — the cue alias table (`CUE_ALIAS_TABLE` /
// `canonicalizeCue`), the per-cue escalation thresholds
// (`escalationThresholdForCue`), and the pure predicates (`isMetadataCue`,
// `shouldEscalateAtHitCount`) — now lives in the zero-IO leaf
// `./cue-policy.ts`. Callers that only need the policy (decision.ts,
// agent-memory.ts, the friction-dedup tests, the dashboard aggregators) import
// it from there directly, so they no longer pull in `ghExec`/`ghJson` (and the
// `../github/*` chain behind them) at module-load time. This module keeps the
// GitHub-IO escalation *adapter* only.

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
/**
 * Issue #3850 — the slice of an issue's history the rate-vs-baseline gate
 * reads: the creation body (its "after N hits" line is the baseline origin)
 * and the comment trail (each "Pattern still firing — now N hits" comment is
 * a past successful bump). `createdAt` is the issue's own creation timestamp.
 */
type IssueHistory = {
  createdAt: string;
  body: string;
  comments: Array<{ body: string; createdAt: string }>;
};

/**
 * Issue #3850 — fetch a cue's escalation-issue body + comment trail for the
 * rate-vs-baseline gate. Best-effort: returns null on ANY gh failure (auth,
 * network, rate-limit, malformed/empty JSON) or on a missing/malformed shape,
 * so the caller fails OPEN (posts the bump unconditionally) rather than
 * silently suppressing a possibly-genuine rising-rate signal. Rides the
 * existing ghJson seam; never throws.
 */
async function fetchIssueHistory(issueNumber: number): Promise<IssueHistory | null> {
  const result = await ghJson<any>([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    REPO,
    "--json",
    "createdAt,body,comments",
  ]);
  if (isGhFailure(result)) {
    logger.warn(
      { issueNumber, code: result.code, stderr: result.stderr.slice(0, 200) },
      "rate-gate: issue-history fetch failed — failing open to unconditional bump",
    );
    return null;
  }
  const data = result.data;
  if (!data || typeof data.body !== "string" || typeof data.createdAt !== "string") return null;
  const rawComments = Array.isArray(data.comments) ? data.comments : [];
  const comments = rawComments
    .filter(
      (c: any) => c && typeof c.body === "string" && typeof c.createdAt === "string",
    )
    .map((c: any) => ({ body: c.body, createdAt: c.createdAt }));
  return { createdAt: data.createdAt, body: data.body, comments };
}

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

/** Issue #4073 — the label a reopened escalation issue is routed to by default. */
const DEFAULT_REOPEN_LABEL = "ready-for-human";

/**
 * Issue #4073 — re-apply a lifecycle label after a reopen. The closing paths
 * (operator review, automated sweep) strip whatever lifecycle label was
 * present, and `reopenIssue()` itself restores nothing, so every reopened
 * escalation issue previously arrived as a label-less untriaged orphan —
 * forcing the sweep to re-route it and consuming an operator-review slot on
 * every single cycle (issue #2528's own timeline shows `unlabeled
 * ready-for-human` / `unlabeled needs-triage` on each of its four reopens).
 * Defaults to `ready-for-human`: the escalation itself IS the operator-facing
 * signal, so routing a freshly-reopened issue straight to the human-review
 * lane is the correct default absent a recorded "label present at close" to
 * restore verbatim. Best-effort — a label-add failure must not fail the
 * reopen it follows (which has already succeeded); logged for visibility via
 * the same seam `addIssueLabel` already uses.
 */
async function restoreLifecycleLabel(issueNumber: number): Promise<void> {
  const result = await addIssueLabel(issueNumber, DEFAULT_REOPEN_LABEL, { repo: REPO });
  if (isIssueLabelWriteFailure(result)) {
    logger.warn(
      { issueNumber, code: result.code, stderr: result.stderr.slice(0, 200) },
      "restoreLifecycleLabel: gh issue edit --add-label failed — issue may remain label-less",
    );
  }
}

/**
 * Issue #3850 / #4073 — shared rate-vs-baseline skip decision, used by BOTH
 * the OPEN-issue comment-bump branch and the CLOSED-issue reopen branch. Only
 * called when `isRateGatedCue(cue)` is true (the caller checks). Returns a
 * skip reason string when the cue's recent hit rate has not risen above its
 * own creation-anchored baseline; returns `null` ("do not suppress") when the
 * caller should proceed — including the fail-open case where
 * `fetchIssueHistory()` itself failed, so a possibly-genuine rising-rate
 * signal is never silently swallowed by a transient gh/auth/network blip.
 */
async function rateGateSkipReason(
  issueNumber: number,
  hitCount: number,
): Promise<string | null> {
  const history = await fetchIssueHistory(issueNumber);
  // history === null → gh fetch failed → fail OPEN: proceed unconditionally
  // rather than suppress a possibly-genuine rising-rate signal.
  if (history === null) return null;
  const series = parseEscalationBumpSeries(history.body, history.createdAt, history.comments);
  if (shouldRateEscalate(series, hitCount, new Date().toISOString())) return null;
  return (
    `rate-gated: recent rate not above baseline ` +
    `(window=${RATE_ESCALATION_WINDOW_DAYS}d, multiplier=${RATE_ESCALATION_MULTIPLIER})`
  );
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
      // Issue #3850 — rate-gate the OPEN-issue comment-bump path for the two
      // steady-rate cues (acceptance-criterion-unmet / -deferred). Their
      // cumulative-count threshold (150 / 20) re-bumps every +10 hits forever
      // because the count only rises while the rate is ~constant; this gate
      // suppresses a bump whose recent rate has not risen above the cue's own
      // creation-anchored baseline. Issue CREATION (handled below,
      // findExistingIssue → null) is NEVER gated — a first occurrence is
      // always informative. Non-rate-gated cues never reach this branch.
      if (isRateGatedCue(input.cue)) {
        const skipReason = await rateGateSkipReason(existing.number, input.hitCount);
        if (skipReason !== null) {
          return { status: "skipped", reason: skipReason };
        }
      }
      await commentOnIssue(existing.number, input);
      return { status: "commented", issueNumber: existing.number };
    }
    if (existing && existing.state === "CLOSED") {
      // Issue #4073 — the CLOSED→reopen path now applies the SAME
      // rate-vs-baseline gate as the OPEN comment-bump path above, for the
      // same two rate-gated cues. Before this fix the reopen path was NEVER
      // gated, on the premise that "any post-close recurrence is always
      // informative" — true for a bursty cue, but exactly inverted for a
      // steady-rate cue: a post-close recurrence is near-guaranteed within
      // days, so closing the issue was precisely what routed the next hit
      // around the OPEN-path gate (issue #2528: 4 reopens in 15 days, every
      // one via this path, the rate gate never once applying to it).
      // Non-rate-gated cues are unaffected — they still reopen
      // unconditionally, exactly as before.
      if (isRateGatedCue(input.cue)) {
        const skipReason = await rateGateSkipReason(existing.number, input.hitCount);
        if (skipReason !== null) {
          return { status: "skipped", reason: skipReason };
        }
      }
      await reopenIssue(existing.number);
      // Re-apply a lifecycle label so a reopen never lands as a label-less
      // untriaged orphan (issue #4073) — best-effort, does not affect the
      // already-successful reopen/comment outcome below.
      await restoreLifecycleLabel(existing.number);
      await commentOnIssue(existing.number, input);
      return { status: "reopened", issueNumber: existing.number };
    }
    const num = await createIssue(input);
    return { status: "created", issueNumber: num };
  } catch (err: any) {
    const msg = err?.stderr ? String(err.stderr).slice(0, 500) : err?.message || String(err);
    logger.error({ err, cue: input.cue }, "escalatePatternToIssue failed");
    return { status: "error", error: msg };
  }
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
    logger.error({ err, context }, "escalateIfNeeded failed");
    return { status: "error", error: msg };
  }
}
