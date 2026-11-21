/**
 * Lifecycle writer seam (ADR-0047 Decisions 3, 4, 5, 7; issue #5310).
 *
 * The re-read -> gate -> write -> verify spine, generalised from
 * `runVerifiedAction` (src/api/autopilot-board.ts). Spine order is fixed:
 *
 *   re-read (viewIssue) -> derive state -> human-hold refuse -> legality ->
 *   fetch records (injected) -> pure gate -> mode branch -> ONE gh write ->
 *   re-read verify -> journal append
 *
 * Never throws and never falls back to a direct label write: a failed fetch is
 * a `fetch-failed` refusal, a failed write is `write-failed:<gh-code>`, a
 * post-write mismatch is `write-unverified`. Every external effect (gh, Redis,
 * clock, mode) is an injectable dep so the whole spine is testable offline.
 *
 * Shadow vs enforce: in `shadow` a failing/illegal (non-human-hold) transition
 * STILL writes and journals ONE `refused` entry `shadow-would-refuse:<code>`
 * (`written:true`); in `enforce` it journals `refused:<code>` (`written:false`).
 * Human-hold exits are refused in BOTH modes, before the mode branch.
 */
import { logger } from "../logger.ts";
import type { IssueViewResult } from "../github/issue-actions.ts";
import { extractClearanceBlockerRefs } from "../github/blockers.ts";
import type { JournalSource, LifecycleJournalEntry } from "../redis/lifecycle-journal.ts";
import {
  evaluateGate,
  isPullRequestUrl,
  parseCommentEvidence,
  parsePrEvidence,
  recordsNeeded,
  type GateInput,
  type GateRecords,
} from "./gates.ts";
import { isUnsanctionedHoldExit } from "./hold-exit.ts";
import {
  buildSeedEvidence,
  capExitOf,
  countDeepQaFailsAfterReset,
  countReviewedFailRoundsAfterReset,
  evaluateCaps,
  isLiveArm,
  isJournalMiss,
  latestResetMs,
  resolveCapLimits,
  type CapAttempt,
  type CapCount,
  type CapExitCode,
  type CapEvaluation,
  type TimelineLabelEvent,
} from "./caps.ts";
import { parkForCap } from "./park.ts";
import type { LifecycleMode, SeamDeps } from "./seam-deps.ts";
import {
  findTransition,
  isHumanHold,
  isLifecycleState,
  stateLabelsOf,
  type CapEdge,
  type LifecycleState,
} from "./transitions.ts";
// ---------------------------------------------------------------------------
// cap check (ADR-0047 D6, issue #5314)
// ---------------------------------------------------------------------------

type CapCheck =
  | { status: "skipped" }
  | { status: "checked"; evaluation: CapEvaluation };

/**
 * Gather every cap source and evaluate. Any fetch failure (issue comments,
 * journal AND timeline, PR bodies) skips the check for this call (INV-12): the
 * attempt proceeds and never parks. Never throws.
 */
async function checkCaps(
  deps: SeamDeps,
  issue: number,
  attempt: CapAttempt,
  pr: number | null,
): Promise<CapCheck> {
  try {
    const comments = await deps.fetch.issueComments(issue);
    if (comments.ok === false) return { status: "skipped" };
    const resetMs = latestResetMs(comments.value);
    const resolved = resolveCapLimits(deps.env());
    for (const w of resolved.warnings) logger.warn({ issue }, `[lifecycle] ${w}`);

    const journalRead = await deps.journal.read(deps.repo, issue);
    const entries = journalRead.ok ? journalRead.entries : [];
    const journalFailed = journalRead.ok === false;
    let timeline: TimelineLabelEvent[] | null = null;
    // The qa-fail arm is trailer-sourced: the journal/timeline arms cannot park it.
    if (attempt.kind !== "qa-fail" && isJournalMiss(entries, resetMs, journalFailed)) {
      const t = await deps.fetch.timeline(issue);
      if (t.ok === false) return { status: "skipped" };
      timeline = t.value;
    }
    let trailerRounds: number | null = null;
    let deepQaFails: number | null = null;
    if (pr !== null) {
      const bodies = await deps.fetch.prBodies(pr);
      if (bodies.ok === false) {
        // INV-12: never park on a degraded read. The qa-verdict gate already refuses a qa-fail bounce on this failure.
        logger.warn({ issue, pr, attempt: attempt.kind }, "[lifecycle] PR bodies unreadable; cap check skipped for this call");
        return { status: "skipped" };
      }
      trailerRounds = countReviewedFailRoundsAfterReset(bodies.value, pr, resetMs);
      deepQaFails = countDeepQaFailsAfterReset(bodies.value, resetMs);
    }
    const evaluation = evaluateCaps({
      attempt,
      entries,
      journalFailed,
      resetMs,
      timeline,
      trailerRounds,
      deepQaFails,
      limits: resolved.limits,
    });
    return { status: "checked", evaluation };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] cap check crashed; skipping");
    return { status: "skipped" };
  }
}

