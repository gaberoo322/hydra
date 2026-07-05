/**
 * Merge-completion watcher chore (issue #2623).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`), registered in
 * `src/scheduler/housekeeping.ts`. It consumes the **pending-enroll registry**
 * (`hydra:holdback:pending-enroll`, seeded by `POST /api/holdback/pending`,
 * issue #2622) — the durable list of PRs the autopilot ARMED for auto-merge but
 * that have not yet landed — and, for each entry whose merge has landed, fires
 * the two merge-coupled follow-ups IN-PROCESS that the autopilot previously did
 * out-of-band:
 *
 *   1. `enrollHoldback({ commitSha, prNumber, tier })` — the server-side
 *      Outcome-Holdback carry-up exemption already lives in `src/holdback.ts`,
 *      so a landed T1/unknown-tier PR is dropped WITHOUT enrolling (enroll
 *      returns `enrolled:false` for it), while T2/T3/T4 snapshot a baseline.
 *   2. The cycle-record **merged-status enrichment** — a follow-up
 *      `recordCycle({ cycleId, prNumber, filesChanged })` post. `recordCycle`
 *      is idempotent on `cycleId`: because reap already filed the record at
 *      `completed`, this duplicate post ENRICHES the existing metrics hash with
 *      `filesChanged` + `prNumber` (issue #2063) WITHOUT re-firing any lifetime
 *      counter.
 *
 * Then it removes the pending entry.
 *
 * **Idempotent (AC3).** Keyed on `commitSha` (`enrollHoldback` is itself
 * idempotent on the SHA) PLUS a per-PR enrolled marker
 * (`hydra:holdback:enrolled-marker`): before firing the two writes the chore
 * checks {@link wasEnrolledMarked}; after they succeed it {@link markEnrolled}s
 * the PR and only THEN removes the pending entry. So even if a prior tick's
 * `pendingEnrollRemove` failed and the entry is re-observed, the marker short-
 * circuits the re-fire.
 *
 * **A still-open pending PR is left untouched (AC2).** No `mergeCommit` yet →
 * the entry stays in the registry for a later tick.
 *
 * **Never throws (AC5).** Per CLAUDE.md the whole chore is best-effort: a
 * `gh`/API failure for one PR is logged and that entry is left in the registry
 * to retry next tick; a failure never aborts the remaining entries. It returns
 * a summary object rather than throwing.
 *
 * **Observable (AC6).** After every run it persists a `{ ranAt, pendingDepth,
 * landed, droppedExempt, stillOpen }` health snapshot to Redis via
 * {@link setMergeWatchHealth} so a stalled watcher is diagnosable.
 */

import {
  pendingEnrollList,
  pendingEnrollRemove,
  wasEnrolledMarked,
  markEnrolled,
  setMergeWatchHealth,
  type PendingEnrollEntry,
  type MergeWatchHealthRecord,
} from "../../redis/holdback.ts";
import { enrollHoldback, type EnrollResult } from "../../holdback.ts";
// `recordCycle` + its `CycleRecordResult` type moved to the sibling
// `cycle-close.ts` in issue #2768 — the call site is unchanged (it passes no
// deps arg and relies on the module default deps); only the import path moves.
import { recordCycle, type CycleRecordResult } from "../../autopilot/cycle-close.ts";
import { isEnrolledTier } from "../../holdback-policy.ts";
import { viewPr } from "../../github/issues.ts";

/**
 * Normalized merge-landing status for one PR. `state` is the `gh pr view` state
 * (`MERGED`/`OPEN`/`CLOSED`); `mergeCommitSha` is the squash-merge commit SHA
 * (present iff the PR landed); `changedFiles` is the integer file-change count
 * (or `null` when the view didn't report one).
 */
export interface MergeStatus {
  state: string | null;
  mergeCommitSha: string | null;
  changedFiles: number | null;
}

/** Raw `gh pr view --json state,mergeCommit,changedFiles` shape. */
interface RawPrView {
  state?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  changedFiles?: number | null;
}

