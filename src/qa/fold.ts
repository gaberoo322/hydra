/**
 * src/qa/fold.ts — the fold phase: reviewer findings -> review verdict, trailer counts and the QA report.
 *
 * Moved verbatim out of scripts/ci/qa-verdict.ts (issue #5079, qa-verdict-engine
 * slice 2/4; ADR-0038). Pure — no fs/network. The workflow-facing facade
 * scripts/ci/qa-verdict.ts re-exports the names its consumers import.
 */

import { classifyVerdict, redRequiredChecks, renderCiSummary, type CheckState, type ReviewVerdict, type VerdictResult } from "./admission.ts";
import type { QaSeverity } from "./verdict-trailer.ts";

/**
 * T3 adversarial-QA aggregation (issue #739).
 *
 * Tier model (ADR-0015, monotonic T1<T2<T3<T4): a T3-classified diff must
 * survive an *adversarial* (refutation-framed) review before it auto-merges.
 * Instead of a single standard QA pass, the playbook fans out to TWO
 * independent reviewers — each prompted to actively find a reason the change
 * is wrong / regresses something, neither told the other exists. The diff
 * passes only if BOTH reviewers surface no real blocker; a single real
 * blocker from EITHER reviewer is a FAIL.
 *
 * This helper is the pure aggregation rule. It does NOT change the verdict
 * literal consumed by decide.py — it folds the two reviewer verdicts into the
 * single `ReviewVerdict` ("PASS" | "FAIL") that `classifyVerdict` already
 * takes. The CI-state classification downstream is unchanged; this is purely
 * additive verification depth (the issue: "no policy change here").
 *
 * Tiering is the caller's job (the playbook reads `GET /api/tier`). For T1/T2
 * the caller passes a single reviewer verdict straight to `classifyVerdict`
 * and never calls this; for T3 (and T4, which inherits T3 depth) the caller
 * collects two reviewer verdicts and folds them here first.
 */
export interface AdversarialReviewResult {
  /** AND over the two reviewers — PASS iff neither found a real blocker. */
  reviewVerdict: ReviewVerdict;
  /** Human-readable reason, naming the blocking reviewer(s) on FAIL. */
  reason: string;
}

/**
 * Fold two independent refutation reviewers into one review verdict.
 *
 * `PASS` iff BOTH reviewers returned `PASS` (neither surfaced a real
 * blocker). Any single `FAIL` short-circuits the aggregate to `FAIL` — the
 * defining asymmetry of refutation framing: one refuter is enough to bounce.
 *
 * @param reviewerA verdict from the first independent reviewer
 * @param reviewerB verdict from the second independent reviewer
 */
export function aggregateAdversarialReview(
  reviewerA: ReviewVerdict,
  reviewerB: ReviewVerdict,
): AdversarialReviewResult {
  const aFail = reviewerA === "FAIL";
  const bFail = reviewerB === "FAIL";

  if (aFail && bFail) {
    return {
      reviewVerdict: "FAIL",
      reason:
        "Adversarial QA (T3): both refutation reviewers surfaced a real blocker.",
    };
  }
  if (aFail) {
    return {
      reviewVerdict: "FAIL",
      reason:
        "Adversarial QA (T3): reviewer A surfaced a real blocker (reviewer B clean).",
    };
  }
  if (bFail) {
    return {
      reviewVerdict: "FAIL",
      reason:
        "Adversarial QA (T3): reviewer B surfaced a real blocker (reviewer A clean).",
    };
  }
  return {
    reviewVerdict: "PASS",
    reason:
      "Adversarial QA (T3): both independent refutation reviewers found no real blocker.",
  };
}

/**
 * The heading every findings section starts with (issue #4758). The ONE
 * literal `priorFindingsSection` slices on and `isReviewedFailRound` greps
 * for, so a round is counted as "reviewed" exactly when its comment carries
 * the heading `renderReviewReport` emits — the three can never drift apart.
 * The playbook's bash-side literals (e.g. the fold-failure REPORT) quote this
 * text verbatim; change it there in the same PR.
 */
