// Canonical QA-Verdict trailer grammar (issue #4729, moved here by #5078).
//
// The single owner of the `QA-Verdict:` / `QA-Verdict-Error:` grammar. Pure
// (no fs / network / Redis) and imports nothing from scripts/ — scripts and
// src consumers import it from here.

/** The verdict vocabulary of the trailer (also scripts/ci/qa-verdict.ts's). */
export type FinalVerdict =
  | "PASS"
  | "FAIL"
  | "PASS-pending-CI"
  | "FAIL-pending-CI";

// ---------------------------------------------------------------------------
// Canonical QA-Verdict trailer (issue #4729)
//
// Every hydra-qa verdict comment ends with exactly ONE machine-readable line:
//
//   QA-Verdict: <PASS|FAIL|PASS-pending-CI|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high|medium|low|none>
//
// It replaces the drifting human headers (`> *Automated QA — …*`,
// `## hydra-qa verdict: PASS`, `## QA Verdict: PASS`) as the thing measurement
// keys on: `qa-catch-rate.ts` parses it first and attributes a verdict ONLY to
// the PR named by `pr=`, so a shared linked issue no longer leaks one PR's
// bounce onto its sibling. `round` = prior trailers on the same PR + 1.
//
// Pure — no fs/network. Never throws: malformed input parses to `null`.
// ---------------------------------------------------------------------------

/** The literal prefix of the canonical trailer line. */
export const QA_VERDICT_TRAILER_PREFIX = "QA-Verdict:";

/** Highest severity among a verdict's hard findings; `none` when blockers=0. */
export type QaSeverity = "high" | "medium" | "low" | "none";

/** The parsed fields of one `QA-Verdict:` trailer line. */
export interface QaVerdictTrailer {
  verdict: FinalVerdict;
  /** The PR this verdict is about — the ONLY PR it may be attributed to. */
  pr: number;
  /** 1-based review round on this PR. */
  round: number;
  /**
   * Head SHA reviewed: lowercase hex, 12 chars when rendered (7–40 accepted
   * on parse), or the `QA_VERDICT_UNKNOWN_SHA` sentinel when the head SHA was
   * empty/unknown at render time — which never matches any head SHA
   * (`qaVerdictShaMatches`).
   */
  sha: string;
  /** Count of hard findings (a red required check counts as one high blocker). */
  blockers: number;
  maxSeverity: QaSeverity;
  /**
   * Optional trailing `qa-fixes=<sha12>[,<sha12>...]` field (issue #5266):
   * the reviewer's `QA-Fix:` commits. Absent on parse => `[]`; empty/absent
   * renders nothing, so legacy trailers are byte-identical.
   */
  qaFixes?: readonly string[];
}

const QA_SEVERITIES: readonly QaSeverity[] = ["high", "medium", "low", "none"];

/** Every `FinalVerdict` literal, in the order the parser tries them. */
const FINAL_VERDICTS: readonly FinalVerdict[] = [
  "PASS-pending-CI",
  "FAIL-pending-CI",
  "PASS",
  "FAIL",
];

/**
 * The documented `sha=` sentinel for an empty or unknown head SHA (issue
 * #4746). The renderer emits it instead of a malformed `sha=` field, the
 * parser accepts it, and `qaVerdictShaMatches` treats it as "no SHA match" —
 * so a merge guard keyed on `sha=` can never be satisfied by it.
 */
export const QA_VERDICT_UNKNOWN_SHA = "unknown";

/**
 * Anchored per line (`m` flag). The `-pending-CI` literals are listed first
 * so `PASS` can never shadow `PASS-pending-CI`.
 */
const QA_VERDICT_TRAILER_RE =
  /^QA-Verdict:[ \t]+(PASS-pending-CI|FAIL-pending-CI|PASS|FAIL)[ \t]+pr=(\d+)[ \t]+round=(\d+)[ \t]+sha=([0-9a-fA-F]{7,40}|unknown)[ \t]+blockers=(\d+)[ \t]+max_severity=(high|medium|low|none)(?:[ \t]+qa-fixes=([0-9a-fA-F]{7,40}(?:,[0-9a-fA-F]{7,40})*))?[ \t]*\r?$/gm;

/**
 * Parse EVERY well-formed `QA-Verdict:` line in a comment/review body, in
 * order. A malformed line (wrong field order, unknown verdict, pr=0,
 * round=0) is skipped, never partially parsed.
 */
export function parseQaVerdictTrailers(
  body: string | null | undefined,
): QaVerdictTrailer[] {
  if (typeof body !== "string" || !body.includes(QA_VERDICT_TRAILER_PREFIX)) {
    return [];
  }
  const out: QaVerdictTrailer[] = [];
  for (const m of body.matchAll(QA_VERDICT_TRAILER_RE)) {
    const pr = Number.parseInt(m[2] as string, 10);
    const round = Number.parseInt(m[3] as string, 10);
    if (pr < 1 || round < 1) continue;
    out.push({
      verdict: m[1] as FinalVerdict,
      pr,
      round,
      sha: (m[4] as string).toLowerCase(),
      blockers: Number.parseInt(m[5] as string, 10),
      maxSeverity: m[6] as QaSeverity,
      qaFixes:
        m[7] === undefined ? [] : (m[7] as string).toLowerCase().split(","),
    });
  }
  return out;
}

