/**
 * Cycle-record merged-status reconciliation backstop chore (issue #2860).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`), registered in
 * `src/scheduler/housekeeping.ts`. It is the SECOND layer of the merged-status
 * enrichment path — the self-healing backstop for cycles the primary
 * `holdback-merge-watch.ts` path missed.
 *
 * **Why a backstop is needed.** reap.py is the SOLE cycle-record first-writer
 * and always files a record at `status='completed'` with `tasksMerged` UNSET (it
 * runs BEFORE the merge decision is known, #430). The merged bump depends on the
 * PR having been ARMED into the pending-enroll registry — seeded by a MANUAL
 * `POST /api/holdback/pending` the autopilot session runs as a fallible bash step
 * in the `auto-merge` action. A PR that was never armed (a dropped POST, a crash
 * mid-arm, an auto-merge action the session forgot to register) NEVER reaches the
 * merge-watch enrichment, so its cycle record stays frozen at `completed` with
 * `tasksMerged=0` — and the dashboard trend/aggregate reads `tasksMerged>0` as
 * its SINGLE merged predicate (metrics/aggregate.ts), so those merged cycles
 * report 0% merged (issue #2860). Over the last 50 cycles this was the dominant
 * failure mode: 0/50 carried `tasksMerged>0` despite most PRs having merged.
 *
 * **What it does.** Each housekeeping tick it scans the N most-recent cycle
 * records, selects those that are (a) `status='completed'` and (b) carry a
 * non-empty `prNumber`, confirms via `gh pr view` that the PR actually MERGED,
 * and — if so — re-posts through `recordCycle` with `status='merged'`,
 * `tasksMerged=1`. `recordCycle`'s dedup/enrichment path (issue #2860) performs
 * the `completed → merged` UPGRADE: it bumps the metrics-hash `tasksMerged`
 * WITHOUT re-firing any lifetime scheduler counter (the counter already fired
 * once at the `completed` first-write, since `completed` is in MERGED_STATUSES —
 * so the "counters fire exactly once per cycleId" invariant is preserved).
 *
 * **Idempotent.** Once a record is upgraded to `status='merged'` it no longer
 * matches the `completed` selection filter, so a subsequent tick skips it. Even
 * if it were re-observed, `recordCycle`'s dedup short-circuits on the now-`merged`
 * existing status (only `completed → merged` upgrades; `merged` is terminal).
 *
 * **Never throws.** Per CLAUDE.md the whole chore is best-effort: a `gh`/API
 * failure for one PR is logged and that record is left for the next tick; a
 * failure never aborts the remaining records. It returns a summary object.
 *
 * **Bounded.** It scans at most `scanLimit` recent records and confirms at most
 * `confirmLimit` PRs per tick (the `gh` calls are the cost), so an hourly tick
 * against a large historical backlog drains it gradually rather than in one
 * unbounded burst. An already-drained window is a guaranteed no-op.
 *
 * **Self-arm backstop for the pending-enroll registry (issue #3078).** The
 * arming of a PR into `hydra:holdback:pending-enroll` (the Outcome Attribution
 * Spine ledger's ingress, #2622/#2628) is a best-effort `POST /api/holdback/pending`
 * the autopilot session runs on an `auto-merge` action. When that POST is dropped
 * (an LLM print-mode turn that forgets it, a crash mid-arm) the PR never reaches
 * the merge-completion watcher and the ledger stays dark — observed at 7+ days of
 * zero entries. This chore ALREADY confirms, per merged PR, exactly the signal the
 * arming step needed (`gh pr view` → MERGED). So on a confirmed-merged candidate it
 * ALSO self-arms: if that PR is absent from the pending-enroll registry AND not
 * already enrolled-marked, it calls `pendingEnrollAdd` (records intent only — never
 * arms/blocks/performs a merge) so the merge-watch chore enrolls it on the next
 * tick. This recovers a dropped arming POST with NO new webhook/event surface,
 * reusing the polling this chore already does. It is idempotent (skips a PR already
 * in the registry or already enrolled), never-throws (a Redis error for one PR is
 * logged and that PR left for the next tick), and NEVER filters by tier — the
 * T1/unknown-tier carry-up exemption stays enforced server-side in `enrollHoldback`
 * (which the merge-watch chore calls), not here at arm time.
 */