export const QA_FINDINGS_HEADING = "### Findings";

// ---------------------------------------------------------------------------
// Severity-gated findings fold (issue #4734)
//
// Every reviewer finding carries `severity`, `file:line` and a concrete fix.
// The T1–T3 fold FAILs when ANY finding is medium or higher. A low finding
// never blocks, whatever the reviewer count (issue #4916): it PASSes and every
// low becomes a non-blocking follow-up (the same low raised by both reviewers
// is merged into one row). T4 (and an unknown tier, fail-closed) keeps the pre-#4734
// any-blocker semantics: every finding blocks, folded through the unchanged
// `aggregateAdversarialReview`.
//
// The fold changes only how `REVIEW_VERDICT` is computed. The verdict
// literals, `classifyVerdict`, and decide.py are untouched. Pure, never throws.
// ---------------------------------------------------------------------------

/** A finding's severity. The rubric the reviewer prompts carry:
 *  high   — behaviour regression, data or work loss, or a weakened safety gate
 *  medium — a spec criterion unmet, or a real bug on a non-critical path
 *  low    — wording, comments, citations, style */
export type FindingSeverity = "high" | "medium" | "low";

/** Which review axis raised the finding. */
export type FindingAxis = "standards" | "spec";

/** One reviewer finding, as the step-8 aggregate transcribes it. */
export interface ReviewFinding {
  severity: FindingSeverity;
  axis: FindingAxis;
  /** The reviewer sub-agent that raised it, e.g. `reviewer-A-standards`. */
  reviewer: string;
  /** `path/to/file.ts:42` (or `path:12-18`); `PR body` for body findings. */
  location: string;
  finding: string;
  fix: string;
  /**
   * Optional dedupe key the aggregator sets when two reviewers raised the
   * same finding at different locations. Without it, findings are matched
   * by `location`.
   */
  key?: string;
}

/** One table row after merging the same finding raised by several reviewers. */
export interface FoldedFinding {
  severity: FindingSeverity;
  axis: FindingAxis;
  location: string;
  finding: string;
  fix: string;
  /** Every reviewer sub-agent that raised it, in input order. */
  reviewers: string[];
  /** Distinct independent reviewers (A / B, `primary`, or `other:<name>`) that raised it. */
  reviewerGroups: string[];
}

export interface FindingsFoldResult {
  reviewVerdict: ReviewVerdict;
  /** `severity-gated` for T1–T3; `any-blocker` for T4 / unknown tier. */
  mode: "severity-gated" | "any-blocker";
  /** Findings that block, worst first. */
  blocking: FoldedFinding[];
  /** Non-blocking follow-ups (every low finding on T1–T3), worst first. */
  followUps: FoldedFinding[];
  /** `blocking.length` — the trailer's `blockers=` before red CI checks. */
  blockers: number;
  /** Worst blocking severity; `none` when nothing blocks. */
  maxSeverity: QaSeverity;
  /** One line (≤ 120 chars) naming the worst blocking finding, or "". */
  worstFinding: string;
  reason: string;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 3, medium: 2, low: 1 };

function normaliseSeverity(raw: unknown): FindingSeverity {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  // Fail toward loud: a missing or unknown severity is treated as high.
  return s === "medium" || s === "low" || s === "high" ? s : "high";
}