/**
 * The FIRST well-formed `QA-Verdict:` line in a body, or `null` when the body
 * carries none (a legacy, pre-#4729 comment).
 */
export function parseQaVerdictTrailer(
  body: string | null | undefined,
): QaVerdictTrailer | null {
  return parseQaVerdictTrailers(body)[0] ?? null;
}

/** True for the two FAIL literals — the "caught" side of a verdict. */
export function isFailVerdict(verdict: FinalVerdict): boolean {
  return verdict === "FAIL" || verdict === "FAIL-pending-CI";
}

/**
 * The round the NEXT verdict on `pr` gets: prior trailers naming `pr` across
 * the PR's own comment + review bodies, plus one. Trailers naming a different
 * PR are ignored.
 */
export function nextQaVerdictRound(
  priorBodies: ReadonlyArray<string | null | undefined>,
  pr: number,
): number {
  let prior = 0;
  for (const body of priorBodies) {
    for (const t of parseQaVerdictTrailers(body)) {
      if (t.pr === pr) prior += 1;
    }
  }
  return prior + 1;
}

/**
 * True iff trailer `t` was rendered for `headSha` (its 12-char `sha=` is a
 * prefix of the full head SHA). The `QA_VERDICT_UNKNOWN_SHA` sentinel and a
 * blank `headSha` NEVER match — an unknown SHA must never satisfy a merge
 * guard (same fail-closed rule as `hasFreshDeepQaPass`).
 */
export function qaVerdictShaMatches(
  t: Pick<QaVerdictTrailer, "sha">,
  headSha: string,
): boolean {
  const head = String(headSha ?? "").trim().toLowerCase();
  const sha = String(t.sha ?? "").toLowerCase();
  if (head.length === 0 || !/^[0-9a-f]{7,40}$/.test(sha)) return false;
  return head.startsWith(sha);
}

// ---------------------------------------------------------------------------
// `QA-Verdict-Error:` — the loud fallback (issue #4746)
//
// If step 9.5 cannot render a trailer at all (neither the full render nor the
// minimal bash retry produced a parseable line), the verdict is still posted,
// ending with one explicit error line instead of silently dropping the
// trailer:
//
//   QA-Verdict-Error: verdict=<V> pr=<N> reason=<free text>
//
// `qa:catch-rate` counts it as a real QA pass for PR <N> (caught iff <V> is a
// FAIL literal). It is NEVER a `QA-Verdict:` trailer: it carries no `sha=`,
// so no SHA-keyed merge guard can be satisfied by it. Parsing is lenient —
// the line exists precisely because an input was bad, so an unrecognised
// verdict or a missing pr still parses (as `null`) rather than vanishing.
// ---------------------------------------------------------------------------

/** The literal prefix of the fallback error line. */
export const QA_VERDICT_ERROR_PREFIX = "QA-Verdict-Error:";

/** The parsed fields of one `QA-Verdict-Error:` line. */
export interface QaVerdictError {
  /** `null` when the line's `verdict=` is absent or not a FinalVerdict. */
  verdict: FinalVerdict | null;
  /** `null` when the line's `pr=` is absent or not a positive integer. */
  pr: number | null;
  reason: string;
}

const QA_VERDICT_ERROR_LINE_RE = /^QA-Verdict-Error:([^\r\n]*)\r?$/gm;