/** Stamps cap evidence onto the FIRST journal entry of a call (skip marker or timeline seed). */
class CapStamp {
  private done = false;
  private check: CapCheck | null;
  constructor(check: CapCheck | null) {
    this.check = check;
  }
  /** The cap evidence to add to `e` (once per call); {} afterwards or when nothing applies. */
  extra(e: LifecycleJournalEntry): Record<string, string> {
    if (this.done || this.check === null) return {};
    this.done = true;
    if (this.check.status === "skipped") return { "cap-check": "skipped:fetch-failed" };
    const tl = this.check.evaluation.timelineCounts;
    return tl === null ? {} : buildSeedEvidence(tl, e);
  }
  apply(e: LifecycleJournalEntry): LifecycleJournalEntry {
    const extra = this.extra(e);
    return Object.keys(extra).length === 0 ? e : { ...e, evidence: { ...e.evidence, ...extra } };
  }
}

/** A throwaway entry shaped like the cap-exit transition, used only to compute seed contributions. */
function parkEntryProbe(deps: SeamDeps, over: NonNullable<CapEvaluation["over"]>): LifecycleJournalEntry {
  return {
    v: 1, ts: deps.now(), kind: "transition", from: null, to: capExitOf(over.arm) === "escalate" ? "ready-for-human" : "parked", source: "cli", actor: "cli",
    evidence: {}, reason: `cap:${over.arm}`, rationale: null, result: `parked:${over.arm}`, written: true,
  };
}

export function shadowParkEntry(
  deps: SeamDeps,
  over: NonNullable<CapEvaluation["over"]>,
  from: string | null,
  pr: number | null,
  actor: string,
): LifecycleJournalEntry {
  return {
    v: 1,
    ts: deps.now(),
    kind: "refused",
    from,
    to: "parked",
    source: "cli",
    actor,
    evidence: {
      arm: over.arm,
      count: String(over.count),
      limit: String(over.limit),
      source: over.source,
      ...(pr !== null ? { pr: String(pr) } : {}),
    },
    reason: `cap:${over.arm}`,
    rationale: null,
    result: `shadow-would-park:${over.arm}`,
    written: false,
  };
}

type CapOver = NonNullable<CapEvaluation["over"]>;

interface CapGuardAttempt {
  issue: number;
  /** The single re-read state label, or null when none / ambiguous. */
  from: string | null;
  /** The attempt to count; null skips the check (bookkeeping, or the issue view failed). */
  attempt: CapAttempt | null;
  pr: number | null;
  actor: string | undefined;
}

type CapGuard =
  | {
      /** The cap exit landed (a park or an escalation); `code` is `parked:<arm>` or `escalated:<arm>`. */
      parked: { code: CapExitCode; written: boolean; counts: readonly CapCount[] };
      stamp?: undefined;
      shadowOver?: undefined;
    }
  | { parked: null; stamp: CapStamp; shadowOver: CapOver | null };

/**
 * The ONE cap step (ADR-0047 D6/D7). Checks the caps for `attempt`, then:
 *  - enforce, over cap: park (`parkForCap`);
 *  - shadow, over a LIVE arm (`liveInShadow`): park exactly as in enforce, the park
 *    entry tagged `mode=shadow live=1` so the would-park triage can exclude it;
 *  - shadow, over a non-live arm: no park; the caller journals `would-park`.
 * A skipped check (fetch failure, INV-12) never parks.
 */
export async function guardCaps(a: CapGuardAttempt, deps: SeamDeps, mode: LifecycleMode): Promise<CapGuard> {
  const check: CapCheck =
    a.attempt === null ? { status: "skipped" } : await checkCaps(deps, a.issue, a.attempt, a.pr);
  const stamp = new CapStamp(check);
  const over = check.status === "checked" ? check.evaluation.over : null;
  if (check.status !== "checked" || over === null) return { parked: null, stamp, shadowOver: null };
  const live = mode !== "enforce" && isLiveArm(over.arm);
  if (mode === "enforce" || live) {
    const park = await parkForCap(
      {
        issue: a.issue,
        from: a.from,
        over,
        counts: check.evaluation.counts,
        pr: a.pr,
        actor: a.actor,
        evidence: { ...stamp.extra(parkEntryProbe(deps, over)), ...(live ? { mode: "shadow", live: "1" } : {}) },
      },
      deps,
    );
    return {
      parked: {
        code: capExitOf(over.arm) === "escalate" ? `escalated:${over.arm}` : `parked:${over.arm}`,
        written: park.written,
        counts: check.evaluation.counts,
      },
    };
  }
  return { parked: null, stamp, shadowOver: over };
}

