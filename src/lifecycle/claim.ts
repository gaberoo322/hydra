/**
 * Dispatch claims and the composite `dispatch` verb (ADR-0047 Decisions 5, 7;
 * issues #5315 and #5618).
 *
 * The claim lifecycle (`openClaim`, `releaseClaim`, `releaseClaimByDispatch`) is
 * a separate SET NX key with its own journal entry kinds; split out of `seam.ts`
 * so the transition spine stays the deep core. Claims reuse the spine's cap guard
 * and journal append point.
 */
import { logger } from "../logger.ts";
import { CLAIM_OWNER_MISMATCH, type DispatchClaim, type LifecycleJournalEntry } from "../redis/lifecycle-journal.ts";
import { classRole } from "./caps.ts";
import { advance, guardCaps, journalEntry as journal, shadowParkEntry, type AdvanceResult } from "./seam.ts";
import type { SeamDeps } from "./seam-deps.ts";
import { stateLabelsOf } from "./transitions.ts";
// ---------------------------------------------------------------------------
// claim / release (change no label, except a cap park)
// ---------------------------------------------------------------------------

/** Class of the placeholder claims written by `scripts/lifecycle-legacy-backfill.ts`. */
export const LEGACY_BACKFILL_CLASS = "legacy-backfill";

export type ClaimPurpose = "fresh" | "resume" | "forward-fix";
export const CLAIM_PURPOSES: readonly ClaimPurpose[] = ["fresh", "resume", "forward-fix"];