/**
 * Default merge-status fetch: `gh pr view <n> --json state,mergeCommit,changedFiles`.
 *
 * Uses the GraphQL transport because `mergeCommit` / `changedFiles` are NOT on
 * the REST `/pulls/<n>` inline-field map (`view-pr.ts`), so the REST normalizer
 * would silently drop them. This runs only over the (small) pending-registry set
 * at the housekeeping cadence, so the GraphQL-pool cost is negligible. `viewPr`
 * returns `null` on any failure and never throws.
 */
async function fetchMergeStatusViaGh(prNumber: number): Promise<MergeStatus | null> {
  const view = await viewPr<RawPrView>(prNumber, "state,mergeCommit,changedFiles", {
    transport: "graphql",
  });
  if (view == null) return null;
  const oid = view.mergeCommit?.oid;
  return {
    state: typeof view.state === "string" ? view.state : null,
    mergeCommitSha: typeof oid === "string" && oid.length > 0 ? oid : null,
    changedFiles: typeof view.changedFiles === "number" ? view.changedFiles : null,
  };
}

/** External touchpoints of the merge-completion watcher chore (all injectable
 * for tests so the decision logic runs without gh / a live Redis). */
export interface HoldbackMergeWatchDeps {
  /** List the armed-but-not-landed pending entries. Defaults to `pendingEnrollList`. */
  listPending?: typeof pendingEnrollList;
  /** Remove a pending entry once its PR has landed. Defaults to `pendingEnrollRemove`. */
  removePending?: typeof pendingEnrollRemove;
  /** Has this PR's landing already been processed? Defaults to `wasEnrolledMarked`. */
  wasEnrolled?: typeof wasEnrolledMarked;
  /** Mark this PR's landing processed. Defaults to `markEnrolled`. */
  mark?: typeof markEnrolled;
  /** Fetch a PR's merge-landing status. Defaults to a `gh pr view` call. */
  fetchMergeStatus?: (prNumber: number) => Promise<MergeStatus | null>;
  /** Snapshot the pre-merge baseline. Defaults to `enrollHoldback`. */
  enroll?: typeof enrollHoldback;
  /** Fire the cycle-record merged-status enrichment. Defaults to `recordCycle`. */
  recordCycleRecord?: (body: {
    cycleId: string;
    prNumber: number;
    filesChanged?: number;
    // Issue #2800: the explicit dispatch-class anchorType, forwarded from the
    // pending-enroll entry. Ensures a first-write enrichment (reap never wrote a
    // record for this cycleId) classifies explicitly instead of bucketing to
    // `unclassified`. Absent for pre-#2800 entries → prior inference behaviour.
    anchorType?: string;
    // Issue #2854: a landed PR merged. For the qa_orch relay case (reap never
    // wrote a prior cycle-record) this enrichment is the FIRST write, so it must
    // carry the merged status + counters or recordCycle defaults them to 0 and
    // buckets the cycle `unaccounted`/empty. On the dedup path recordCycle reads
    // `existing.status` and ignores these, so already-recorded cycles are safe.
    status?: string;
    tasksMerged?: number;
    tasksAttempted?: number;
  }) => Promise<CycleRecordResult>;
  /** Persist the last-run health snapshot. Defaults to `setMergeWatchHealth`. */
  setHealth?: (record: MergeWatchHealthRecord) => Promise<void>;
}

/** Per-run summary the chore returns (never throws). */
export interface HoldbackMergeWatchResult {
  /** Pending-registry depth at run start. */
  pendingDepth: number;
  /** PRs whose landing was enrolled+enriched this run (T2/T3/T4). */
  landed: number;
  /** Landed T1/unknown-tier PRs dropped from the registry without enrolling. */
  droppedExempt: number;
  /** Entries left untouched (PR still open / no merge commit). */
  stillOpen: number;
  /** Entries left in place because a step failed (retried next tick). */
  retried: number;
}

/**
 * Run one merge-completion watch pass over the pending-enroll registry.
 *
 * For each pending entry:
 *   - fetch its merge-landing status; a fetch failure logs and leaves the entry
 *     (retried next tick);
 *   - if not landed (no merge commit), leave it (AC2);
 *   - if already processed (per-PR marker set), just drop the stale entry;
 *   - otherwise fire `enrollHoldback` (which drops T1/unknown WITHOUT enrolling,
 *     AC4) + the cycle-record enrichment, then mark + remove (AC1/AC3).
 *
 * Returns a summary; never throws (AC5). Persists a health snapshot (AC6).
 */
