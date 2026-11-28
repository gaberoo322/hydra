/**
 * src/qa/round-action.ts — the round-action phase: the T4 deep-QA remediation loop + PASS marker (the T1-T3 round cap is the lifecycle seam's Cap Arm).
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { logger } from "../logger.ts";
import { isVerifierCore } from "../untouchable.ts";
import type { ReviewVerdict } from "./admission.ts";
import { classifyQaFixPath } from "./fix-proof.ts";
import { detectOneWayDoor, requiresOneWayDepth } from "./one-way-door.ts";
import type { ReviewerCommitsValue } from "./rollout-switches.ts";
import { FOLLOW_UPS_HEADING } from "./fold.ts";
import { DEEP_QA_FAIL_MARKER } from "../lifecycle/caps.ts";
import type { FinalVerdict } from "./verdict-trailer.ts";

/**
 * T4 Deep-QA Remediation Loop (issue #740, ADR-0015; #5662).
 *
 * T4 inherits the full T3 adversarial depth (the two-reviewer refutation
 * fan-out folded by `aggregateAdversarialReview`) and ADDS the
 * **Verifier-Core checklist**. Its FAIL routing is NOT decided here: every QA FAIL
 * exits through `qaBounce`, and the lifecycle seam's `deep-qa-fails` Cap Arm
 * (`src/lifecycle/caps.ts`) counts the `DEEP_QA_FAIL_MARKER` comments on the PR
 * since the latest `Hydra-Cap-Reset:` and escalates the second to
 * `ready-for-human` (`t4-deep-qa-exhausted`). This module only renders the two
 * markers (FAIL here, SHA-bound PASS below).
 */

/**
 * The machine-greppable marker every T4 deep-QA FAIL comment MUST contain on
 * its own line. The seam's `deep-qa-fails` arm counts occurrences of this
 * literal across the PR's comments. Single source: `src/lifecycle/caps.ts`.
 */
export { DEEP_QA_FAIL_MARKER };

/**
 * The base literal of the positive Deep-QA PASS marker (ADR-0020, issue #847).
 *
 * This is the SHA-bound proof that a T4 PR cleared the deep-QA branch — the
 * positive counterpart to `DEEP_QA_FAIL_MARKER`, on the same PR-as-ledger
 * surface #740 blessed (no new verdict literal, Redis key, or label). On a T4
 * PASS, `hydra-qa` posts a PR comment carrying the rendered marker line
 * `Verifier-Core deep-QA: PASS @ <head-sha>`; the `deep-qa-gate` required CI
 * check (`.github/workflows/deep-qa-gate.yml`) verifies a marker matching the
 * PR's CURRENT head SHA before a T4 PR may merge.
 *
 * Changing this string is a breaking change to BOTH the `hydra-qa` playbook
 * (which posts it via `renderDeepQaPassMarker`) and the gate (which greps it
 * via `hasFreshDeepQaPass`) — keep this constant the single source of truth.
 */
export const DEEP_QA_PASS_MARKER = "Verifier-Core deep-QA: PASS";

/**
 * Render the exact Deep-QA PASS marker line for a given head SHA.
 *
 * Produces `Verifier-Core deep-QA: PASS @ <head-sha>` — the literal line the
 * `hydra-qa` T4 PASS path posts (on its own line) and the line
 * `hasFreshDeepQaPass` greps for. Pure — no fs/network.
 *
 * @param headSha the PR's current head commit SHA (e.g. from
 *   `gh pr view --json headRefOid`). Trimmed; passed through verbatim
 *   otherwise so the marker is byte-for-byte reproducible by the gate.
 */
export function renderDeepQaPassMarker(headSha: string): string {
  return `${DEEP_QA_PASS_MARKER} @ ${headSha.trim()}`;
}

/**
 * True iff some comment carries a fresh Deep-QA PASS marker — one matching
 * THIS head SHA. The freshness check is what makes the proof SHA-bound
 * (ADR-0020 Decision 2): pushing new commits after a pass changes the head
 * SHA, so a marker for the old SHA no longer satisfies the gate and forces
 * re-QA. A blank/whitespace `headSha` never matches (defensive — an unknown
 * head SHA must never satisfy the gate). Pure — no fs/network.
 *
 * Matching is `String.includes` of the rendered marker line, mirroring how
 * the seam counts `DEEP_QA_FAIL_MARKER` — the marker is one line
 * inside a larger comment body, not the whole body.
 *
 * @param commentBodies the PR's comment bodies (order irrelevant).
 * @param headSha the PR's current head commit SHA the marker must match.
 */
