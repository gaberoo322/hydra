/**
 * scripts/ci/qa-catch-rate.ts — AC1 measurement helper for issue #3815
 * ("hydra-qa is 23% of all token usage (~8.6M per PR reviewed) and caught 0
 * blockers in 60 PRs — reduce cost of the adversarial fan-out").
 *
 * BACKGROUND
 *   The issue's original methodology sampled the 60 most recently CLOSED
 *   orchestrator PRs and counted `CHANGES_REQUESTED` reviews — 0/36 carried
 *   one. The issue's own text flags this as a structural undercount: a FAIL
 *   verdict strips `needs-qa`, adds `ready-for-agent`, and bounces the PR back
 *   to a dev agent (`docs/operator-playbooks/hydra-qa.md` step 10). A PR that
 *   was FAILed, fixed, and re-reviewed shows no *lasting* `CHANGES_REQUESTED`
 *   if a later PASS superseded it, and a FAIL recorded via the CI-triggered
 *   `skip-required-failed` admission-gate branch (step 6.6) never spawns a
 *   reviewer at all, so it can't leave a review-state trace either. The
 *   design-concept artifact for this issue (`GET /api/design-concepts/3815`)
 *   makes acceptance criterion 1 explicit: "the true QA catch rate is
 *   measured over a defensible window — counting FAIL verdicts wherever they
 *   are recorded (PR review state, verdict comment, and the ready-for-agent
 *   bounce path), not just CHANGES_REQUESTED on closed PRs. This number gates
 *   everything below" — no further fan-out-reducing lever (in particular the
 *   RC2 mid-fan-out short-circuit) may ship until this number exists.
 *
 * WHAT THIS MODULE IS AND IS NOT
 *   This is the *instrument*, not the *measurement* — it gives the AC1 window
 *   a repeatable, deterministic definition of "reviewed" and "caught" so a
 *   catch-rate figure can be reproduced on demand instead of hand-counted per
 *   grill. It ships NO lever: it does not touch `aggregateAdversarialReview`,
 *   `classifyVerdict`, `decide.py`'s `should_auto_merge()`, or any verdict
 *   literal (INV-A/INV-D preserved by construction — the only thing this file
 *   imports from `qa-verdict.ts` is the read-only `QA-Verdict:` trailer
 *   parser, issue #4729), and it reduces no review depth for any tier (INV-B).
 *
 * THE CANONICAL TRAILER (issue #4729) — checked FIRST
 *   Every post-#4729 verdict comment carries one line
 *   `QA-Verdict: <verdict> pr=<N> round=<k> sha=<head12> blockers=<n>
 *   max_severity=<sev>`. A body carrying a trailer is classified by that
 *   trailer ALONE, and only when its `pr=` names the PR being classified —
 *   so the pointer comment QA posts on a linked issue shared by two PRs is
 *   attributed to exactly one of them. A trailer-bearing body is never
 *   re-read through the legacy heuristics below. The explicit
 *   `QA-Verdict-Error: verdict=<V> pr=<N> reason=…` fallback line (posted
 *   when the trailer render failed, issue #4746) is canonical in the same
 *   way: it names its PR and verdict, just without a `sha=`.
 *
 * THE LEGACY FALLBACK — trailer-less (historical) bodies only
 *   Running it does not gate or ship the RC2 short-circuit; it only produces
 *   the number that gate is waiting on.
 *
 *   THE THREE SIGNALS (mirrors the three ledgers step 10 of hydra-qa.md writes
 * to on a FAIL verdict — see `classifyPrQaOutcome` below):
 *   1. PR review state — a `CHANGES_REQUESTED` review whose body contains the
 *      `Automated QA` marker (the universal T1-T4 FAIL path, step 10).
 *   2. PR verdict comment — a PR comment containing the literal
 *      `**Verdict:** \`FAIL\`` or `**Verdict:** \`FAIL-pending-CI\`` marker
 *      (covers the `skip-required-failed` admission-gate branch, step 6.6,
 *      which computes a FAIL without ever spawning a reviewer, so it never
 *      produces a review-state FAIL).
 *   3. The ready-for-agent bounce path — a comment on the LINKED issue
 *      containing `Automated QA failed` (T1-T3), `T4 Deep-QA failed`, or
 *      `T4 Deep-QA blocked` (the exact literals step 10 posts on every bounce
 *      / escalation).
 *
 * The legacy path also recognises the drifted verdict headers
 * (`## hydra-qa verdict: FAIL`, `## QA Verdict: FAIL`) that the
 * `Automated QA` marker missed, and — when the PR number is known — skips a
 * linked-issue bounce comment that names only OTHER PRs (`PR #M`), the
 * historical shared-issue misattribution (#4490/#4494 on #4268).
 *
 * A PR counts as "reviewed" (denominator) once ANY signal shows a QA pass
 * ran at all (a trailer naming it, or a legacy marker) — a PR that was never
 * reviewed is excluded from the rate entirely, not counted as a clean pass.
 *
 * OPERATOR OVERRIDES (issue #4738, decision #4736 option 2)
 *   A hand merge that lands over a QA merge guard denial
 *   (`scripts/ci/qa-merge-guard.ts`) is recorded as ONE PR comment line
 *   `QA-Override: pr=<N> sha=<head12> reason=<text>`, posted by the
 *   hydra-review "Land it" flow before it merges. A merged PR carrying such a
 *   line naming it counts toward the aggregate's `overridden` figure. The
 *   figure is SEPARATE from the catch rate: an override neither makes a PR
 *   reviewed nor caught, it only keeps "landed without QA's blessing" visible.
 *
 * This module is pure — no fs/network — so it is unit-testable directly (see
 * test/qa-catch-rate.test.mts). The CLI wrapper at the bottom does the actual
 * `gh` calls to assemble a real window and prints the aggregate as JSON.
 */