import { getRecentMetricIdsDesc, getCycleMetrics } from "../../redis/cycle-metrics.ts";
import { recordCycle, type CycleRecordResult } from "../../autopilot/cycle-close.ts";
import { viewPr } from "../../github/issues.ts";
import {
  pendingEnrollList,
  pendingEnrollAdd,
  wasEnrolledMarked,
  type PendingEnrollEntry,
  type PendingEnrollAddResult,
} from "../../redis/holdback.ts";

/** How many recent cycle records to scan per tick (newest first). */
const DEFAULT_SCAN_LIMIT = 50;
/** How many candidate PRs to confirm via `gh` per tick (bounds the API cost). */
const DEFAULT_CONFIRM_LIMIT = 10;

/** Raw `gh pr view <n> --json state` shape. */
interface RawPrState {
  state?: string | null;
}

/**
 * Default merge-confirmation fetch: `gh pr view <n> --json state`. Returns the
 * PR state string (`MERGED`/`OPEN`/`CLOSED`) or `null` on any failure. `viewPr`
 * never throws. The REST transport carries `state` inline, so no GraphQL pool
 * cost is incurred.
 */
async function fetchPrStateViaGh(prNumber: number): Promise<string | null> {
  const view = await viewPr<RawPrState>(prNumber, "state");
  if (view == null) return null;
  return typeof view.state === "string" ? view.state : null;
}

/** External touchpoints (all injectable for tests so the logic runs without gh / live Redis). */
export interface CycleMergeReconcileDeps {
  /** List recent cycle IDs, newest first. Defaults to `getRecentMetricIdsDesc`. */
  listRecent?: (count: number) => Promise<string[]>;
  /** Fetch a cycle's metrics hash. Defaults to `getCycleMetrics`. */
  getMetrics?: (cycleId: string) => Promise<Record<string, string>>;
  /** Fetch a PR's state string. Defaults to a `gh pr view` call. */
  fetchPrState?: (prNumber: number) => Promise<string | null>;
  /** Fire the completed→merged upgrade re-post. Defaults to `recordCycle`. */
  recordCycleRecord?: (body: {
    cycleId: string;
    status: string;
    tasksMerged: number;
    prNumber: number;
  }) => Promise<CycleRecordResult>;
  /** Max recent records to scan this tick. Defaults to 50. */
  scanLimit?: number;
  /** Max candidate PRs to confirm via gh this tick. Defaults to 10. */
  confirmLimit?: number;
  // --- Self-arm backstop touchpoints (issue #3078; all injectable) ------------
  /**
   * List the prNumbers currently in the pending-enroll registry, as a Set for
   * O(1) membership. Defaults to reading `pendingEnrollList` once per tick.
   * A list failure disables self-arm for this tick (conservative — never arm
   * blind, which would risk a duplicate the merge-watch is already handling).
   */
  listPending?: () => Promise<Set<number>>;
  /** True when this PR's landing was already enroll-processed. Defaults to `wasEnrolledMarked`. */
  wasEnrolled?: (prNumber: number) => Promise<boolean>;
  /** Arm a confirmed-merged-but-unregistered PR into the registry. Defaults to `pendingEnrollAdd`. */
  armPending?: (entry: PendingEnrollEntry) => Promise<PendingEnrollAddResult>;
}

/** Per-run summary the chore returns (never throws). */
export interface CycleMergeReconcileResult {
  /** Records scanned this tick. */
  scanned: number;
  /** Completed-with-prNumber candidates found. */
  candidates: number;
  /** PRs whose merge was confirmed and whose record was upgraded to merged. */
  upgraded: number;
  /** Candidate PRs confirmed NOT merged (still open / closed unmerged) — left as-is. */
  notMerged: number;
  /** Candidates whose gh state fetch failed — retried next tick. */
  fetchFailed: number;
  /** Candidates whose upgrade re-post returned a non-ok result — retried next tick. */
  upgradeFailed: number;
  // --- Self-arm backstop counters (issue #3078) -------------------------------
  /** Confirmed-merged PRs newly armed into the pending-enroll registry this tick. */
  selfArmed: number;
  /** Confirmed-merged PRs skipped by self-arm (already registered or already enrolled). */
  selfArmSkipped: number;
  /** Confirmed-merged PRs whose self-arm `pendingEnrollAdd` returned non-ok — retried next tick. */
  selfArmFailed: number;
}