export function hasFreshDeepQaPass(
  commentBodies: readonly string[],
  headSha: string,
): boolean {
  const trimmed = headSha.trim();
  if (trimmed.length === 0) return false;
  const marker = renderDeepQaPassMarker(trimmed);
  return commentBodies.some((body) => body.includes(marker));
}

// ---------------------------------------------------------------------------
// Convergent QA (issue #4735): the admission-skip marker.
//
// The round cap itself is a Cap Arm owned by the lifecycle seam (`qaBounce` parks
// the 3rd reviewed FAIL round, ADR-0047 D6); nothing in this module decides it.
// ---------------------------------------------------------------------------

/**
 * The marker text the step-6.6 admission-gate skip path puts in its
 * `REVIEW_REPORT` (issue #4758). Step 10's `CURRENT_REVIEWED` case greps this
 * literal so a CI-only skip round never counts toward the round cap. Both
 * sites are shell in the playbook, so no TS code reads this constant: it is the
 * single source the drift test pins those two playbook literals against.
 */
export const QA_ADMISSION_SKIP_MARKER = "Review skipped by the admission gate";

// ---------------------------------------------------------------------------
// Phase head (issue #5079, INV-3): the ONE composed entry the round-action
// step binds to. Only T4 has a decision here: the FAIL marker or the
// SHA-bound PASS marker. T1-T3 carry no deep-QA state. No new rule — every
// branch below is owned by the helpers it calls.
// ---------------------------------------------------------------------------

export interface DecideRoundInput {
  tier: number | null;
  /** The final verdict literal (PASS / FAIL / PASS-pending-CI / FAIL-pending-CI). */
  verdict: FinalVerdict | string;
  /** The folded review verdict (a T4 PASS needs both the verdict and the review to be non-FAIL). */
  reviewVerdict: ReviewVerdict;
  headSha: string;
}

export interface DecideRoundResult {
  /** The T4 `Verifier-Core deep-QA: PASS @ <sha>` line; set only on a T4 round that did not FAIL. */
  passMarker: string | null;
  /** `DEEP_QA_FAIL_MARKER` on a T4 FAIL round, else null (issue #5081). */
  failMarker: string | null;
}

export function decideRound(input: DecideRoundInput): DecideRoundResult {
  if (input.tier !== 4) return { passMarker: null, failMarker: null };
  // A T4 FAIL driven by CI alone (review PASS, a required check red) is still a deep-QA FAIL:
  // it carries the marker and never the PASS proof (QA round-1 finding on #5306).
  const fail = String(input.verdict).startsWith("FAIL") || input.reviewVerdict === "FAIL";
  // Only a T4 PASS carries the SHA-bound proof `hasFreshDeepQaPass` trusts.
  return fail
    ? { passMarker: null, failMarker: DEEP_QA_FAIL_MARKER }
    : { passMarker: renderDeepQaPassMarker(input.headSha), failMarker: null };
}

// ---------------------------------------------------------------------------
// Reviewer commit, class A (issue #5267, ADR-0046 Decision 2; epic #5255).
//
// When the `reviewer-commits` rollout stage is `A` or `A+B`, a round whose
// EVERY blocking finding sits in a class-A location (the PR body, docs,
// changelog, generated inventories, ratchet baselines) may be repaired by the
// reviewer itself instead of bouncing to dev. The decision is pure and
// all-or-nothing: one blocking finding anywhere else makes the whole round
// `none` and the ordinary FAIL routing runs unchanged. It never edits, filters
// or re-grades a finding (the fold owns the verdict). All I/O lives in
// src/qa/phases.ts and the playbook's step 9.4.
// ---------------------------------------------------------------------------

type ReviewerCommitReason =
  | "stage-off"
  | "tier-fence"
  | "verifier-core"
  | "one-way-door"
  | "no-blocking"
  | "ineligible-finding"
  | "out-of-scope"
  | "decision-error"
  | "class-a-fixable"
  | "class-b-fixable"
  | "class-ab-fixable";

export interface ReviewerCommitDecision {
  action: "none" | "commit-a" | "commit-b" | "commit-ab";
  reason: ReviewerCommitReason;
  detail: string;
  /** Class-A paths named by BLOCKING findings: every one must end up staged (empty unless commit-a). */
  blockingPaths: string[];
  /** Class-A paths named only by low follow-ups: an optional subset may ride along, none is required. */
  followUpPaths: string[];
  /** True when a blocking finding is located at the PR body. */
  bodyFix: boolean;
  /** Class-B (test file) paths named by BLOCKING findings (issue #5268): every one must be staged. Empty unless stage is `A+B`. */
  blockingTestPaths: string[];
  /** Class-B paths named only by low follow-ups: optional. Empty unless stage is `A+B`. */
  followUpTestPaths: string[];
}