import {
  isFailVerdict,
  parseQaVerdictErrors,
  parseQaVerdictTrailers,
} from "./qa-verdict.ts";

/** One PR's raw QA-relevant signals, already fetched from GitHub. */
export interface QaSignalSet {
  /**
   * The PR being classified. When set, a `QA-Verdict:` trailer counts only
   * if its `pr=` matches, and a legacy issue-side bounce comment naming only
   * other PRs is skipped. When absent, trailers count regardless of `pr=`
   * (the pre-#4729 unkeyed behaviour).
   */
  prNumber?: number;
  /** `gh pr view --json reviews` entries: only `state` and `body` matter. */
  reviews: ReadonlyArray<{ state: string; body: string }>;
  /** `gh pr view --json comments` entries on the PR itself. */
  prComments: ReadonlyArray<{ body: string }>;
  /**
   * Comments on the issue the PR closes/fixes (the bounce-path ledger).
   * Empty when the PR has no resolvable linked issue.
   */
  issueComments: ReadonlyArray<{ body: string }>;
  /**
   * True when the PR is merged (issue #4738). Only a MERGED PR carrying a
   * `QA-Override:` line counts as an overridden merge; absent ⇒ not merged.
   */
  merged?: boolean;
}

/**
 * `caught`       — a real QA pass ran AND recorded a FAIL via any of the
 *                  three signals above.
 * `clean-pass`   — a real QA pass ran and recorded no FAIL signal.
 * `not-reviewed` — no `Automated QA` marker found anywhere; excluded from
 *                  the catch-rate denominator (this PR says nothing about
 *                  whether review would have caught anything).
 */
export type PrQaOutcome = "caught" | "clean-pass" | "not-reviewed";

/** The literal marker every `hydra-qa` comment/review body carries. */
export const AUTOMATED_QA_MARKER = "Automated QA";

/** Matches the exact verdict-comment marker step 9/10 renders. */
const FAIL_VERDICT_COMMENT_RE = /\*\*Verdict:\*\*\s*`FAIL(-pending-CI)?`/;

/**
 * The drifted legacy verdict headers (`## hydra-qa verdict: PASS`,
 * `## QA Verdict: FAIL`) — a QA pass ran even without the `Automated QA`
 * marker. Group 1 is the verdict literal.
 */
const LEGACY_VERDICT_HEADER_RE =
  /^#{1,6}\s*(?:hydra-qa verdict|QA Verdict)\s*:\s*`?(PASS|FAIL)(-pending-CI)?`?/im;

/** `PR #123` references in a legacy issue-side bounce comment. */
const PR_REF_RE = /\bPR\s*#(\d+)/gi;