function oneLine(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** The reviewer names that together form the ONE primary (non-T3) reviewer. */
const PRIMARY_REVIEWER_NAMES: ReadonlySet<string> = new Set(["standards", "spec", "reviewer-single", "primary"]);

/**
 * The independent reviewer a sub-agent belongs to (matched case-insensitively):
 * `reviewer-A-standards` and `reviewer-A-spec` are both reviewer `A`. The
 * T1/T2 `standards` / `spec` pair and `reviewer-single` are the one `primary`
 * reviewer, and an empty reviewer name reaches the fold as `primary` too
 * (`normaliseReviewFindings` defaults an absent `reviewer` field to
 * `primary`), so it joins that group rather than forming its own (issue
 * #4758). Any OTHER name is its own group (fail-safe): an unrecognised name
 * must never collapse into `primary` and so silently misattribute its
 * findings (the T4 per-reviewer verdicts and the merged row's reviewer list
 * both key on the group).
 */
export function reviewerGroup(reviewer: string): string {
  const name = String(reviewer ?? "").trim();
  const m = /^reviewer-([a-z0-9]+)-(?:standards|spec)$/i.exec(name);
  if (m) return (m[1] as string).toUpperCase();
  if (PRIMARY_REVIEWER_NAMES.has(name.toLowerCase())) return "primary";
  return `other:${name.toLowerCase() || "(unnamed)"}`;
}

/** The synthetic finding id every malformed-input finding carries. */
export const MALFORMED_FINDING_ID = "reviewer-output-malformed";

function malformedFinding(what: string, raw: unknown): ReviewFinding {
  let preview: string;
  try {
    preview = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
  } catch (err) {
    console.error("[qa-verdict] could not serialise malformed findings input:", err);
    preview = String(raw);
  }
  preview = oneLine(preview).slice(0, 200);
  console.error(`[qa-verdict] ${MALFORMED_FINDING_ID}: ${what} — ${preview || "(empty)"}`);
  return {
    severity: "high",
    axis: "standards",
    reviewer: "hydra-qa",
    location: "(reviewer output)",
    finding: `${MALFORMED_FINDING_ID}: ${what}${preview ? ` — raw: ${preview}` : ""}`,
    fix: "Re-run QA; every reviewer must emit its findings as a JSON array of objects (`[]` when it has none).",
  };
}

/**
 * Coerce untrusted aggregate JSON into findings. Never throws, and FAILS
 * CLOSED (QA round 1 on PR #4752): only an explicit array is a findings list
 * — `[]` is a legitimate "no findings". Anything else (`undefined` for a
 * missing file, an unparseable string, an object such as `{findings: […]}`)
 * becomes one high `reviewer-output-malformed` finding, and a row that is
 * not an object becomes a high finding carrying the raw row text. Every
 * malformed shape is logged. A missing severity becomes `high`, so a
 * malformed row can never downgrade a verdict.
 */
export function normaliseReviewFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) {
    const what =
      raw === undefined || raw === null
        ? "findings input missing"
        : typeof raw === "string"
          ? "findings input is not parseable JSON"
          : "findings input is not an array";
    return [malformedFinding(what, raw)];
  }
  const out: ReviewFinding[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      out.push(malformedFinding("a findings row is not an object", row));
      continue;
    }
    const r = row as Record<string, unknown>;
    const axis = oneLine(r.axis).toLowerCase() === "spec" ? "spec" : "standards";
    const key = oneLine(r.key);
    out.push({
      severity: normaliseSeverity(r.severity),
      axis,
      reviewer: oneLine(r.reviewer) || "primary",
      location: oneLine(r.location ?? r.file) || "(no location)",
      finding: oneLine(r.finding) || "(no description)",
      fix: oneLine(r.fix) || "(no fix given)",
      ...(key ? { key } : {}),
    });
  }
  return out;
}

/**
 * Locations that name no place in the code, so they must NEVER merge two
 * reviewers' findings (compared case-insensitively after trimming). Two
 * unrelated `PR body` nits are not "the same finding". Anything that is not
 * path-like is excluded the same way by `canonicalLocationKey`: after
 * stripping one pair of surrounding quotes/backticks and one trailing
 * parenthetical, the path part must contain no whitespace and must carry a
 * `/` or `.` — or a `:N` line reference, which alone makes an extension-less
 * `Dockerfile:12` path-like (issue #4758).
 */
export const NON_MERGEABLE_LOCATIONS: readonly string[] = [
  "",
  "(no location)",
  "pr body",
  "n/a",
  "-",
  "none",
];

/** Quote/backtick characters `stripWrappingPair` removes as ONE matched pair. */
const WRAPPING_QUOTE_CHARS: ReadonlySet<string> = new Set(["`", '"', "'"]);

