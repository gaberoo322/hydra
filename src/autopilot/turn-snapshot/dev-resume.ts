/**
 * turn-snapshot/dev-resume.ts — the ONE dev-resume pick both realms share
 * (ADR-0043 slice 4, issue #4932).
 *
 * A dev-resume pick names the open PR whose existing branch a `dev_*`
 * dispatch should push a fix-forward to: `issue-<N>:<pr>:<headRef>`. Before
 * this module the rule lived twice — the orchestrator copy (#4518, moved into
 * pr-gate.ts by slice 1) and a second inline-python copy in
 * `collect_target_board` (#4739). Both now call {@link pickDevResume}; each
 * realm only supplies what genuinely differs:
 *
 *   - its OWN pre-qualification gates (orch: not draft / ready-for-human,
 *     not DIRTY/UNKNOWN, quiescent — provenance-agnostic since #5058; Target:
 *     not a REST `draft`), applied before the candidates reach this function;
 *   - its closing-issue reader (it owns the per-realm stderr note when the
 *     predicate fails) and, for the orch realm, a "required checks settled"
 *     gate;
 *   - its selection policy — kept per realm because the two wires already
 *     differ and the kv output must stay byte-identical (ADR-0043 D4):
 *       `lowest-pr`                 orch #4518: the lowest-numbered qualifying PR
 *                                   (plus the orch red-CI arm, `alsoQualifies`, #5058);
 *       `lowest-unambiguous-issue`  Target #4739: the lowest-numbered resume
 *                                   issue with EXACTLY one qualifying PR (an
 *                                   issue with two is ambiguous — skipped).
 *
 * Shared, policy-independent qualification: the head ref is a non-empty
 * `:`-free string (`:` would corrupt the packed wire), the PR closes EXACTLY
 * one issue (closing, never merely referencing), and that issue carries the
 * resume label. Pure — no I/O; never throws unless a caller callback does.
 */

import type { PrPick } from "./pr-gate.ts";

export type DevResumePolicy = "lowest-pr" | "lowest-unambiguous-issue";

/** One realm-pre-qualified open PR, in payload order. */
export interface DevResumeCandidate {
  readonly pr: number;
  /** The head ref, or `null` when absent / not a string. */
  readonly headRefName: string | null;
}

export interface DevResumePickInputs<C extends DevResumeCandidate> {
  readonly candidates: readonly C[];
  /** Issue numbers carrying the resume label (`needs-dev-resume`). */
  readonly resumeIssues: ReadonlySet<number>;
  /** The issues one PR closes; `null` = the predicate failed for it (the realm noted why) → skipped. */
  readonly closing: (candidate: C) => ReadonlySet<number> | null;
  /** Optional realm gate evaluated after the closing check (orch: required checks settled). */
  readonly settled?: (candidate: C) => boolean;
  /**
   * Optional second qualifier for the `lowest-pr` policy (orch #5058: a
   * required check red at the head — the retired GLM-only #4460 arm, now
   * provenance-agnostic). A candidate qualifies when its closing issue carries
   * the resume label OR this returns true. Ignored by `lowest-unambiguous-issue`.
   */
  readonly alsoQualifies?: (candidate: C) => boolean;
  readonly policy: DevResumePolicy;
}

/** A head ref that can ride the `issue-<N>:<pr>:<head>` wire. */
export function isResumableHead(head: string | null): head is string {
  return head !== null && head !== "" && !head.includes(":");
}

/** The dev-resume pick, or `null` when nothing qualifies. */
export function pickDevResume<C extends DevResumeCandidate>(inputs: DevResumePickInputs<C>): PrPick | null {
  const qualifying: { readonly candidate: C; readonly head: string; readonly issue: number }[] = [];
  for (const candidate of inputs.candidates) {
    const head = candidate.headRefName;
    if (!isResumableHead(head)) continue;
    const closed = inputs.closing(candidate);
    if (closed === null || closed.size !== 1) continue;
    const issue = [...closed][0];
    if (inputs.settled !== undefined && !inputs.settled(candidate)) continue;
    qualifying.push({ candidate, head, issue });
  }

  if (inputs.policy === "lowest-pr") {
    let pick: PrPick | null = null;
    for (const q of qualifying) {
      if (!inputs.resumeIssues.has(q.issue) && !(inputs.alsoQualifies?.(q.candidate) ?? false)) continue;
      if (pick === null || q.candidate.pr < pick.pr) pick = { issue: q.issue, pr: q.candidate.pr, headRefName: q.head };
    }
    return pick;
  }

  const perIssue = new Map<number, (typeof qualifying)[number][]>();
  for (const q of qualifying) perIssue.set(q.issue, [...(perIssue.get(q.issue) ?? []), q]);
  const unambiguous = [...inputs.resumeIssues].filter((n) => perIssue.get(n)?.length === 1).sort((a, b) => a - b);
  if (unambiguous.length === 0) return null;
  const only = (perIssue.get(unambiguous[0]) ?? [])[0];
  return { issue: only.issue, pr: only.candidate.pr, headRefName: only.head };
}

// ---------------------------------------------------------------------------
// The no-PR resume pick (issue #4808)
// ---------------------------------------------------------------------------

/**
 * The quiescence window (seconds) a `needs-dev-resume` issue must have sat
 * UNCHANGED before the no-PR pick may name it — the label is applied by reap's
 * stall handler the moment a dispatch stalls, so without a window the very
 * next turn would pin the same anchor a still-standing dispatch just failed
 * on. Env-overridable through PrGateEnv like the existing windows.
 */
export const DEFAULT_NOPR_RESUME_QUIESCENCE_SECONDS = 5400;

/** One `needs-dev-resume` issue row from the widened label read (#4808, INV-3). */
export interface NoPrResumeRow {
  readonly number: number;
  readonly labels: ReadonlySet<string>;
  /** Epoch seconds, or `null` when missing/unparseable — the row is SKIPPED, never a failed read (INV-2). */
  readonly updatedAt: number | null;
}

export interface NoPrResumeInputs {
  readonly rows: readonly NoPrResumeRow[];
  /**
   * `inflight.union` — every issue ANY open PR references (head-branch OR
   * body, drafts and GLM PRs included). An issue in this set HAS a durable
   * owner already (the #4807/#4518/#4460 PR-keyed pins), so it never
   * qualifies here (INV-7).
   */
  readonly inflightUnion: ReadonlySet<number>;
  readonly nowSeconds: number;
  readonly quiescenceSeconds: number;
}

/**
 * The no-PR durable dev-resume pick (#4808): the LOWEST-numbered issue that
 * (a) carries `needs-dev-resume`, (b) is NOT referenced by any open PR,
 * (c) carries neither `in-progress` nor `ready-for-human`, and (d) has been
 * quiescent for at least `quiescenceSeconds`. The min is an EXPLICIT numeric
 * comparison, never payload order. Pure — no I/O; never throws.
 */
export function pickNoPrResume(inputs: NoPrResumeInputs): number | null {
  let pick: number | null = null;
  for (const row of inputs.rows) {
    if (!row.labels.has("needs-dev-resume")) continue;
    if (inputs.inflightUnion.has(row.number)) continue;
    if (row.labels.has("in-progress") || row.labels.has("ready-for-human")) continue;
    if (row.updatedAt === null) continue;
    if (inputs.nowSeconds - row.updatedAt < inputs.quiescenceSeconds) continue;
    if (pick === null || row.number < pick) pick = row.number;
  }
  return pick;
}