/** The cap attempt an edge's `cap` field implies for this call, or null when it does not count. */
function capAttemptForEdge(
  cap: CapEdge,
  evidence: Record<string, string>,
): { attempt: CapAttempt; pr: number | null } | null {
  if (cap === "requeue") return { attempt: { kind: "requeue" }, pr: null };
  if (evidence.defer === "1") return null;
  const pr = parsePrEvidence(evidence);
  return pr !== null && pr > 0 ? { attempt: { kind: "qa-fail", pr }, pr } : null;
}

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

export interface AdvanceInput {
  issue: number;
  to: string;
  evidence?: Record<string, string>;
  reason?: string;
  rationale?: string;
  /** `completed` (default) or `not planned`, when `to === "closed"`. */
  closeReason?: string;
  actor?: string;
  /**
   * Optional compare-and-set precondition (#5318 INV-5): when given and the
   * re-read single state label differs (or is absent/ambiguous), `advance`
   * refuses `from-mismatch` BEFORE any write, in BOTH modes. A stale caller
   * premise (a snapshot-driven writer) is not a gate the shadow switch may bypass.
   */
  from?: string;
}

export type AdvanceResult =
  | {
      ok: true;
      issue: number;
      from: string | null;
      to: LifecycleState;
      mode: LifecycleMode;
      /** Set in shadow when the transition would have been refused in enforce. */
      wouldRefuse?: string;
      /** The seam's own post-write re-read (no extra gh read for callers). */
      observed: { state: string; labels: string[] };
      /** Set in shadow when a cap check would have parked the issue in enforce. */
      wouldPark?: string;
      /** Set when the issue already sat in `to`: nothing was written (#5584 INV-1). */
      noop?: true;
    }
  | {
      ok: false;
      issue: number;
      code: string;
      mode: LifecycleMode | null;
      written: boolean;
      /** A `parked:<arm>` or `escalated:<arm>` refusal carries the arm counts `parkForCap` rendered, so every caller sees why. */
      counts?: readonly CapCount[];
    };

export function entry(
  deps: SeamDeps,
  over: Partial<LifecycleJournalEntry> & Pick<LifecycleJournalEntry, "kind" | "result" | "written">,
  input: Pick<AdvanceInput, "to" | "evidence" | "reason" | "rationale" | "actor">,
  source: JournalSource = "cli",
): LifecycleJournalEntry {
  return {
    v: 1,
    ts: deps.now(),
    from: null,
    to: input.to,
    source,
    actor: input.actor ?? "cli",
    evidence: input.evidence ?? {},
    reason: input.reason ?? null,
    rationale: input.rationale ?? null,
    ...over,
  };
}

/**
 * The seam's ONE journal append point (also used by the #5316 reconcile to
 * append `external` entries). After a successful append, an unsanctioned
 * human-hold exit is also indexed for the attention feed (#5313).
 */
export async function journalEntry(deps: SeamDeps, issue: number, e: LifecycleJournalEntry): Promise<void> {
  const res = await deps.journal.append(deps.repo, issue, e, { holdExit: isUnsanctionedHoldExit(e) });
  if (res.ok === false) {
    logger.error({ issue, error: res.error }, "[lifecycle] journal append failed");
  }
}

/** `not-planned` (artifact / reasons spelling) and `not planned` (gh spelling) are one reason. */
export function normaliseCloseReason(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : raw.trim().toLowerCase().replace(/[-_]+/g, " ");
}