/**
 * Run one merged-status reconciliation pass over recent cycle records.
 *
 * Returns a summary; never throws. Intrinsically idempotent (an upgraded record
 * no longer matches the `completed` filter), so no Redis time-guard is needed —
 * an hourly tick against an all-merged/all-drained window is a silent no-op.
 */
export async function runCycleMergeReconcile(
  deps: CycleMergeReconcileDeps = {},
): Promise<CycleMergeReconcileResult> {
  const listRecent = deps.listRecent ?? getRecentMetricIdsDesc;
  const getMetrics = deps.getMetrics ?? getCycleMetrics;
  const fetchPrState = deps.fetchPrState ?? fetchPrStateViaGh;
  const recordCycleRecord = deps.recordCycleRecord ?? ((body) => recordCycle(body));
  const scanLimit = deps.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const confirmLimit = deps.confirmLimit ?? DEFAULT_CONFIRM_LIMIT;
  // Self-arm backstop touchpoints (issue #3078). `listPending` reads the whole
  // registry ONCE per tick and returns a Set for O(1) membership — cheaper than a
  // per-PR HGET and consistent with the bounded gh budget.
  const listPending =
    deps.listPending ??
    (async () => {
      const r = await pendingEnrollList();
      if (r.ok === false) {
        // Signal "unknown registry" to the caller by throwing — the caller
        // disables self-arm for this tick rather than arming blind.
        throw new Error(r.error);
      }
      return new Set(r.entries.map((e) => e.prNumber));
    });
  const wasEnrolled = deps.wasEnrolled ?? wasEnrolledMarked;
  const armPending = deps.armPending ?? pendingEnrollAdd;

  const result: CycleMergeReconcileResult = {
    scanned: 0,
    candidates: 0,
    upgraded: 0,
    notMerged: 0,
    fetchFailed: 0,
    upgradeFailed: 0,
    selfArmed: 0,
    selfArmSkipped: 0,
    selfArmFailed: 0,
  };

  // Snapshot the pending-enroll registry once per tick. A read failure disables
  // self-arm for the tick (conservative — never arm blind, which would risk a
  // duplicate the merge-watch is already about to enroll). `null` = disabled.
  let pendingSet: Set<number> | null = null;
  try {
    pendingSet = await listPending();
  } catch (err: any) {
    console.error(
      `[Housekeeping] cycle-merge-reconcile: pending-enroll list failed; self-arm disabled this tick: ${err?.message || String(err)}`,
    );
    pendingSet = null;
  }

  let ids: string[];
  try {
    ids = await listRecent(scanLimit);
  } catch (err: any) {
    console.error(`[Housekeeping] cycle-merge-reconcile: listRecent failed: ${err?.message || String(err)}`);
    return result;
  }

  for (const cycleId of ids) {
    // Stop confirming once the per-tick gh budget is spent — the remaining
    // candidates are picked up next tick (the scan itself is cheap; the gh
    // confirmation is the bounded cost).
    if (result.upgraded + result.notMerged + result.fetchFailed >= confirmLimit) break;

    try {
      const m = await getMetrics(cycleId);
      result.scanned += 1;
      if (!m || Object.keys(m).length === 0) continue;

      // Only completed records are upgrade candidates. A record already at
      // 'merged'/'failed' is terminal; anything else is not a merged-PR miss.
      const status = (m.status || "").trim().toLowerCase();
      if (status !== "completed") continue;

      // Must carry a PR number to confirm against, and must not already show a
      // recorded merge (defensive — a completed record should have tasksMerged=0,
      // but never re-post if it somehow already reads >0).
      const prRaw = (m.prNumber || "").trim();
      const prNumber = Number(prRaw);
      if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) continue;
      const alreadyMerged = Number(m.tasksMerged);
      if (Number.isFinite(alreadyMerged) && alreadyMerged > 0) continue;

      result.candidates += 1;

      const prState = await fetchPrState(prNumber);
      if (prState == null) {
        // gh/API failure — leave the record for the next tick.
        console.error(`[Housekeeping] cycle-merge-reconcile: state fetch failed for pr ${prNumber} (cycle ${cycleId}); retrying next tick`);
        result.fetchFailed += 1;
        continue;
      }
      if (prState.toUpperCase() !== "MERGED") {
        // Still open, or closed unmerged — not a merged-status miss.
        result.notMerged += 1;
        continue;
      }

      // Confirmed merged — self-arm the pending-enroll registry (issue #3078)
      // BEFORE the metrics upgrade. This recovers a dropped `POST /api/holdback/
      // pending` arm: a merged PR absent from the registry AND not yet enrolled-
      // marked is armed so the merge-watch chore enrolls it next tick. Skipped
      // when the tick's registry read failed (pendingSet===null → arm-blind
      // avoidance) or the PR is already registered/enrolled. Never filters by
      // tier — the T1/unknown-tier exemption lives server-side in enrollHoldback.
      // Best-effort: a failed arm is counted and retried next tick, never aborts
      // the upgrade below.
      if (pendingSet !== null && !pendingSet.has(prNumber)) {
        let enrolledAlready = false;
        try {
          enrolledAlready = await wasEnrolled(prNumber);
        } catch (err: any) {
          // wasEnrolledMarked itself never throws (it fails closed to true), but
          // an injected dep might — fail closed to "already enrolled" so we never
          // double-arm on an unknown state.
          console.error(
            `[Housekeeping] cycle-merge-reconcile: self-arm enrolled-check failed for pr ${prNumber} (cycle ${cycleId}); skipping arm: ${err?.message || String(err)}`,
          );
          enrolledAlready = true;
        }
        if (enrolledAlready) {
          result.selfArmSkipped += 1;
        } else {
          const armEntry: PendingEnrollEntry = {
            prNumber,
            // Tier is unknown from the cycle-metrics hash here; null is the
            // permissive "unknown-tier" the enroll schema accepts. enrollHoldback
            // resolves the real tier server-side at landing time.
            tier: null,
            cycleId,
            anchorType: "work-queue",
            registeredAt: Date.now(),
          };
          let armed: PendingEnrollAddResult;
          try {
            armed = await armPending(armEntry);
          } catch (err: any) {
            armed = { ok: false, error: err?.message || String(err) };
          }
          if (armed.ok === false) {
            console.error(
              `[Housekeeping] cycle-merge-reconcile: self-arm pendingEnrollAdd failed for pr ${prNumber} (cycle ${cycleId}); retrying next tick: ${armed.error}`,
            );
            result.selfArmFailed += 1;
          } else {
            // Keep the local snapshot consistent so a second merged cycle sharing
            // this prNumber in the same tick isn't double-armed.
            pendingSet.add(prNumber);
            result.selfArmed += 1;
          }
        }
      } else if (pendingSet !== null) {
        // Already in the registry — the merge-watch will enroll it; nothing to do.
        result.selfArmSkipped += 1;
      }

      // Confirmed merged — fire the completed→merged upgrade re-post. recordCycle's
      // dedup path bumps the metrics tasksMerged + cycle-hash status WITHOUT
      // re-firing any lifetime counter (issue #2860).
      const rec = await recordCycleRecord({
        cycleId,
        status: "merged",
        tasksMerged: 1,
        prNumber,
      });
      if (rec.ok === false) {
        console.error(`[Housekeeping] cycle-merge-reconcile: upgrade re-post failed for pr ${prNumber} (cycle ${cycleId}): ${rec.detail || rec.code}`);
        result.upgradeFailed += 1;
        continue;
      }
      result.upgraded += 1;
    } catch (err: any) {
      // Defensive: no dep should throw, but if one does, log and continue —
      // never abort the pass.
      console.error(`[Housekeeping] cycle-merge-reconcile: unexpected error for cycle ${cycleId}: ${err?.message || String(err)}`);
    }
  }

  if (result.upgraded > 0 || result.selfArmed > 0) {
    console.log(
      `[Housekeeping] cycle-merge-reconcile: scanned=${result.scanned} candidates=${result.candidates} upgraded=${result.upgraded} notMerged=${result.notMerged} fetchFailed=${result.fetchFailed} upgradeFailed=${result.upgradeFailed} selfArmed=${result.selfArmed} selfArmSkipped=${result.selfArmSkipped} selfArmFailed=${result.selfArmFailed}`,
    );
  }

  return result;
}
