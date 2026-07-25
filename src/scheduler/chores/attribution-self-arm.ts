/**
 * Attribution self-arm leaf (issue #3078, extracted from cycle-merge-reconcile
 * in #3639).
 *
 * **What this owns.** The *policy* for recovering a dropped pending-enroll arm:
 * given a confirmed-merged PR that the cycle-merge-reconcile backstop already
 * verified via `gh pr view`, decide whether that PR is eligible to be armed into
 * `hydra:holdback:pending-enroll` (the Outcome Attribution Spine ledger's ingress,
 * #2622/#2628) and — if so — arm it via `pendingEnrollAdd`.
 *
 * **Why it lives here, not in the cycle-hash enrichment chore.** The enrichment
 * chore's conceptual home is the metrics domain: scan `completed` cycle records,
 * confirm the PR merged, re-post through `recordCycle` to bump `tasksMerged`. The
 * self-arm concern is a *cross-domain write into the attribution module* that the
 * chore performed "for free" because it already had the `gh pr view` → MERGED
 * signal the arming step needed. Co-locating the arm policy (eligibility check +
 * enrolled-check + sentinel-omission + arm-entry shape) in this leaf keeps that
 * attribution knowledge in one named unit: reading `runCycleMergeReconcile`
 * answers "when does a cycle hash get upgraded?"; reading THIS file answers "when
 * does an unregistered merged PR get armed?".
 *
 * **The contract this preserves verbatim (issue #3078, invariants #3639).**
 * - Eligible ⇔ confirmed-merged AND not-in-registry AND not-enrolled-marked.
 * - Never filters by tier — the T1/unknown-tier carry-up exemption stays enforced
 *   server-side in `enrollHoldback` (which the merge-watch chore calls), not here.
 *   Arm entries carry `tier: null`.
 * - Never-throws / best-effort: a Redis error for one PR is caught and reported as
 *   a `failed` outcome; it never aborts the caller's enrichment upgrade.
 * - Enrolled-check fails closed: an error from `wasEnrolled` is treated as
 *   already-enrolled (skip the arm) so an unknown state never double-arms.
 * - Sentinel anchorType is OMITTED, not forwarded: a stored `unclassified` /
 *   `unknown` / empty anchorType is dropped from the arm entry so the merge-watch
 *   enrichment re-decodes the class from the fenced head branch rather than baking
 *   the sentinel in (#3579/#3604 never-guess).
 * - Arm-blind avoidance stays in the CALLER: the once-per-tick pending-enroll LIST
 *   snapshot (and its "list failed ⇒ null ⇒ self-arm disabled for the tick")
 *   decision belongs to the coordinator, which owns the tick lifecycle. This leaf
 *   is called only with a non-null snapshot, one confirmed-merged PR at a time.
 * - Same-tick double-arm guard: the caller passes the tick-local `pendingSet`;
 *   this leaf mutates it (`pendingSet.add`) on a successful arm so a second merged
 *   cycle sharing the prNumber in the same tick is skipped.
 */

import { UNCLASSIFIED_ANCHOR_TYPE } from "../../autopilot/anchor-type.ts";
import {
  pendingEnrollAdd,
  wasEnrolledMarked,
  type PendingEnrollEntry,
  type PendingEnrollAddResult,
} from "../../redis/holdback-merge-watch.ts";
import { logger } from "../../logger.ts";

/**
 * Is a trimmed stored anchorType a data-quality SENTINEL rather than a genuine
 * class (issue #3604)? A sentinel (`unclassified`, the aggregator's catch-all
 * `unknown`, or an empty value) must NOT be forwarded verbatim onto a
 * pending-enroll entry — doing so would make the merge-watch enrichment bake the
 * sentinel in and defeat its head-branch decode + heal. A genuine class returns
 * false and IS forwarded (it is authoritative).
 *
 * Exported so the cycle-hash enrichment path in `cycle-merge-reconcile.ts` (which
 * makes the same sentinel-vs-genuine decision on its `recordCycle` re-post) shares
 * the single definition rather than duplicating it.
 */
export function isSentinelReconcileAnchorType(trimmed: string): boolean {
  const t = trimmed.toLowerCase();
  return t.length === 0 || t === UNCLASSIFIED_ANCHOR_TYPE || t === "unknown";
}

/** External touchpoints the self-arm leaf needs (all injectable for tests). */
export interface AttributionSelfArmDeps {
  /** True when this PR's landing was already enroll-processed. Defaults to `wasEnrolledMarked`. */
  wasEnrolled?: (prNumber: number) => Promise<boolean>;
  /** Arm a confirmed-merged-but-unregistered PR into the registry. Defaults to `pendingEnrollAdd`. */
  armPending?: (entry: PendingEnrollEntry) => Promise<PendingEnrollAddResult>;
}