export async function advance(input: AdvanceInput, deps: SeamDeps): Promise<AdvanceResult> {
  const issue = input.issue;
  if (!isLifecycleState(input.to)) {
    return { ok: false, issue, code: "unknown-target-state", mode: null, written: false };
  }
  const to: LifecycleState = input.to;
  const closeReason = normaliseCloseReason(input.closeReason);
  const mode = await deps.mode();
  let stamp = new CapStamp(null);
  const gateEvidence = input.evidence ?? {};
  const jr = async (e: LifecycleJournalEntry): Promise<void> => journalEntry(deps, issue, stamp.apply(e));

  // 1. re-read
  const before = await deps.view(issue);
  if (before.ok === false) {
    await jr(entry(deps, { kind: "refused", result: "refused:fetch-failed", written: false }, input));
    return { ok: false, issue, code: "fetch-failed", mode, written: false };
  }

  // 1a. a PR number re-reads as an issue row: refuse before any write or journal append (#5584 INV-4).
  if (isPullRequestUrl(before.row.url)) {
    logger.warn({ issue }, "[lifecycle] advance refused: not an issue (pull request)");
    return { ok: false, issue, code: "not-an-issue", mode, written: false };
  }

  // 2. derive state
  const isClosed = before.row.state === "CLOSED";
  const stateLabels = stateLabelsOf(before.row.labels);
  const flags = before.row.labels.filter((l) => !(stateLabels as string[]).includes(l));
  const from: string | null = isClosed
    ? "closed"
    : stateLabels.length === 1
      ? stateLabels[0]
      : null;

  // 2a. idempotent self-move: the issue already sits in `to`. Nothing to gate or write, in BOTH
  //     modes; a `--from` that disagrees still refuses below, and a self-move is not a hold exit
  //     (#5584 INV-1/INV-2). A seam rule, not a table edge (INV-3).
  if (!isClosed && stateLabels.length === 1 && from === to && (input.from === undefined || input.from === from)) {
    await jr(entry(deps, { kind: "transition", from, result: "noop", written: false }, input));
    return { ok: true, issue, from, to, mode, noop: true, observed: observedOf(before) };
  }

  // 3. human-hold exit: refused in BOTH modes, before the mode branch.
  if (!isClosed && stateLabels.some((s) => isHumanHold(s))) {
    await jr(
      entry(deps, { kind: "refused", from: stateLabels.join(","), result: "refused:human-hold-exit", written: false }, input),
    );
    return { ok: false, issue, code: "human-hold-exit", mode, written: false };
  }
  // A closed issue has nothing to advance: refused in both modes.
  if (isClosed) {
    await jr(entry(deps, { kind: "refused", from, result: "refused:issue-closed", written: false }, input));
    return { ok: false, issue, code: "issue-closed", mode, written: false };
  }

  // 3a. caller premise (--from): refused in both modes, before any write (#5318 INV-5).
  if (input.from !== undefined && from !== input.from) {
    await jr(
      entry(
        deps,
        { kind: "refused", from: stateLabels.length === 0 ? null : stateLabels.join(","), result: "refused:from-mismatch", written: false },
        input,
      ),
    );
    return { ok: false, issue, code: "from-mismatch", mode, written: false };
  }

  // 3b. legality lookup comes BEFORE the cap step, so an illegal move refuses
  //     instead of being able to park (ADR-0047 D6).
  const transition = from === null ? undefined : findTransition(from as LifecycleState, to);

  // 3c. cap step: an edge carrying `cap` runs the ONE guardCaps step; over cap it parks
  //     INSTEAD of writing the move (enforce, or a live arm in shadow).
  let shadowOver: CapOver | null = null;
  let shadowOverPr: number | null = null;
  if (stateLabels.length === 1 && transition?.cap !== undefined) {
    const edge = capAttemptForEdge(transition.cap, gateEvidence);
    if (edge !== null) {
      const guard = await guardCaps({ issue, from, attempt: edge.attempt, pr: edge.pr, actor: input.actor }, deps, mode);
      if (guard.parked !== null) {
        return { ok: false, issue, code: guard.parked.code, mode, written: guard.parked.written, counts: guard.parked.counts };
      }
      stamp = guard.stamp;
      shadowOver = guard.shadowOver;
      shadowOverPr = edge.pr;
    }
  }

  // 4. verdict. `none` (zero state labels) may only enter needs-triage, gate-free;
  //    every other move refuses `state-missing`. `many` refuses `state-ambiguous`.
  let verdict: { ok: boolean; code: string };
  if (stateLabels.length === 0) {
    verdict = to === "needs-triage" ? { ok: true, code: "ok" } : { ok: false, code: "state-missing" };
  } else if (stateLabels.length > 1) {
    verdict = { ok: false, code: "state-ambiguous" };
  } else if (transition === undefined) {
    verdict = { ok: false, code: "illegal-transition" };
  } else {
    // 5. fetch records via injected fetchers, then the pure gate.
    const needs = recordsNeeded(transition.gate);
    const records: GateRecords = {};
    if (needs.designConcept) records.designConcept = await deps.fetch.designConcept(issue);
    if (needs.pr) {
      const prNumber = parsePrEvidence(gateEvidence);
      records.pr = prNumber !== null && prNumber > 0 ? await deps.fetch.pr(prNumber) : undefined;
    }
    if (needs.comment) {
      const commentId = parseCommentEvidence(gateEvidence);
      records.comment = commentId !== null ? await deps.fetch.comment(commentId) : undefined;
    }
    if (needs.qaLive) {
      const prNumber = parsePrEvidence(gateEvidence);
      records.qaLive =
        prNumber !== null && prNumber > 0 && deps.fetch.qaLive !== undefined
          ? await deps.fetch.qaLive(prNumber)
          : { ok: false };
    }
    if (needs.claim) {
      const c = await deps.journal.readClaim(deps.repo, issue);
      records.claim = c.ok === true ? { ok: true, value: { held: c.claim ? { dispatchId: c.claim.dispatchId } : null } } : { ok: false };
    }
    if (needs.blockers) {
      const refs = extractClearanceBlockerRefs(before.row.body, issue);
      records.blockers = deps.fetch.blockers !== undefined ? await deps.fetch.blockers(refs) : { ok: false };
    }
    if (needs.stateEntry) {
      records.stateEntry = await deps.fetch.stateEntry(issue, transition.from);
      // Entry-time miss: fall back to the entry derived from the issue timeline,
      // as the cap arms do, instead of hard-failing `state-entry-unknown`.
      if (records.stateEntry.ok === true && records.stateEntry.value.enteredAtMs === null) {
        const tl = await deps.fetch.timeline(issue);
        if (tl.ok === true) {
          const ts = tl.value.filter((e) => e.event === "labeled" && e.label === transition.from).map((e) => e.tsMs);
          if (ts.length > 0) records.stateEntry = { ok: true, value: { enteredAtMs: Math.max(...ts) } };
        }
      }
    }
    const gateInput: GateInput = {
      issue,
      repo: deps.repo,
      body: before.row.body,
      from: transition.from,
      to,
      flags,
      evidence: gateEvidence,
      reason: input.reason,
      rationale: input.rationale,
      closeReason: to === "closed" ? (closeReason ?? "completed") : undefined,
      actor: input.actor,
    };
    verdict = evaluateGate(transition.gate, gateInput, records);
  }

  // 6. mode branch
  if (!verdict.ok && mode === "enforce") {
    await jr(entry(deps, { kind: "refused", from, result: `refused:${verdict.code}`, written: false }, input));
    return { ok: false, issue, code: verdict.code, mode, written: false };
  }

  // 7. ONE gh write
  const removed = stateLabels.filter((s) => s !== to);
  const write =
    to === "closed"
      ? await deps.close(issue, closeReason ?? "completed")
      : await deps.edit(issue, { remove: [...removed], add: [to] });
  if (write.ok === false) {
    const code = `write-failed:${write.code}`;
    await jr(entry(deps, { kind: "refused", from, result: code, written: false }, input));
    return { ok: false, issue, code, mode, written: false };
  }

  // 8. re-read verify
  const after = await deps.view(issue);
  const verified =
    after.ok &&
    (to === "closed"
      ? after.row.state === "CLOSED"
      : after.row.labels.includes(to) && removed.every((s) => !after.row.labels.includes(s)));
  if (!verified) {
    await jr(entry(deps, { kind: "refused", from, result: "write-unverified", written: true }, input));
    return { ok: false, issue, code: "write-unverified", mode, written: true };
  }

  // 9. journal (after verify, so `result` reflects what GitHub shows)
  if (verdict.ok) {
    await jr(entry(deps, { kind: "transition", from, result: "ok", written: true }, input));
  } else {
    await jr(
      entry(deps, { kind: "refused", from, result: `shadow-would-refuse:${verdict.code}`, written: true }, input),
    );
  }
  if (shadowOver !== null) await jr(shadowParkEntry(deps, shadowOver, from, shadowOverPr, input.actor ?? "cli"));
  if (to === "closed") {
    const exp = await deps.journal.expireOnClose(deps.repo, issue);
    if (exp.ok === false) logger.error({ issue, error: exp.error }, "[lifecycle] journal expire failed");
  }
  return {
    ok: true,
    issue,
    from,
    to,
    mode,
    ...(verdict.ok ? {} : { wouldRefuse: verdict.code }),
    observed: observedOf(after),
    ...(shadowOver !== null ? { wouldPark: shadowOver.arm } : {}),
  };
}

export function observedOf(after: IssueViewResult): { state: string; labels: string[] } {
  return after.ok ? { state: after.row.state, labels: [...after.row.labels] } : { state: "", labels: [] };
}