/** Parse every `QA-Verdict-Error:` line (line-anchored) in a body, in order. */
export function parseQaVerdictErrors(
  body: string | null | undefined,
): QaVerdictError[] {
  if (typeof body !== "string" || !body.includes(QA_VERDICT_ERROR_PREFIX)) {
    return [];
  }
  const out: QaVerdictError[] = [];
  for (const m of body.matchAll(QA_VERDICT_ERROR_LINE_RE)) {
    const rest = m[1] as string;
    const v = /(?:^|[ \t])verdict=(\S*)/.exec(rest)?.[1] as FinalVerdict | undefined;
    const p = /(?:^|[ \t])pr=(\d+)(?=[ \t]|$)/.exec(rest)?.[1];
    const pr = p === undefined ? null : Number.parseInt(p, 10);
    out.push({
      verdict: v !== undefined && FINAL_VERDICTS.includes(v) ? v : null,
      pr: pr !== null && pr >= 1 ? pr : null,
      reason: (/(?:^|[ \t])reason=(.*)$/.exec(rest)?.[1] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Render the error line — the TS twin of the playbook's bash `printf`
 * fallback (which must work when node itself is what failed). The reason is
 * collapsed to one line; an unknown verdict/pr renders `unknown`.
 */
export function renderQaVerdictErrorLine(e: {
  verdict: string | null;
  pr: number | null;
  reason: string;
}): string {
  const verdict = String(e.verdict ?? "").replace(/[^A-Za-z-]/g, "") || "unknown";
  const pr = Number.isInteger(e.pr) && (e.pr as number) >= 1 ? String(e.pr) : "unknown";
  const reason = String(e.reason ?? "").replace(/\s+/g, " ").trim();
  return `${QA_VERDICT_ERROR_PREFIX} verdict=${verdict} pr=${pr}${
    reason ? ` reason=${reason}` : ""
  }`;
}

/**
 * Render one trailer line. Inputs are normalised, never rejected, and the
 * output ALWAYS parses (issue #4746): the verdict is trimmed and an unknown
 * literal renders `FAIL` (fail toward loud); the SHA is lowercased and cut to
 * 12 chars, and anything that is not then 7–12 hex chars (empty, unknown,
 * non-hex) renders the `QA_VERDICT_UNKNOWN_SHA` sentinel; counts are floored
 * at their minimum; a zero-blocker verdict always renders
 * `max_severity=none`, and a non-zero blocker count with no usable severity
 * renders `high`.
 */
export function renderQaVerdictTrailer(t: QaVerdictTrailer): string {
  const int = (n: number, min: number): number =>
    Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : min;
  const blockers = int(t.blockers, 0);
  let severity: QaSeverity = "none";
  if (blockers > 0) {
    severity =
      QA_SEVERITIES.includes(t.maxSeverity) && t.maxSeverity !== "none"
        ? t.maxSeverity
        : "high";
  }
  const rawVerdict = String(t.verdict ?? "").trim() as FinalVerdict;
  const verdict: FinalVerdict = FINAL_VERDICTS.includes(rawVerdict)
    ? rawVerdict
    : "FAIL";
  const cut = String(t.sha ?? "").trim().toLowerCase().slice(0, 12);
  const sha = /^[0-9a-f]{7,12}$/.test(cut) ? cut : QA_VERDICT_UNKNOWN_SHA;
  const fixes = (t.qaFixes ?? [])
    .map((f) => String(f ?? "").trim().toLowerCase().slice(0, 12))
    .filter((f) => /^[0-9a-f]{7,12}$/.test(f));
  return (
    `${QA_VERDICT_TRAILER_PREFIX} ${verdict} pr=${int(t.pr, 1)} ` +
    `round=${int(t.round, 1)} sha=${sha} blockers=${blockers} ` +
    `max_severity=${severity}` +
    (fixes.length > 0 ? ` qa-fixes=${fixes.join(",")}` : "")
  );
}

/**
 * The one call the hydra-qa playbook makes: derive `round` from the PR's
 * prior comment + review bodies, then render the trailer line.
 */
export function buildQaVerdictTrailer(input: {
  verdict: FinalVerdict;
  pr: number;
  headSha: string;
  blockers: number;
  maxSeverity: QaSeverity;
  priorBodies: ReadonlyArray<string | null | undefined>;
}): string {
  return renderQaVerdictTrailer({
    verdict: input.verdict,
    pr: input.pr,
    round: nextQaVerdictRound(input.priorBodies, input.pr),
    sha: input.headSha,
    blockers: input.blockers,
    maxSeverity: input.maxSeverity,
  });
}


// ---------------------------------------------------------------------------
// `QA-Fix:` commit trailer (issue #5266, ADR-0046 Decision 2)
//
// Every commit the reviewer pushes carries exactly one trailer line
// `QA-Fix: A` or `QA-Fix: B` (one class per commit). Every agent pushes as the
// same GitHub identity, so only this trailer attributes a commit to the
// reviewer. Pure; never throws.
// ---------------------------------------------------------------------------

/** The literal prefix of the commit trailer. */
export const QA_FIX_TRAILER_PREFIX = "QA-Fix:";

/** Reviewer commit class: A = non-executable, B = tests. */
export type QaFixClass = "A" | "B";

/** Parse result for one commit message's `QA-Fix:` trailer. */
export type QaFixCommitTrailer =
  | { present: false }
  | { present: true; cls: QaFixClass | null; raw: string };

/**
 * Find a line-anchored `QA-Fix:` trailer in a commit message. `present:false`
 * when none; `present:true, cls:null` when the value is anything but exactly
 * `A` or `B` (a violation the caller must surface, never ignore). The LAST
 * such line wins (trailer position).
 */
export function parseQaFixCommitTrailer(
  message: string | null | undefined,
): QaFixCommitTrailer {
  if (typeof message !== "string" || !message.includes(QA_FIX_TRAILER_PREFIX)) {
    return { present: false };
  }
  let found: QaFixCommitTrailer = { present: false };
  for (const m of message.matchAll(/^QA-Fix:([^\r\n]*)\r?$/gm)) {
    const raw = (m[1] as string).trim();
    found = { present: true, cls: raw === "A" || raw === "B" ? raw : null, raw };
  }
  return found;
}