export async function runHoldbackMergeWatch(
  deps: HoldbackMergeWatchDeps = {},
): Promise<HoldbackMergeWatchResult> {
  const listPending = deps.listPending ?? pendingEnrollList;
  const removePending = deps.removePending ?? pendingEnrollRemove;
  const wasEnrolled = deps.wasEnrolled ?? wasEnrolledMarked;
  const mark = deps.mark ?? markEnrolled;
  const fetchMergeStatus = deps.fetchMergeStatus ?? fetchMergeStatusViaGh;
  const enroll = deps.enroll ?? enrollHoldback;
  const recordCycleRecord =
    deps.recordCycleRecord ?? ((body) => recordCycle(body));
  const setHealth = deps.setHealth ?? setMergeWatchHealth;

  const result: HoldbackMergeWatchResult = {
    pendingDepth: 0,
    landed: 0,
    droppedExempt: 0,
    stillOpen: 0,
    retried: 0,
  };

  const listed = await listPending();
  if (listed.ok === false) {
    // Can't read the registry this tick — log, persist an empty health snapshot,
    // and bail. Never throws.
    console.error(`[Housekeeping] merge-watch: pendingEnrollList failed: ${listed.error}`);
    await persistHealth(setHealth, result);
    return result;
  }

  const entries = listed.entries;
  result.pendingDepth = entries.length;

  for (const entry of entries) {
    await processOne(entry, {
      removePending,
      wasEnrolled,
      mark,
      fetchMergeStatus,
      enroll,
      recordCycleRecord,
      result,
    });
  }

  await persistHealth(setHealth, result);

  if (result.landed > 0 || result.droppedExempt > 0) {
    console.log(
      `[Housekeeping] merge-watch: pending=${result.pendingDepth} landed=${result.landed} droppedExempt=${result.droppedExempt} stillOpen=${result.stillOpen} retried=${result.retried}`,
    );
  }

  return result;
}

