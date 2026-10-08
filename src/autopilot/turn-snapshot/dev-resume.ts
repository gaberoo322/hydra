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
 *   - its OWN pre-qualification gates (orch: not GLM-provenance, not draft /
 *     ready-for-human, not DIRTY/UNKNOWN, quiescent; Target: not a REST
 *     `draft`), applied before the candidates reach this function;
 *   - its closing-issue reader (it owns the per-realm stderr note when the
 *     predicate fails) and, for the orch realm, a "required checks settled"
 *     gate;
 *   - its selection policy — kept per realm because the two wires already
 *     differ and the kv output must stay byte-identical (ADR-0043 D4):
 *       `lowest-pr`                 orch #4518: the lowest-numbered qualifying PR;
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
      if (!inputs.resumeIssues.has(q.issue)) continue;
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