/** The exact bounce-path literals step 10 posts as an issue comment. */
const BOUNCE_COMMENT_MARKERS: readonly string[] = [
  "Automated QA failed",
  "T4 Deep-QA failed",
  "T4 Deep-QA blocked",
];

/**
 * Classify a single PR's QA outcome from its raw signals. Pure — see the
 * module docstring for the exact three-signal definition of "caught".
 */
export function classifyPrQaOutcome(signals: QaSignalSet): PrQaOutcome {
  const prNumber = signals.prNumber;
  // A `QA-Verdict-Error:` line (issue #4746 — the trailer render failed) is
  // canonical too: it names the PR and the verdict, just without a sha.
  const canonicalRecords = (body: string) => [
    ...parseQaVerdictTrailers(body),
    ...parseQaVerdictErrors(body),
  ];
  const hasTrailer = (body: string): boolean =>
    canonicalRecords(body).length > 0;

  // ── 1. Canonical trailers (issue #4729) — every body, PR- or issue-side,
  //       counts only for the PR its `pr=` names. An error line whose pr is
  //       unknown (`null`) is attributed only when it sits on the PR itself.
  const prSideBodies = [
    ...(signals.reviews ?? []).map((r) => r.body ?? ""),
    ...(signals.prComments ?? []).map((c) => c.body ?? ""),
  ];
  const issueSideBodies = (signals.issueComments ?? []).map((c) => c.body ?? "");
  const ownRecords = (bodies: string[], prSide: boolean) =>
    bodies
      .flatMap((body) => canonicalRecords(body))
      .filter(
        (t) =>
          prNumber === undefined ||
          t.pr === prNumber ||
          (prSide && t.pr === null),
      );
  const ownTrailers = [
    ...ownRecords(prSideBodies, true),
    ...ownRecords(issueSideBodies, false),
  ];
  const trailerReviewed = ownTrailers.length > 0;
  const trailerCaught = ownTrailers.some(
    (t) => t.verdict !== null && isFailVerdict(t.verdict),
  );

  // ── 2. Legacy fallback — trailer-less (historical) bodies only.
  const reviews = (signals.reviews ?? []).filter(
    (r) => !hasTrailer(r.body ?? ""),
  );
  const prComments = (signals.prComments ?? []).filter(
    (c) => !hasTrailer(c.body ?? ""),
  );
  const issueComments = (signals.issueComments ?? []).filter(
    (c) =>
      !hasTrailer(c.body ?? "") &&
      !namesOnlyOtherPrs(c.body ?? "", prNumber),
  );

  const isLegacyQaBody = (body: string): boolean =>
    body.includes(AUTOMATED_QA_MARKER) || LEGACY_VERDICT_HEADER_RE.test(body);
  const isLegacyFailHeader = (body: string): boolean =>
    LEGACY_VERDICT_HEADER_RE.exec(body)?.[1] === "FAIL";

  const legacyReviewed =
    reviews.some((r) => isLegacyQaBody(r.body ?? "")) ||
    prComments.some((c) => isLegacyQaBody(c.body ?? ""));

  if (!trailerReviewed && !legacyReviewed) return "not-reviewed";

  const legacyCaught =
    reviews.some(
      (r) =>
        (r.state === "CHANGES_REQUESTED" &&
          isLegacyQaBody(r.body ?? "")) ||
        isLegacyFailHeader(r.body ?? ""),
    ) ||
    prComments.some(
      (c) =>
        FAIL_VERDICT_COMMENT_RE.test(c.body ?? "") ||
        isLegacyFailHeader(c.body ?? ""),
    ) ||
    issueComments.some((c) =>
      BOUNCE_COMMENT_MARKERS.some((marker) => (c.body ?? "").includes(marker)),
    );

  return trailerCaught || legacyCaught ? "caught" : "clean-pass";
}

/**
 * True when a legacy issue-side comment references at least one `PR #M` and
 * none of them is `prNumber` — i.e. it is provably about a sibling PR that
 * shares the linked issue. A comment naming no PR (or an unknown
 * `prNumber`) is kept: the conservative pre-#4729 attribution.
 */
function namesOnlyOtherPrs(body: string, prNumber: number | undefined): boolean {
  if (prNumber === undefined) return false;
  const refs = [...body.matchAll(PR_REF_RE)].map((m) =>
    Number.parseInt(m[1] as string, 10),
  );
  return refs.length > 0 && !refs.includes(prNumber);
}