export interface ReviewerCommitInput {
  /** The EFFECTIVE `reviewer-commits` switch (read from the QA session's master-based tree). */
  stage: ReviewerCommitsValue;
  tier: number | null;
  /** The PR's full changed-file list. */
  changedPaths: readonly string[];
  /** Unified diff of the PR (empty/unparseable => door `unknown` => refuse). */
  diff: string;
  /** `fold.blocking[]` rows (the rows that set blockers>0). */
  blocking: ReadonlyArray<{ location: string }>;
  /** `fold.followUps[]` rows; lows at class-A locations may ride along. */
  followUps?: ReadonlyArray<{ location: string }>;
  /** Paths listed under the PR body's `## Files out of scope`; null = unreadable body (fail closed). */
  outOfScope: readonly string[] | null;
}

const noReviewerCommit = (reason: ReviewerCommitReason, detail: string): ReviewerCommitDecision => ({
  action: "none",
  reason,
  detail,
  blockingPaths: [],
  followUpPaths: [],
  bodyFix: false,
  blockingTestPaths: [],
  followUpTestPaths: [],
});

/**
 * The repo path (and first line number, when present) a finding location names,
 * or null for a placeholder / non-path. The single parser behind the step-9.4
 * per-row re-verify (`qa-commit-checks.ts row-loc`), so the playbook never
 * re-implements it in shell.
 */