/** Closed enum a claim is released with (ADR-0047 D5/D6). */
export const CLAIM_OUTCOMES = ["pr-opened", "no-pr", "verdict-posted", "stall", "released", "stale"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

export interface ClaimInput {
  issue: number;
  dispatchId: string;
  class: string;
  run: string;
  artifactHash?: string | null;
  actor?: string;
  /** The PR this dispatch works on (QA / forward-fix); arms the PR-unit caps. */
  pr?: number;
  purpose?: ClaimPurpose;
  /**
   * Skip the cap check (INV-9). In-process only: the legacy backfill passes it so a
   * bookkeeping placeholder can never park an issue. Deliberately NOT keyed on `class`
   * and NOT exposed by the CLI verbs, so a caller-supplied class string cannot bypass caps.
   */
  skipCaps?: boolean;
}

export type ClaimResult =
  | {
      ok: true;
      claim: DispatchClaim;
      /** Set in shadow when the cap check would have parked this claim in enforce. */
      wouldPark?: string;
    }
  | { ok: false; code: "claim-held" | "redis-failed"; existing?: DispatchClaim | null }
  | { ok: false; code: `parked:${string}`; written: boolean };

function claimEntry(
  deps: SeamDeps,
  kind: "claim-opened" | "claim-closed",
  actor: string,
  evidence: Record<string, string>,
): LifecycleJournalEntry {
  return {
    v: 1,
    ts: deps.now(),
    kind,
    from: null,
    to: null,
    source: "cli",
    actor,
    evidence,
    reason: null,
    rationale: null,
    result: "ok",
    written: true,
  };
}

export async function openClaim(input: ClaimInput, deps: SeamDeps): Promise<ClaimResult> {
  const issue = input.issue;
  const actor = input.actor ?? "cli";
  const claim: DispatchClaim = {
    dispatchId: input.dispatchId,
    class: input.class,
    run: input.run,
    artifactHash: input.artifactHash ?? null,
    openedAt: deps.now(),
    ...(input.pr != null ? { pr: input.pr } : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
  };

  // INV-10: the claim-held check runs BEFORE any counting or park.
  // Sole exception (INV-7): a `legacy-backfill` placeholder is released by its own
  // dispatchId so the real dispatch can take over in the same call.
  let held = await deps.journal.readClaim(deps.repo, issue);
  if (held.ok && held.claim && held.claim.class === LEGACY_BACKFILL_CLASS) {
    const takeover = await releaseClaim(issue, held.claim.dispatchId, deps, actor, "released");
    if (takeover.ok) held = { ok: true, claim: null };
  }
  if (held.ok && held.claim) return { ok: false, code: "claim-held", existing: held.claim };

  // Re-read the issue to stamp `state` (INV-13). A failed read skips the cap check (INV-12).
  const mode = await deps.mode();
  const view = await deps.view(issue);
  let state = "unknown";
  let capState = "";
  if (view.ok) {
    const labels = stateLabelsOf(view.row.labels);
    state = labels.length === 1 ? labels[0] : "none";
    capState = labels.length === 1 ? labels[0] : "";
  }
  // INV-9: a legacy-backfill placeholder is bookkeeping, never a dispatch attempt: no cap
  // check, so it can never park (write a label) an over-cap in-progress issue.
  const guard = await guardCaps(
    {
      issue,
      from: capState === "" ? null : capState,
      attempt:
        view.ok && input.skipCaps !== true
          ? { kind: "claim", class: input.class, state: capState, pr: input.pr ?? null, purpose: input.purpose ?? null }
          : null,
      pr: input.pr ?? null,
      actor,
    },
    deps,
    mode,
  );
  if (guard.parked !== null) return { ok: false, code: guard.parked.code, written: guard.parked.written };
  const { stamp, shadowOver } = guard;

  const res = await deps.journal.openClaim(deps.repo, issue, claim);
  if (res.ok === false) {
    return res.code === "claim-held"
      ? { ok: false, code: "claim-held", existing: res.existing }
      : { ok: false, code: "redis-failed" };
  }
  await journal(
    deps,
    issue,
    stamp.apply(
      claimEntry(deps, "claim-opened", actor, {
        dispatch: input.dispatchId,
        class: input.class,
        run: input.run,
        state,
        ...(input.pr !== undefined ? { pr: String(input.pr) } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      }),
    ),
  );
  if (shadowOver !== null) {
    await journal(deps, issue, shadowParkEntry(deps, shadowOver, capState === "" ? null : capState, input.pr ?? null, actor));
    return { ok: true, claim, wouldPark: shadowOver.arm };
  }
  return { ok: true, claim };
}

/**
 * Release a dispatch claim. `dispatchId` is REQUIRED: every release goes through
 * the atomic compare-and-delete ownership check (INV-11), so a release can never
 * delete a claim another dispatch holds. There is deliberately no force path.
 * The optional `outcome` is recorded on the claim-closed entry for the cap arms.
 */
export async function releaseClaim(
  issue: number,
  dispatchId: string,
  deps: SeamDeps,
  actor = "cli",
  outcome?: ClaimOutcome,
): Promise<{ ok: true; prior: DispatchClaim | null } | { ok: false; code: "redis-failed" | "claim-owner-mismatch" }> {
  const res = await deps.journal.closeClaim(deps.repo, issue, dispatchId);
  if (res.ok === false) {
    return { ok: false, code: res.error === CLAIM_OWNER_MISMATCH ? "claim-owner-mismatch" : "redis-failed" };
  }
  await journal(
    deps,
    issue,
    claimEntry(deps, "claim-closed", actor, {
      ...(res.prior ? { dispatch: res.prior.dispatchId, class: res.prior.class } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    }),
  );
  return { ok: true, prior: res.prior };
}

export type ReleaseByDispatchResult =
  | { ok: true; prior: DispatchClaim | null; issue: number | null }
  | { ok: false; code: "redis-failed" | "claim-owner-mismatch" | "claim-ambiguous" };

/**
 * Release the claim whose `dispatchId` matches, without knowing its issue (SCAN
 * over claim keys; no reverse index). Zero matches is idempotent: `prior: null`,
 * no journal entry. The close itself is the same compare-and-delete as
 * {@link releaseClaim}, so a claim re-opened under another id in between is
 * never deleted. Never throws.
 */
export async function releaseClaimByDispatch(
  dispatchId: string,
  deps: SeamDeps,
  actor = "cli",
  outcome?: ClaimOutcome,
): Promise<ReleaseByDispatchResult> {
  try {
    return await scanAndRelease(dispatchId, deps, actor, outcome);
  } catch (err) {
    logger.error({ err, dispatchId }, "[lifecycle] release-by-dispatch crashed");
    return { ok: false, code: "redis-failed" };
  }
}

/** The SCAN-then-close body of {@link releaseClaimByDispatch}; the public wrapper turns a throw into `redis-failed`. */
async function scanAndRelease(
  dispatchId: string,
  deps: SeamDeps,
  actor: string,
  outcome: ClaimOutcome | undefined,
): Promise<ReleaseByDispatchResult> {
  if (dispatchId === "" || !deps.journal.listClaims) return { ok: false, code: "redis-failed" };
  const listed = await deps.journal.listClaims(deps.repo);
  if (listed.ok === false) return { ok: false, code: "redis-failed" };
  const matches = listed.claims.filter((c) => c.claim.dispatchId === dispatchId);
  if (matches.length === 0) return { ok: true, prior: null, issue: null };
  if (matches.length > 1) {
    logger.error({ dispatchId, issues: matches.map((m) => m.issue) }, "[lifecycle] ambiguous dispatch id");
    return { ok: false, code: "claim-ambiguous" };
  }
  const res = await releaseClaim(matches[0].issue, dispatchId, deps, actor, outcome);
  return res.ok === true ? { ok: true, prior: res.prior, issue: matches[0].issue } : res;
}

// ---------------------------------------------------------------------------
// composite dispatch verb (ADR-0047 D5/D7, issue #5315)
// ---------------------------------------------------------------------------

export interface DispatchInput {
  issue: number;
  dispatchId: string;
  class: string;
  run: string;
  actor?: string;
  pr?: number;
  purpose?: ClaimPurpose;
}

export type DispatchResult =
  | {
      ok: true;
      claim: DispatchClaim;
      /** The `in-progress` advance, or null when none was attempted (non-dev role, other state, failed read). */
      advanced: Extract<AdvanceResult, { ok: true }> | null;
      /** Set in shadow when the advance would have been refused in enforce. */
      wouldRefuse?: string;
      wouldPark?: string;
    }
  | { ok: false; code: "claim-held" | "redis-failed"; existing?: DispatchClaim | null }
  | { ok: false; code: `parked:${string}`; written: boolean }
  | { ok: false; code: "advance-refused"; reason: string; released: boolean };

/**
 * Fetch the Design Concept, open the claim (copying the artifact hash only when
 * the artifact is `approved`), then advance dev-role dispatches to `in-progress`.
 * A refused advance in enforce releases the claim BEFORE the refusal is returned.
 * Callers never supply the hash. Never throws.
 */
export async function dispatch(input: DispatchInput, deps: SeamDeps): Promise<DispatchResult> {
  try {
    return await claimThenAdvance(input, deps);
  } catch (err) {
    logger.error({ err, issue: input.issue }, "[lifecycle] dispatch crashed");
    // A throw after openClaim succeeded would leave the no-TTL claim open and
    // every retry would answer `claim-held`; release best-effort (no-op if none).
    try {
      await releaseClaim(input.issue, input.dispatchId, deps, input.actor ?? "cli", "released");
    } catch (relErr) {
      logger.error({ err: relErr, issue: input.issue }, "[lifecycle] dispatch crash cleanup release failed");
    }
    return { ok: false, code: "redis-failed" };
  }
}

/** The fetch / claim / advance body of {@link dispatch}; the public wrapper turns a throw into `redis-failed`. */
async function claimThenAdvance(input: DispatchInput, deps: SeamDeps): Promise<DispatchResult> {
  const { issue } = input;
  const actor = input.actor ?? "cli";

  const dc = await deps.fetch.designConcept(issue);
  const artifactHash =
    dc.ok && dc.value.exists && dc.value.status === "approved" ? (dc.value.artifactHash ?? null) : null;

  const claimed = await openClaim(
    {
      issue,
      dispatchId: input.dispatchId,
      class: input.class,
      run: input.run,
      artifactHash,
      actor,
      pr: input.pr,
      purpose: input.purpose,
    },
    deps,
  );
  if (claimed.ok === false) return claimed;
  const base = { claim: claimed.claim, ...(claimed.wouldPark !== undefined ? { wouldPark: claimed.wouldPark } : {}) };

  if (classRole(input.class) !== "dev") return { ok: true, ...base, advanced: null };
  const view = await deps.view(issue);
  if (view.ok === false) return { ok: true, ...base, advanced: null };
  const states = stateLabelsOf(view.row.labels);
  if (states.length !== 1 || (states[0] !== "ready-for-agent" && states[0] !== "needs-dev-resume")) {
    return { ok: true, ...base, advanced: null };
  }

  const adv = await advance(
    {
      issue,
      to: "in-progress",
      evidence: { dispatch: input.dispatchId, class: input.class, run: input.run },
      actor,
    },
    deps,
  );
  if (adv.ok === false) {
    const released = await releaseClaim(issue, input.dispatchId, deps, actor, "released");
    return { ok: false, code: "advance-refused", reason: adv.code, released: released.ok };
  }
  return {
    ok: true,
    ...base,
    advanced: adv,
    ...(adv.wouldRefuse !== undefined ? { wouldRefuse: adv.wouldRefuse } : {}),
  };
}