/** The immutable facts about the confirmed-merged candidate the caller passes in. */
export interface SelfArmCandidate {
  /** The confirmed-merged PR number. */
  prNumber: number;
  /** The cycle record's id (carried onto the arm entry + logs). */
  cycleId: string;
  /**
   * The raw `anchorType` read off the cycle-metrics hash (may be undefined, blank,
   * a sentinel, or a genuine class). The leaf trims + sentinel-filters it.
   */
  hashAnchorType?: string;
}

/**
 * The outcome of one self-arm attempt, mapped by the caller onto its
 * `selfArmed` / `selfArmSkipped` / `selfArmFailed` counters.
 * - `armed`   — a new pendingEnrollAdd succeeded.
 * - `skipped` — the PR was already registered or already enrolled-marked.
 * - `failed`  — the pendingEnrollAdd returned/threw non-ok (retried next tick).
 */
export type SelfArmOutcome = "armed" | "skipped" | "failed";

/**
 * Decide + perform the self-arm for ONE confirmed-merged PR.
 *
 * Preconditions the caller guarantees (they belong to the tick lifecycle, not the
 * per-PR policy): the PR's merge is already confirmed, and `pendingSet` is a
 * non-null once-per-tick snapshot (a null snapshot means the tick disabled
 * self-arm — the caller must not invoke this leaf at all in that case).
 *
 * Mutates `pendingSet` on a successful arm so a same-tick second cycle sharing the
 * prNumber is skipped. Never throws.
 */
export async function selfArmConfirmedMergedPr(
  candidate: SelfArmCandidate,
  pendingSet: Set<number>,
  deps: AttributionSelfArmDeps = {},
): Promise<SelfArmOutcome> {
  const wasEnrolled = deps.wasEnrolled ?? wasEnrolledMarked;
  const armPending = deps.armPending ?? pendingEnrollAdd;
  const { prNumber, cycleId } = candidate;

  // Already in the registry — the merge-watch will enroll it; nothing to do.
  if (pendingSet.has(prNumber)) return "skipped";

  let enrolledAlready = false;
  try {
    enrolledAlready = await wasEnrolled(prNumber);
  } catch (err: any) {
    // wasEnrolledMarked itself never throws (it fails closed to true), but an
    // injected dep might — fail closed to "already enrolled" so we never
    // double-arm on an unknown state.
    logger.error(
      { prNumber, cycleId, err },
      "attribution-self-arm: enrolled-check failed; skipping arm",
    );
    enrolledAlready = true;
  }
  if (enrolledAlready) return "skipped";

  // Issue #3579: forward the anchorType read off the metrics hash — do NOT
  // hardcode `work-queue`. A wrong lane baked onto the pending entry becomes the
  // record's permanent classification when merge-watch later forwards
  // `entry.anchorType` onto the FIRST cycle-record write for an un-joinable
  // bare-UUID cycleId. DEGRADE-TRUTHFULLY: a blank/whitespace value OR a stored
  // SENTINEL (`unclassified`/`unknown`, #3604) is OMITTED so the entry inherits
  // the merge-watch enrichment's head-branch decode → an honest `unclassified`
  // beats a confidently-wrong `work-queue` (NEVER-GUESS, #2822).
  const trimmedAnchorType = (candidate.hashAnchorType || "").trim();
  const genuineArmAnchorType = isSentinelReconcileAnchorType(trimmedAnchorType)
    ? ""
    : trimmedAnchorType;
  const armEntry: PendingEnrollEntry = {
    prNumber,
    // Tier is unknown from the cycle-metrics hash here; null is the permissive
    // "unknown-tier" the enroll schema accepts. enrollHoldback resolves the real
    // tier server-side at landing time.
    tier: null,
    cycleId,
    registeredAt: Date.now(),
  };
  if (genuineArmAnchorType) armEntry.anchorType = genuineArmAnchorType;

  let armed: PendingEnrollAddResult;
  try {
    armed = await armPending(armEntry);
  } catch (err: any) {
    armed = { ok: false, error: err?.message || String(err) };
  }
  if (armed.ok === false) {
    logger.error(
      { prNumber, cycleId, err: { message: armed.error } },
      "attribution-self-arm: pendingEnrollAdd failed; retrying next tick",
    );
    return "failed";
  }

  // Keep the local snapshot consistent so a second merged cycle sharing this
  // prNumber in the same tick isn't double-armed.
  pendingSet.add(prNumber);
  return "armed";
}