export function reviewerCommitLocationRef(location: string): { path: string; line: number | null } | null {
  let s = String(location ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(["'`])(.*)\1$/, "$2").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  let line: number | null = null;
  const m = /(?:[:#]\s*L?(\d+)(?:[-:]\d+)*|\s+L(\d+))$/i.exec(s);
  if (m) {
    line = Number(m[1] ?? m[2]);
    s = s.slice(0, m.index).trim();
  }
  s = s.replace(/^\.\//, "");
  if (!/^[A-Za-z0-9_.\-/]+$/.test(s)) return null;
  return s.includes("/") || s.includes(".") ? { path: s, line } : null;
}

/** The repo path a finding location names, or null for a placeholder / non-path. */
export function reviewerCommitLocationPath(location: string): string | null {
  return reviewerCommitLocationRef(location)?.path ?? null;
}

/** Paths listed under a PR body's `## Files out of scope` heading (backticked or bare bullets). */
export function parseFilesOutOfScope(body: string): string[] {
  const lines = String(body ?? "").split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s+files out of scope\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    // Fail closed: collect BOTH the backticked spans and the bullet's leading
    // token, so prose like "- docs/x.md (see `y`)" never drops the real path.
    out.push(...[...line.matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).trim()));
    const bullet = /^\s*[-*]\s+(\S+)/.exec(line);
    if (bullet) {
      // Strip emphasis wrappers, backticks and trailing punctuation so "- src/x.ts: reason" and "- **docs/x.md**" match the path.
      const token = (bullet[1] as string).replace(/^[*_`]+/, "").replace(/[*_`:,;.]+$/, "");
      if (token !== "") out.push(token);
    }
  }
  return [...new Set(out.map((p) => p.replace(/^\.\//, "")).filter((p) => p !== ""))];
}

/** Glob entry (`docs/generated/**`): `*` matches anything (even `/`) and `?` one char, so the fence only ever widens. */
function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${src}`);
}

function isOutOfScope(path: string, outOfScope: readonly string[]): boolean {
  return outOfScope.some((o) =>
    /[*?[]/.test(o)
      ? globToRegExp(o).test(path)
      : o.endsWith("/") ? path.startsWith(o) : path === o || path.startsWith(`${o}/`));
}

/**
 * Decide whether the reviewer may repair this round itself with a class-A
 * commit. Pure, total, never throws (STD-VERIFY-NEVER-THROW). Fences, in order:
 * stage, tier (T4 / unknown), Verifier Core, one-way/unknown door; then
 * all-or-nothing eligibility of every blocking finding.
 */
export function decideReviewerCommit(input: ReviewerCommitInput): ReviewerCommitDecision {
  try {
    if (input.stage !== "A" && input.stage !== "A+B") {
      return noReviewerCommit("stage-off", "reviewer-commits rollout stage is off");
    }
    const tier = typeof input.tier === "number" && Number.isFinite(input.tier) && input.tier >= 1 ? input.tier : null;
    if (tier === null || tier >= 4) {
      return noReviewerCommit("tier-fence", "no reviewer commits on T4 or an unknown tier");
    }
    const changed = input.changedPaths.map((p) => String(p ?? "").trim()).filter((p) => p !== "");
    if (changed.some((p) => isVerifierCore(p))) {
      return noReviewerCommit("verifier-core", "the PR touches Verifier Core");
    }
    const door = detectOneWayDoor({ paths: changed, diff: input.diff });
    if (requiresOneWayDepth(door)) {
      return noReviewerCommit("one-way-door", `door is ${door.door}: one-way and unknown refuse`);
    }
    if (input.blocking.length === 0) {
      return noReviewerCommit("no-blocking", "no blocking finding to repair");
    }
    const blockingPaths: string[] = [];
    const followUpPaths: string[] = [];
    const blockingTestPaths: string[] = [];
    const followUpTestPaths: string[] = [];
    const classBOn = input.stage === "A+B";
    let bodyFix = false;
    const consider = (location: string, blocking: boolean): ReviewerCommitDecision | null => {
      if (/^\s*pr body\s*$/i.test(String(location ?? ""))) {
        // Only a BLOCKING row demands a body edit; a low follow-up at the PR
        // body must never force bodyFix on (INV-3).
        if (blocking) bodyFix = true;
        return null;
      }
      const path = reviewerCommitLocationPath(location);
      const cls = path === null ? "deny" : classifyQaFixPath(path);
      const isClassB = classBOn && cls === "B";
      if (path === null || (cls !== "A" && cls !== "AB" && !isClassB)) {
        return blocking
          ? noReviewerCommit(
              "ineligible-finding",
              `blocking finding at ${JSON.stringify(location)} is not ${classBOn ? "class A or B" : "class A"}`,
            )
          : null;
      }
      if (input.outOfScope === null || isOutOfScope(path, input.outOfScope)) {
        return blocking
          ? noReviewerCommit("out-of-scope", `${path} is listed under Files out of scope or the scope is unreadable`)
          : null;
      }
      const into = isClassB
        ? (blocking ? blockingTestPaths : followUpTestPaths)
        : (blocking ? blockingPaths : followUpPaths);
      if (!into.includes(path)) into.push(path);
      return null;
    };
    for (const f of input.blocking) {
      const refusal = consider(f.location, true);
      if (refusal) return refusal;
    }
    for (const f of input.followUps ?? []) consider(f.location, false);
    // A path that is also blocking is required, never merely optional.
    const optionalPaths = followUpPaths.filter((p) => !blockingPaths.includes(p));
    const optionalTestPaths = followUpTestPaths.filter((p) => !blockingTestPaths.includes(p));
    // The commit classes follow the BLOCKING rows only: a low follow-up never widens the class set.
    const hasA = bodyFix || blockingPaths.length > 0;
    const hasB = blockingTestPaths.length > 0;
    const action = hasA && hasB ? "commit-ab" : hasB ? "commit-b" : "commit-a";
    const reason: ReviewerCommitReason =
      action === "commit-ab" ? "class-ab-fixable" : action === "commit-b" ? "class-b-fixable" : "class-a-fixable";
    const detail =
      action === "commit-a"
        ? `every blocking finding is class A (${blockingPaths.length} path(s)${bodyFix ? " + PR body" : ""})`
        : `every blocking finding is class ${action === "commit-b" ? "B" : "A or B"} (${blockingPaths.length} class-A path(s)${bodyFix ? " + PR body" : ""}, ${blockingTestPaths.length} class-B path(s))`;
    return {
      action,
      reason,
      detail,
      blockingPaths,
      followUpPaths: optionalPaths,
      bodyFix,
      blockingTestPaths,
      followUpTestPaths: optionalTestPaths,
    };
  } catch (err) {
    logger.error({ err }, "[round-action] decideReviewerCommit failed; refusing the commit path");
    return noReviewerCommit("decision-error", "decision threw; fail closed");
  }
}


/**
 * Count `test(` / `it(` call sites (including `.only` / `.skip` / `.todo`) in a
 * test file's text. The class-B no-weakening check (issue #5268 INV-8): a
 * reviewer test edit may never lower this count. Pure, total, never throws.
 * Whole-line `//` and block-comment lines are ignored so commented-out cases do not count.
 */
export function countTestCases(text: string): number {
  try {
    let n = 0;
    for (const line of String(text ?? "").split(/\r?\n/)) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      n += (line.match(/(?:^|[^\w.$])(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/g) ?? []).length;
    }
    return n;
  } catch (err) {
    logger.error({ err }, "[round-action] countTestCases failed; reporting 0");
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Deterministic re-verify helpers for playbook step 9.4 (issue #5267, round-3
// fix-forward). Pure; scripts/ci/qa-commit-checks.ts is their only caller.
// ---------------------------------------------------------------------------

const SECTION_HEADING = /^#{1,6}\s/;
const FILES_IN_SCOPE_HEADING = /^#{1,6}\s+files in scope\b/i;

function splitBodySections(body: string): Array<{ heading: string; lines: string[] }> {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else (sections[sections.length - 1] as { lines: string[] }).lines.push(line);
  }
  return sections;
}

/**
 * INV-6: a reviewer body fix may only ADD bullets under `## Files in scope`.
 * Every other section (Files out of scope, reconciliation, Closes-ref...) must
 * be byte-identical, the heading sequence unchanged, and the original lines of
 * Files in scope must survive in order. Never throws.
 */
export function checkBodyScopeEdit(orig: string, next: string): { ok: boolean; reason: string } {
  try {
    const a = splitBodySections(orig);
    const b = splitBodySections(next);
    if (a.length !== b.length || a.some((s, i) => s.heading !== (b[i] as { heading: string }).heading)) {
      return { ok: false, reason: "section headings changed" };
    }
    for (let i = 0; i < a.length; i++) {
      const x = a[i] as { heading: string; lines: string[] };
      const y = b[i] as { heading: string; lines: string[] };
      if (!FILES_IN_SCOPE_HEADING.test(x.heading)) {
        if (x.lines.join("\n") !== y.lines.join("\n")) {
          return { ok: false, reason: `section ${JSON.stringify(x.heading || "(preamble)")} was edited` };
        }
        continue;
      }
      let j = 0;
      for (const line of y.lines) {
        if (j < x.lines.length && line === x.lines[j]) j++;
        else if (!/^\s*$/.test(line) && !/^\s*[-*]\s+\S/.test(line)) {
          return { ok: false, reason: `Files in scope gained a non-bullet line ${JSON.stringify(line)}` };
        }
      }
      if (j !== x.lines.length) return { ok: false, reason: "an original Files in scope line was removed or edited" };
    }
    return { ok: true, reason: "only Files in scope bullets were added" };
  } catch (err) {
    logger.error({ err }, "[round-action] checkBodyScopeEdit failed; refusing");
    return { ok: false, reason: "check threw; fail closed" };
  }
}

/**
 * True when a unified `-U0` diff of ONE file has a hunk touching or adjacent
 * to `line` (old or new side). A non-positive / non-integer line is false.
 */
export function diffHasHunkNearLine(diffU0: string, line: number): boolean {
  if (!Number.isInteger(line) || line < 1) return false;
  for (const m of String(diffU0 ?? "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oa = Number(m[1]);
    const ol = m[2] === undefined ? 1 : Number(m[2]);
    const na = Number(m[3]);
    const nl = m[4] === undefined ? 1 : Number(m[4]);
    if ((line >= oa - 1 && line <= oa + ol) || (line >= na - 1 && line <= na + nl)) return true;
  }
  return false;
}

/**
 * INV-4 / INV-10 (issue #5415): the report of a reviewer-fixed round. Each
 * BLOCKING table row whose File:line cell matches one of `blockingLocations`
 * gets ` fixed-by <sha12>` suffixed onto its Fix cell, and one
 * `Reviewer-fixed in <sha12> (QA-Fix: A)` paragraph is appended. A row is never
 * deleted, filtered or re-graded; the follow-ups table is left untouched.
 * Pure and total.
 */
export function annotateReviewerFixedReport(
  report: string,
  blockingLocations: readonly string[],
  sha12: string,
): string {
  const norm = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  const wanted = new Set(blockingLocations.map(norm));
  let inFollowUps = false;
  const lines = String(report ?? "")
    .split("\n")
    .map((line) => {
      if (line.trim() === FOLLOW_UPS_HEADING) inFollowUps = true;
      if (inFollowUps || !line.startsWith("|")) return line;
      const cells = line.split(/(?<!\\)\|/);
      // cells: ["", severity, axis, reviewer, file:line, finding, fix, ""]
      if (cells.length !== 8 || !wanted.has((cells[4] as string).trim())) return line;
      return line.replace(/ \|$/, ` fixed-by ${sha12} |`);
    });
  return `${lines.join("\n")}\n\nReviewer-fixed in ${sha12} (QA-Fix: A): each blocking row above is fixed-by ${sha12}.`;
}