// ---------------------------------------------------------------------------
// `QA-Override:` — the recorded operator override (issue #4738)
// ---------------------------------------------------------------------------

/** Literal prefix of the override line. */
export const QA_OVERRIDE_PREFIX = "QA-Override:";

/**
 * `QA-Override: pr=<N> sha=<head12> reason=<text>` — anchored per line, field
 * order fixed. `sha=` is the PR head the override was granted against (the
 * renderer writes 12 hex chars; the parser accepts 7–40 like the verdict
 * trailer). `reason=` runs to the end of the line and must be non-empty.
 */
const QA_OVERRIDE_LINE_RE =
  /^QA-Override:[ \t]+pr=(\d+)[ \t]+sha=([0-9a-fA-F]{7,40})[ \t]+reason=([^\r\n]*?)[ \t]*\r?$/gm;

export interface QaOverride {
  pr: number;
  /** Lower-cased head SHA prefix the override was granted against. */
  sha: string;
  reason: string;
}

/**
 * Render the one override line. Returns null — never throws — when the input
 * cannot form a well-formed line (pr < 1, head SHA shorter than 12 hex chars,
 * or a reason that is blank once newlines/whitespace are collapsed).
 */
export function renderQaOverrideLine(input: {
  pr: number;
  headSha: string;
  reason: string;
}): string | null {
  const pr = Number(input.pr);
  const sha = String(input.headSha ?? "").trim().toLowerCase();
  const reason = String(input.reason ?? "").replace(/\s+/g, " ").trim();
  if (!Number.isInteger(pr) || pr < 1) return null;
  if (!/^[0-9a-f]{12,40}$/.test(sha)) return null;
  if (reason.length === 0) return null;
  return `${QA_OVERRIDE_PREFIX} pr=${pr} sha=${sha.slice(0, 12)} reason=${reason}`;
}

/** Every well-formed `QA-Override:` line in a body, in order. */
export function parseQaOverrides(body: string | null | undefined): QaOverride[] {
  if (typeof body !== "string" || !body.includes(QA_OVERRIDE_PREFIX)) return [];
  const out: QaOverride[] = [];
  for (const m of body.matchAll(QA_OVERRIDE_LINE_RE)) {
    const pr = Number.parseInt(m[1] as string, 10);
    const reason = (m[3] as string).trim();
    if (pr < 1 || reason.length === 0) continue;
    out.push({ pr, sha: (m[2] as string).toLowerCase(), reason });
  }
  return out;
}

/**
 * True iff the PR is merged AND a PR-side body (review or comment) carries a
 * `QA-Override:` line naming it. Keyed on `prNumber` when set, so an override
 * recorded for a sibling PR is never attributed here. Issue-side comments are
 * ignored: the override is posted on the PR it lands.
 */
export function isOverriddenMerge(signals: QaSignalSet): boolean {
  if (signals.merged !== true) return false;
  const bodies = [
    ...(signals.reviews ?? []).map((r) => r.body ?? ""),
    ...(signals.prComments ?? []).map((c) => c.body ?? ""),
  ];
  return bodies.some((body) =>
    parseQaOverrides(body).some(
      (o) => signals.prNumber === undefined || o.pr === signals.prNumber,
    ),
  );
}

export interface CatchRateResult {
  totalPrs: number;
  totalReviewed: number;
  totalCaught: number;
  totalCleanPass: number;
  totalNotReviewed: number;
  /** totalCaught / totalReviewed, or 0 (never NaN) when totalReviewed === 0. */
  catchRate: number;
  /**
   * Merged PRs that landed via a recorded `QA-Override:` (issue #4738).
   * Counted separately — it does not move any figure above.
   */
  overridden: number;
}

/**
 * Fold a list of per-PR outcomes into the aggregate AC1 figure. Pure.
 * `overriddenMerges` is one flag per PR (from `isOverriddenMerge`); it feeds
 * only the separate `overridden` count.
 */