/** Process a single pending entry — the per-PR body of {@link runHoldbackMergeWatch}. */
async function processOne(
  entry: PendingEnrollEntry,
  ctx: {
    removePending: typeof pendingEnrollRemove;
    wasEnrolled: typeof wasEnrolledMarked;
    mark: typeof markEnrolled;
    fetchMergeStatus: (prNumber: number) => Promise<MergeStatus | null>;
    enroll: typeof enrollHoldback;
    recordCycleRecord: (body: {
      cycleId: string;
      prNumber: number;
      filesChanged?: number;
      anchorType?: string;
      status?: string;
      tasksMerged?: number;
      tasksAttempted?: number;
    }) => Promise<CycleRecordResult>;
    result: HoldbackMergeWatchResult;
  },
): Promise<void> {
  const { prNumber } = entry;
  try {
    const status = await ctx.fetchMergeStatus(prNumber);
    if (status == null) {
      // gh/API failure — leave the entry for the next tick (AC5).
      console.error(`[Housekeeping] merge-watch: mergeStatus fetch failed for pr ${prNumber}; retrying next tick`);
      ctx.result.retried += 1;
      return;
    }

    // Not landed yet — no merge commit. Leave the entry untouched (AC2).
    if (!status.mergeCommitSha) {
      ctx.result.stillOpen += 1;
      return;
    }

    const commitSha = status.mergeCommitSha;

    // Already processed on a prior tick (marker set) — the two writes already
    // fired; just drop the stale pending entry (AC3).
    if (await ctx.wasEnrolled(prNumber)) {
      await ctx.removePending(prNumber);
      return;
    }

    // Fire the enroll. The server-side carry-up exemption drops T1/unknown-tier
    // WITHOUT enrolling (enrolled:false), so a landed exempt PR is dropped from
    // the registry without a baseline (AC4). A hard error (ok:false) leaves the
    // entry to retry.
    const enrollRes: EnrollResult = await ctx.enroll({
      commitSha,
      prNumber,
      tier: entry.tier,
    });
    if (enrollRes.ok === false) {
      console.error(`[Housekeeping] merge-watch: enroll failed for pr ${prNumber}: ${enrollRes.error}; retrying next tick`);
      ctx.result.retried += 1;
      return;
    }

    // Cycle-record merged-status enrichment: an idempotent duplicate post that
    // enriches the existing record with filesChanged + prNumber (issue #2063)
    // without re-firing any counter. Best-effort — a non-ok result is logged but
    // does NOT block dropping the entry: the enrollment (the correctness-bearing
    // write) already succeeded, and cycle-record enrichment is observability.
    const cycleBody: {
      cycleId: string;
      prNumber: number;
      filesChanged?: number;
      anchorType?: string;
      status?: string;
      tasksMerged?: number;
      tasksAttempted?: number;
    } = {
      cycleId: entry.cycleId,
      prNumber,
      // Issue #2854: a merge-watch enrichment fires exactly when a PR has LANDED,
      // so the terminal status is `merged` with one task attempted+merged. For
      // the qa_orch relay case (reap never wrote a cycle-record for this cycleId)
      // this is the FIRST write — without these fields recordCycle defaults the
      // counters to 0 and buckets the cycle `unaccounted`/empty, inflating the
      // empty-cycle rate. On the dedup path recordCycle short-circuits on
      // `existing.status` and never reads these, so already-recorded cycles are
      // unaffected (no double-count).
      status: "merged",
      tasksMerged: 1,
      tasksAttempted: 1,
    };
    if (status.changedFiles != null) cycleBody.filesChanged = status.changedFiles;
    // Issue #2800: forward the explicit anchorType the arming caller recorded on
    // the pending entry. When reap never wrote a cycle-record for this cycleId
    // (the qa_orch relay case), this enrichment is the FIRST write — so without
    // an explicit anchorType the bare-UUID cycleId falls through the slot-suffix
    // inference to the `unclassified` sentinel (the 32%-unclassified gap). A
    // pre-#2800 entry (no anchorType) omits the field and degrades to the prior
    // inference behaviour. classifyAnchorType (cycle-close.ts) trims the value.
    if (entry.anchorType) cycleBody.anchorType = entry.anchorType;
    const cycleRes = await ctx.recordCycleRecord(cycleBody);
    if (cycleRes.ok === false) {
      console.error(`[Housekeeping] merge-watch: cycle-record enrichment failed for pr ${prNumber} (cycle ${entry.cycleId}): ${cycleRes.detail || cycleRes.code}`);
    }

    // Mark processed BEFORE removing so a marker-write failure leaves the entry
    // to retry (rather than dropping it un-marked and risking a re-fire). Only
    // remove once the mark landed.
    const marked = await ctx.mark(prNumber, commitSha);
    if (marked.ok === false) {
      console.error(`[Housekeeping] merge-watch: markEnrolled failed for pr ${prNumber}; leaving pending entry to retry`);
      ctx.result.retried += 1;
      return;
    }
    await ctx.removePending(prNumber);

    if (isEnrolledTier(entry.tier) && enrollRes.ok && "enrolled" in enrollRes && enrollRes.enrolled) {
      ctx.result.landed += 1;
    } else {
      // Landed but not enrolled — T1/unknown, or an enrolled-tier PR whose
      // outcome adapter returned no data (still a legitimate drop).
      ctx.result.droppedExempt += 1;
    }
  } catch (err: any) {
    // Defensive: no dep should throw (all are best-effort result-returning), but
    // if one does, log and leave the entry to retry — never abort the pass.
    console.error(`[Housekeeping] merge-watch: unexpected error for pr ${prNumber}: ${err?.message || String(err)}`);
    ctx.result.retried += 1;
  }
}

/** Persist the last-run health snapshot (best-effort). */
async function persistHealth(
  setHealth: (record: MergeWatchHealthRecord) => Promise<void>,
  result: HoldbackMergeWatchResult,
): Promise<void> {
  try {
    await setHealth({
      ranAt: new Date().toISOString(),
      pendingDepth: result.pendingDepth,
      landed: result.landed,
      droppedExempt: result.droppedExempt,
      stillOpen: result.stillOpen,
    });
  } catch (err: any) {
    console.error(`[Housekeeping] merge-watch: health persist failed: ${err?.message || String(err)}`);
  }
}