/** Drop ONE pair of matching surrounding backticks / double / single quotes. */
function stripWrappingPair(s: string): string {
  if (s.length >= 2 && WRAPPING_QUOTE_CHARS.has(s[0] as string) && s[0] === s[s.length - 1]) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * The canonical merge key for a finding's location (PR #4752 QA round 2), or
 * `null` when the location must never merge. Normalises in this order
 * (issue #4758): trim → strip ONE pair of matching surrounding backticks /
 * double quotes / single quotes → drop ONE trailing parenthetical
 * (`\s*\([^()]*\)$`, so `src/foo.ts:12 (fn)` keys as `src/foo.ts:12`) →
 * strip quotes/backticks again → trim → lowercase → drop a leading `./` →
 * `NON_MERGEABLE_LOCATIONS` check (so a backticked placeholder is still
 * null). Then folds every accepted line form to `path:N`: `path:12`,
 * `path:L12`, `path#L12`, `path L12`, `path:12-18` (range start), and
 * `path:12:5` (column dropped). A bare `path` keys as `path`. The path part
 * must match `[\w@.\-/]+` (whitespace anywhere in it means null) and must
 * contain a `/` or `.` — unless it carries a line number, which alone makes
 * an extension-less, slash-less file name path-like (`Dockerfile:12` →
 * `dockerfile:12`; a bare `Dockerfile` stays null).
 */
export function canonicalLocationKey(raw: string): string | null {
  let s = String(raw ?? "").trim();
  s = stripWrappingPair(s);
  s = s.replace(/\s*\([^()]*\)$/, "");
  s = stripWrappingPair(s);
  s = s.trim().toLowerCase().replace(/^\.\//, "");
  if (NON_MERGEABLE_LOCATIONS.includes(s)) return null;
  const m = /^(.+?)(?:(?::l?|#l|\s+l)(\d+)(?::\d+)?(?:\s*[-–]\s*l?\d+)?)?$/.exec(s);
  if (!m) return null;
  const path = (m[1] as string).trim();
  if (!/^[\w@.\-/]+$/.test(path)) return null;
  const line = m[2];
  if (line === undefined && !/[/.]/.test(path)) return null;
  return line !== undefined ? `${path}:${Number.parseInt(line, 10)}` : path;
}

/**
 * Merge the same finding raised by DIFFERENT independent reviewers into one
 * row. Two rows from the same reviewer at one location stay separate — they
 * are distinct findings, and merging them would hide one from the table.
 */
function mergeFindings(findings: readonly ReviewFinding[]): FoldedFinding[] {
  const rows: Array<FoldedFinding & { matchKey: string | null }> = [];
  for (const f of findings) {
    // An explicit `key` or a canonical path-like location (`canonicalLocationKey`)
    // matches another reviewer's row. A placeholder (NON_MERGEABLE_LOCATIONS) never
    // merges, so two unrelated body findings are not mistaken for one.
    const explicitKey = (f.key ?? "").trim().toLowerCase();
    const key = explicitKey || canonicalLocationKey(f.location);
    const group = reviewerGroup(f.reviewer);
    const existing =
      key === null
        ? undefined
        : rows.find((r) => r.matchKey === key && !r.reviewerGroups.includes(group));
    if (!existing) {
      rows.push({
        matchKey: key,
        severity: f.severity,
        axis: f.axis,
        location: f.location,
        finding: f.finding,
        fix: f.fix,
        reviewers: [f.reviewer],
        reviewerGroups: [group],
      });
      continue;
    }
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = f.severity;
      existing.axis = f.axis;
      existing.finding = f.finding;
      existing.fix = f.fix;
    }
    if (!existing.reviewers.includes(f.reviewer)) existing.reviewers.push(f.reviewer);
    if (!existing.reviewerGroups.includes(group)) existing.reviewerGroups.push(group);
  }
  return rows.map(({ matchKey: _matchKey, ...row }) => row);
}

function worstFirst(rows: FoldedFinding[]): FoldedFinding[] {
  // Array.prototype.sort is stable, so equal severities keep input order.
  return [...rows].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/**
 * Normalise the step-8 aggregate into findings rows, dispatching on whether
 * the caller named its spawned reviewers (issue #4758).
 *
 * `spawnedReviewers` ABSENT (or null) — today's flat-array behaviour,
 * unchanged: `normaliseReviewFindings` handles the whole input.
 *
 * `spawnedReviewers` PRESENT — `findings` must be the **per-reviewer map**:
 * one own-property entry per spawned reviewer name, each value a JSON array
 * of that reviewer's rows. The coverage check fails closed:
 * - a spawned reviewer with NO entry, or a NON-ARRAY entry, becomes ONE high
 *   `reviewer-output-malformed` finding naming that reviewer (an omitted
 *   reviewer is malformed, not clean — only an explicit `[]` is clean);
 * - `spawnedReviewers: []` (present but empty) is itself a high malformed
 *   finding — the caller claimed a fan-out but named no one to verify;
 * - a flat-array (or non-object) `findings` input alongside a present
 *   `spawnedReviewers` is likewise malformed — never a silent PASS.
 * Rows under a map key that is NOT in `spawnedReviewers` are still normalised
 * and counted, never dropped; a row missing its own `reviewer` field inherits
 * the map key. Never throws.
 */
function collectReviewFindings(input: {
  findings: unknown;
  spawnedReviewers?: readonly string[] | null;
}): ReviewFinding[] {
  if (input.spawnedReviewers === undefined || input.spawnedReviewers === null) {
    return normaliseReviewFindings(input.findings);
  }
  const spawned = [
    ...new Set(
      input.spawnedReviewers
        .map((r) => String(r ?? "").trim())
        .filter((r) => r !== ""),
    ),
  ];
  if (spawned.length === 0) {
    return [
      malformedFinding(
        "spawnedReviewers is present but empty — no reviewer coverage could be verified",
        input.spawnedReviewers,
      ),
    ];
  }
  const map = input.findings;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return [
      malformedFinding(
        "with spawnedReviewers the findings input must be a per-reviewer map (an object keyed by reviewer name)",
        map,
      ),
      ...spawned.map((r) => missingReviewerFinding(r, undefined)),
    ];
  }
  const entries = Object.entries(map as Record<string, unknown>);
  const spawnedKeys = new Set(spawned.map((r) => r.toLowerCase()));
  const out: ReviewFinding[] = [];
  for (const r of spawned) {
    const entry = entries.find(([k]) => k.trim().toLowerCase() === r.toLowerCase());
    if (entry === undefined || !Array.isArray(entry[1])) {
      out.push(missingReviewerFinding(r, entry?.[1]));
    }
  }
  for (const [key, value] of entries) {
    if (spawnedKeys.has(key.trim().toLowerCase()) && !Array.isArray(value)) {
      continue; // already one malformed finding for this reviewer (INV: ONE per entry)
    }
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      out.push(normaliseMappedRow(key, row));
    }
  }
  return out;
}

/** One high malformed finding for a spawned reviewer missing from the map. */
function missingReviewerFinding(reviewer: string, raw: unknown): ReviewFinding {
  return malformedFinding(
    `spawned reviewer \`${reviewer}\` has no array findings entry in the per-reviewer map — ` +
      "an omitted reviewer is malformed, not clean (only an explicit [] is)",
    raw,
  );
}

/** Normalise ONE row of a per-reviewer map entry; `key` is the map key. */
function normaliseMappedRow(key: string, row: unknown): ReviewFinding {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return malformedFinding(`a findings row under reviewer \`${key}\` is not an object`, row);
  }
  const r = row as Record<string, unknown>;
  const axis = oneLine(r.axis).toLowerCase() === "spec" ? "spec" : "standards";
  const explicitKey = oneLine(r.key);
  return {
    severity: normaliseSeverity(r.severity),
    axis,
    reviewer: oneLine(r.reviewer) || key,
    location: oneLine(r.location ?? r.file) || "(no location)",
    finding: oneLine(r.finding) || "(no description)",
    fix: oneLine(r.fix) || "(no fix given)",
    ...(explicitKey ? { key: explicitKey } : {}),
  };
}

/**
 * Fold the reviewers' findings into one review verdict (issue #4734).
 *
 * - T1–T3: FAIL iff any finding is medium/high (a missing or unknown severity
 *   is normalised to high). A low never blocks, whatever the reviewer count
 *   (issue #4916): every low → PASS + follow-ups, a low both reviewers raised
 *   listed once as a merged row.
 * - T4, or an unknown tier (`null`, fail-closed): unchanged any-blocker
 *   semantics — every finding blocks. The verdict is the pre-#4734
 *   `aggregateAdversarialReview` AND over reviewers A and B.
 * - `spawnedReviewers` (issue #4758): when present, `findings` must be the
 *   per-reviewer map and every spawned reviewer must carry an explicit array
 *   entry — see `collectReviewFindings`. Absent keeps the flat-array shape.
 */
export function foldReviewFindings(input: {
  tier: number | null;
  findings: unknown;
  spawnedReviewers?: readonly string[] | null;
}): FindingsFoldResult {
  // A tier that is not a finite number >= 1 (null, NaN, 0, negative) takes the
  // strict any-blocker path, the same as an unknown tier (fail closed).
  const tier = typeof input.tier === "number" && Number.isFinite(input.tier) && input.tier >= 1 ? input.tier : null;
  const rows = mergeFindings(collectReviewFindings(input));
  const anyBlocker = tier === null || tier >= 4;

  let blocking: FoldedFinding[];
  let followUps: FoldedFinding[];
  let reviewVerdict: ReviewVerdict;
  let reason: string;
  if (anyBlocker) {
    blocking = worstFirst(rows);
    followUps = [];
    // Per-reviewer verdicts (A / B), folded by the unchanged T3/T4 AND. A row
    // from a non-A/B reviewer still blocks: any finding at all is a FAIL.
    const failed = (g: string): ReviewVerdict =>
      blocking.some((r) => r.reviewerGroups.includes(g)) ? "FAIL" : "PASS";
    const agg = aggregateAdversarialReview(failed("A"), failed("B"));
    reviewVerdict = blocking.length > 0 ? "FAIL" : agg.reviewVerdict;
    reason =
      tier === null
        ? `Tier unknown — fail-closed to the any-blocker fold: ${agg.reason}`
        : `T4 Verifier-Core — any-blocker fold (unchanged): ${agg.reason}`;
  } else {
    const blocks = (r: FoldedFinding): boolean => r.severity !== "low";
    blocking = worstFirst(rows.filter(blocks));
    followUps = worstFirst(rows.filter((r) => !blocks(r)));
    reviewVerdict = blocking.length > 0 ? "FAIL" : "PASS";
    reason =
      blocking.length > 0
        ? `Severity-gated fold (T${tier}): ${blocking.length} blocking finding(s) — medium or higher.`
        : `Severity-gated fold (T${tier}): no medium/high finding` +
          (followUps.length > 0 ? ` — ${followUps.length} non-blocking follow-up(s).` : ".");
  }

  const top = blocking[0];
  const worstFinding = top ? `${top.location} — ${top.finding}`.slice(0, 120) : "";
  return {
    reviewVerdict,
    mode: anyBlocker ? "any-blocker" : "severity-gated",
    blocking,
    followUps,
    blockers: blocking.length,
    maxSeverity: top ? top.severity : "none",
    worstFinding,
    reason,
  };
}

/**
 * The trailer's `blockers=` / `max_severity=` for a verdict: the fold's
 * blocking findings plus one `high` blocker per red required check (the
 * #4729 rule), so a CI-driven FAIL never renders `blockers=0`.
 */
export function trailerBlockerCounts(
  fold: Pick<FindingsFoldResult, "blockers" | "maxSeverity"> & { reviewVerdict?: ReviewVerdict },
  redRequired: readonly string[],
): { blockers: number; maxSeverity: QaSeverity } {
  const findingBlockers = Number.isFinite(fold.blockers) ? Math.max(0, Math.trunc(fold.blockers)) : 0;
  const blockers = findingBlockers + redRequired.length;
  if (redRequired.length > 0) return { blockers, maxSeverity: "high" };
  // A FAIL review verdict is never rendered as `blockers=0`: if a caller's
  // counts disagree with its verdict, count one high blocker (fail loud).
  if (fold.reviewVerdict === "FAIL" && blockers === 0) return { blockers: 1, maxSeverity: "high" };
  return { blockers, maxSeverity: blockers > 0 ? fold.maxSeverity : "none" };
}

function cell(raw: string): string {
  return oneLine(raw).replace(/\|/g, "\\|");
}

/** Markdown findings table: severity, axis, reviewer, file:line, finding, fix. */
export function renderFindingsTable(rows: readonly FoldedFinding[]): string {
  const header = "| Severity | Axis | Reviewer | File:line | Finding | Fix |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.severity} | ${r.axis} | ${cell(r.reviewers.join(", "))} | ${cell(r.location)} | ${cell(r.finding)} | ${cell(r.fix)} |`,
  );
  return [header, sep, ...body].join("\n");
}

/**
 * The step-8 `$REVIEW_REPORT`: the blocking findings table, the non-blocking
 * follow-ups, one short paragraph per axis, and the fan-out line. The CI
 * state is NOT here — step 10 adds it once, via `renderCiSummary`.
 */
export function renderReviewReport(input: {
  fold: FindingsFoldResult;
  standardsSummary: string;
  specSummary: string;
  fanoutReason?: string;
}): string {
  const { fold } = input;
  const parts: string[] = [QA_FINDINGS_HEADING, ""];
  parts.push(fold.blocking.length > 0 ? renderFindingsTable(fold.blocking) : "_No blocking findings._");
  if (fold.followUps.length > 0) {
    parts.push("", "### Follow-ups (non-blocking)", "", renderFindingsTable(fold.followUps));
  }
  parts.push(
    "",
    "## Standards",
    "",
    oneLine(input.standardsSummary) || "_No summary._",
    "",
    "## Spec",
    "",
    oneLine(input.specSummary) || "_No summary._",
    "",
    fold.reason,
  );
  const fanout = oneLine(input.fanoutReason);
  if (fanout) parts.push(fanout);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Phase head (issue #5079, INV-3): the ONE composed entry the fold step binds
// to, in the playbook's order: foldReviewFindings -> trailerBlockerCounts ->
// renderReviewReport -> classifyVerdict -> renderCiSummary. No new rule.
// ---------------------------------------------------------------------------

export interface FoldReviewInput {
  tier: number | null;
  findings: unknown;
  spawnedReviewers?: readonly string[] | null;
  /** The step-5 check states (post `buildCheckStates`). */
  checks: CheckState[];
  standardsSummary: string;
  specSummary: string;
  fanoutReason?: string;
}

export interface FoldReviewResult {
  fold: FindingsFoldResult;
  /** The trailer's `blockers=` / `max_severity=` (findings + red required checks). */
  counts: { blockers: number; maxSeverity: QaSeverity };
  /** The step-8 `$REVIEW_REPORT`. */
  report: string;
  /** The step-9 final classification (review verdict x CI state). */
  verdict: VerdictResult;
  /** The step-10 CI summary block. */
  ciSummary: string;
}

export function foldReview(input: FoldReviewInput): FoldReviewResult {
  const fold = foldReviewFindings({
    tier: input.tier,
    findings: input.findings,
    spawnedReviewers: input.spawnedReviewers,
  });
  const counts = trailerBlockerCounts(fold, redRequiredChecks(input.checks));
  const report = renderReviewReport({
    fold,
    standardsSummary: input.standardsSummary,
    specSummary: input.specSummary,
    fanoutReason: input.fanoutReason,
  });
  const verdict = classifyVerdict(fold.reviewVerdict, input.checks);
  return { fold, counts, report, verdict, ciSummary: renderCiSummary(verdict) };
}