export function computeCatchRate(
  outcomes: readonly PrQaOutcome[],
  overriddenMerges: readonly boolean[] = [],
): CatchRateResult {
  const totalPrs = outcomes.length;
  const totalCaught = outcomes.filter((o) => o === "caught").length;
  const totalCleanPass = outcomes.filter((o) => o === "clean-pass").length;
  const totalNotReviewed = outcomes.filter(
    (o) => o === "not-reviewed",
  ).length;
  const totalReviewed = totalCaught + totalCleanPass;
  return {
    totalPrs,
    totalReviewed,
    totalCaught,
    totalCleanPass,
    totalNotReviewed,
    catchRate: totalReviewed === 0 ? 0 : totalCaught / totalReviewed,
    overridden: overriddenMerges.filter((o) => o === true).length,
  };
}

// ---------------------------------------------------------------------------
// CLI: node --experimental-strip-types scripts/ci/qa-catch-rate.ts
//        [--repo owner/repo] [--limit N]
//
// Fetches a window of PRs (default: 60, matching the issue's original
// sample size) via `gh pr list`, resolves each PR's linked issue (parsed
// from a `closes|fixes #N` reference in the PR body) for the bounce-path
// signal, classifies every PR, and prints the aggregate CatchRateResult plus
// a per-PR breakdown as JSON to stdout. Best-effort: a PR whose linked-issue
// comment fetch fails is classified with an empty issueComments list rather
// than aborting the whole run (a partial signal set undercounts "caught",
// never overcounts it — the rate this yields is a conservative floor, never
// an inflated one).
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      typeof import.meta.url === "string" &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta may be unavailable under some loaders; treat as not-main */
    return false;
  }
})();

if (isMain) {
  const { execFileSync } = await import("node:child_process");

  const parseArg = (flag: string, fallback: string): string => {
    const idx = process.argv.indexOf(flag);
    if (idx === -1 || idx === process.argv.length - 1) return fallback;
    return process.argv[idx + 1] as string;
  };

  const repo = parseArg("--repo", "gaberoo322/hydra");
  const limit = Number.parseInt(parseArg("--limit", "60"), 10) || 60;

  type RawPr = {
    number: number;
    body: string;
    reviews: Array<{ state: string; body: string }>;
    comments: Array<{ body: string }>;
    mergedAt: string | null;
  };

  const ghJson = <T>(args: string[]): T | undefined => {
    try {
      const out = execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 32,
      });
      return JSON.parse(out) as T;
    } catch (e) {
      console.error(
        `[qa-catch-rate] WARN gh-call-failed: ${args.join(" ")} — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return undefined;
    }
  };

  const prs =
    ghJson<RawPr[]>([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      String(limit),
      "--json",
      "number,body,reviews,comments,mergedAt",
    ]) ?? [];

  const linkedIssueRe = /\b(?:closes|fixes)\s*#(\d+)/i;
  const issueCommentCache = new Map<number, Array<{ body: string }>>();

  const fetchIssueComments = (issueNum: number): Array<{ body: string }> => {
    if (issueCommentCache.has(issueNum)) {
      return issueCommentCache.get(issueNum) as Array<{ body: string }>;
    }
    const result =
      ghJson<{ comments: Array<{ body: string }> }>([
        "issue",
        "view",
        String(issueNum),
        "--repo",
        repo,
        "--json",
        "comments",
      ])?.comments ?? [];
    issueCommentCache.set(issueNum, result);
    return result;
  };

  const perPr: Array<{
    number: number;
    outcome: PrQaOutcome;
    overridden: boolean;
  }> = [];
  for (const pr of prs) {
    const match = linkedIssueRe.exec(pr.body ?? "");
    const issueComments = match
      ? fetchIssueComments(Number.parseInt(match[1] as string, 10))
      : [];
    const signals: QaSignalSet = {
      prNumber: pr.number,
      reviews: pr.reviews ?? [],
      prComments: pr.comments ?? [],
      issueComments,
      merged: typeof pr.mergedAt === "string" && pr.mergedAt.length > 0,
    };
    perPr.push({
      number: pr.number,
      outcome: classifyPrQaOutcome(signals),
      overridden: isOverriddenMerge(signals),
    });
  }

  const aggregate = computeCatchRate(
    perPr.map((p) => p.outcome),
    perPr.map((p) => p.overridden),
  );
  console.log(JSON.stringify({ repo, limit, aggregate, perPr }, null, 2));
}
