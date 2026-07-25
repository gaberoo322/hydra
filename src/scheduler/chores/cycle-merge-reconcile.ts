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
 * ALSO self-arms it. The arm POLICY — the eligibility check, the enrolled-check,
 * the sentinel-omission, and the arm-entry shape — was extracted into the
 * `attribution-self-arm.ts` leaf (issue #3639): this chore owns the tick lifecycle
 * (the once-per-tick pending-enroll LIST snapshot + arm-blind avoidance + counter
 * aggregation) and delegates the per-PR arm decision to
 * `selfArmConfirmedMergedPr`. That leaf co-locates the attribution-arm knowledge in
 * the attribution domain rather than in this cycle-hash enrichment file. The
 * behavior is unchanged: a merged PR absent from the registry AND not already
 * enrolled-marked is armed (records intent only — never arms/blocks/performs a
 * merge) so the merge-watch chore enrolls it on the next tick; idempotent,
 * never-throws, and NEVER tier-filtering (the T1/unknown-tier carry-up exemption
 * stays enforced server-side in `enrollHoldback`, not here at arm time).
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
} from "../../redis/holdback-merge-watch.ts";
import {
  setReconcilerHealth,
  type ReconcilerHealthRecord,
} from "../../redis/reconciler.ts";
import {
  selfArmConfirmedMergedPr,
  isSentinelReconcileAnchorType,
} from "./attribution-self-arm.ts";
import { logger } from "../../logger.ts";

/** How many recent cycle records to scan per tick (newest first). */
const DEFAULT_SCAN_LIMIT = 50;
/** How many candidate PRs to confirm via `gh` per tick (bounds the API cost). */
const DEFAULT_CONFIRM_LIMIT = 10;

/** Raw `gh pr view <n> --json state,headRefName` shape. */
interface RawPrState {
  state?: string | null;
  headRefName?: string | null;
}

/**
 * The normalized merge-confirmation result: the PR `state` string
 * (`MERGED`/`OPEN`/`CLOSED`) plus, for the anchorType-heal decode source (issue
 * #3604), the merged PR's head-branch ref. `headRefName` is `null` when the view
 * didn't report one.
 */
export interface ReconcilePrView {
  state: string | null;
  headRefName: string | null;
}

/**
 * Default merge-confirmation fetch: `gh pr view <n> --json state,headRefName`.
 * Returns `{ state, headRefName }` or `null` on any failure. `viewPr` never
 * throws.
 *
 * Issue #3604: `headRefName` rides along on the SAME view — a plain scalar field
 * carried inline on both transports, so it adds no extra call. It is the second
 * anchorType decode source the enrichment-path heal needs: a bare-UUID
 * `completed` cycle (which reaches THIS backstop, never the merge-watch path) can
 * only recover its dispatch class from the merged PR's fenced head branch
 * (`worktree-agent-<tok>-t{N}-<slot>`), since the bare cycleId itself carries no
 * class token. Fetched via GraphQL for parity with holdback-merge-watch's
 * `headRefName` fetch; the confirmation set is bounded by `confirmLimit` per tick.
 */
async function fetchPrStateViaGh(prNumber: number): Promise<ReconcilePrView | null> {
  const view = await viewPr<RawPrState>(prNumber, "state,headRefName", {
    transport: "graphql",
  });
  if (view == null) return null;
  return {
    state: typeof view.state === "string" ? view.state : null,
    headRefName:
      typeof view.headRefName === "string" && view.headRefName.length > 0
        ? view.headRefName
        : null,
  };
}

/** External touchpoints (all injectable for tests so the logic runs without gh / live Redis). */
export interface CycleMergeReconcileDeps {
  /** List recent cycle IDs, newest first. Defaults to `getRecentMetricIdsDesc`. */
  listRecent?: (count: number) => Promise<string[]>;
  /** Fetch a cycle's metrics hash. Defaults to `getCycleMetrics`. */
  getMetrics?: (cycleId: string) => Promise<Record<string, string>>;
  /**
   * Fetch a PR's `{ state, headRefName }`. Defaults to a `gh pr view` call.
   * (Issue #3604 widened the return from a bare `state` string to carry the head
   * branch as the anchorType-heal decode source.)
   */
  fetchPrState?: (prNumber: number) => Promise<ReconcilePrView | null>;
  /** Fire the completed→merged upgrade re-post. Defaults to `recordCycle`. */
  recordCycleRecord?: (body: {
    cycleId: string;
    status: string;
    tasksMerged: number;
    prNumber: number;
    /**
     * The original cycle's anchorType, read back from the metrics hash and
     * forwarded so the merged-status re-post does not drop it (issue #3122).
     * Omitted (`undefined`) when the hash carried no explicit anchorType, in
     * which case `classifyAnchorType` re-infers from the cycleId as before.
     */
    anchorType?: string;
    /**
     * The merged PR's head-branch ref (issue #3604), forwarded as the SECOND
     * anchorType decode source so `recordCycle`'s enrichment-path heal can decode
     * a bare-UUID cycle's dispatch class from a fenced branch
     * (`worktree-agent-<tok>-t{N}-<slot>`) when the cycleId carries no class token
     * and the metrics hash stored the `unclassified` sentinel. Omitted when the
     * hash already carries a genuine anchorType (it is authoritative) or no head
     * branch was reported. Same never-guess fence parser → never a guess (#2822).
     */
    worktreeBranch?: string;
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
  /**
   * Persist the last-run health snapshot so `GET /api/scheduler/status` reports a
   * fresh `reconciler.ranAt` (issue #3509). Defaults to `setReconcilerHealth`.
   * Best-effort — a write failure is logged and never aborts the chore.
   */
  setHealth?: (record: ReconcilerHealthRecord) => Promise<void>;
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
  const setHealth = deps.setHealth ?? setReconcilerHealth;

  // Wall-clock start of this run — carried into the persisted health record's
  // duration (issue #3509).
  const startedAt = Date.now();

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
    logger.error({ err }, "cycle-merge-reconcile: pending-enroll list failed; self-arm disabled this tick");
    pendingSet = null;
  }

  let ids: string[];
  try {
    ids = await listRecent(scanLimit);
  } catch (err: any) {
    logger.error({ err }, "cycle-merge-reconcile: listRecent failed");
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

      const prView = await fetchPrState(prNumber);
      if (prView == null) {
        // gh/API failure — leave the record for the next tick.
        logger.error({ prNumber, cycleId }, "cycle-merge-reconcile: state fetch failed; retrying next tick");
        result.fetchFailed += 1;
        continue;
      }
      if ((prView.state || "").toUpperCase() !== "MERGED") {
        // Still open, or closed unmerged — not a merged-status miss.
        result.notMerged += 1;
        continue;
      }

      // Confirmed merged — self-arm the pending-enroll registry (issue #3078)
      // BEFORE the metrics upgrade, recovering a dropped `POST /api/holdback/
      // pending` arm. The per-PR arm POLICY (eligibility, enrolled-check,
      // sentinel-omission, arm-entry shape) lives in the `attribution-self-arm.ts`
      // leaf (issue #3639); this coordinator owns the tick lifecycle: it disables
      // self-arm for the whole tick when the once-per-tick registry read failed
      // (pendingSet===null → arm-blind avoidance) and maps the leaf's per-PR
      // outcome onto its counters. Best-effort: a `failed` outcome is counted and
      // retried next tick, never aborting the upgrade below.
      if (pendingSet !== null) {
        const outcome = await selfArmConfirmedMergedPr(
          { prNumber, cycleId, hashAnchorType: m.anchorType },
          pendingSet,
          { wasEnrolled, armPending },
        );
        if (outcome === "armed") result.selfArmed += 1;
        else if (outcome === "skipped") result.selfArmSkipped += 1;
        else result.selfArmFailed += 1;
      }

      // Confirmed merged — fire the completed→merged upgrade re-post. recordCycle's
      // dedup path bumps the metrics tasksMerged + cycle-hash status WITHOUT
      // re-firing any lifetime counter (issue #2860).
      //
      // Preserve the original anchorType (issue #3122): the reap-time first-write
      // classified this cycle's anchorType and stored it on the metrics hash. If
      // we omit it here, `classifyAnchorType` re-infers from the cycleId — which
      // for a bare-UUID (non-worktree) cycleId fails and defaults to
      // `unclassified`, silently dropping the real class on ~12% of records. Read
      // it back from the hash and forward it; leave undefined (→ re-infer) only
      // when the hash carried no explicit anchorType.
      //
      // Issue #3604: a STORED SENTINEL (`unclassified`/`unknown`) is NOT a real
      // anchorType — forwarding it verbatim would make `recordCycle` return it
      // unchanged and permanently bake the sentinel in. Treat it as "no explicit
      // value" (omit the field) so the enrichment-path heal falls through to the
      // head-branch decode below. Only a GENUINE stored class is forwarded (it is
      // authoritative — the heal never overwrites it).
      const storedAnchorType = (m.anchorType || "").trim();
      const genuineAnchorType = isSentinelReconcileAnchorType(storedAnchorType)
        ? undefined
        : storedAnchorType;
      const upgradeBody: {
        cycleId: string;
        status: string;
        tasksMerged: number;
        prNumber: number;
        anchorType?: string;
        worktreeBranch?: string;
      } = {
        cycleId,
        status: "merged",
        tasksMerged: 1,
        prNumber,
        anchorType: genuineAnchorType,
      };
      // Issue #3604: when the hash carried NO genuine anchorType, forward the
      // merged PR's fenced head branch as the heal's decode source so a bare-UUID
      // cycle recovers its class from `worktree-agent-<tok>-t{N}-<slot>` (the same
      // never-guess parser reap/merge-watch use). Suppressed when a genuine class
      // exists (authoritative) or no head branch was reported.
      if (!genuineAnchorType && prView.headRefName) {
        upgradeBody.worktreeBranch = prView.headRefName;
      }
      const rec = await recordCycleRecord(upgradeBody);
      if (rec.ok === false) {
        logger.error(
          { prNumber, cycleId, err: { message: rec.detail || rec.code, code: rec.code } },
          "cycle-merge-reconcile: upgrade re-post failed",
        );
        result.upgradeFailed += 1;
        continue;
      }
      result.upgraded += 1;
    } catch (err: any) {
      // Defensive: no dep should throw, but if one does, log and continue —
      // never abort the pass.
      logger.error({ cycleId, err }, "cycle-merge-reconcile: unexpected error");
    }
  }

  if (result.upgraded > 0 || result.selfArmed > 0) {
    logger.info(
      {
        scanned: result.scanned,
        candidates: result.candidates,
        upgraded: result.upgraded,
        notMerged: result.notMerged,
        fetchFailed: result.fetchFailed,
        upgradeFailed: result.upgradeFailed,
        selfArmed: result.selfArmed,
        selfArmSkipped: result.selfArmSkipped,
        selfArmFailed: result.selfArmFailed,
      },
      "cycle-merge-reconcile: pass complete",
    );
  }

  // Persist the last-run health snapshot so `GET /api/scheduler/status` surfaces a
  // fresh `reconciler.ranAt` instead of a stale timestamp (issue #3509). This
  // chore is the sole surviving reconciler, so it is the sole writer of the
  // health record the status projection reads. The `ReconcilerHealthRecord` shape
  // predates this chore (it mirrored the removed merge→done reconciler), so the
  // per-run counters map onto it as follows:
  //   feed.prs.examined       — candidate PRs confirmed via `gh pr view` this tick
  //   feed.commits.examined   — 0 (this reconciler has no commit feed)
  //   metrics.scanned         — cycle records scanned
  //   metrics.referencesFound — completed-with-prNumber candidates
  //   metrics.itemsReconciled — records upgraded completed→merged
  //   metrics.itemsEscalated  — PRs self-armed into the pending-enroll registry
  //   metrics.movesFailed     — retryable failures (fetch + upgrade + self-arm)
  //   metrics.durationMs      — wall-clock run duration
  // Best-effort per CLAUDE.md — a Redis write failure is logged and never aborts
  // (the chore already returned its work); it is retried on the next hourly tick.
  const health: ReconcilerHealthRecord = {
    ranAt: new Date(startedAt).toISOString(),
    feed: {
      prs: { examined: result.candidates },
      commits: { examined: 0 },
    },
    metrics: {
      referencesFound: result.candidates,
      movesFailed: result.fetchFailed + result.upgradeFailed + result.selfArmFailed,
      itemsReconciled: result.upgraded,
      itemsEscalated: result.selfArmed,
      scanned: result.scanned,
      durationMs: Date.now() - startedAt,
    },
  };
  try {
    await setHealth(health);
  } catch (err: any) {
    logger.error(
      { err },
      "cycle-merge-reconcile: health-record persist failed; status ranAt will stay stale until next tick",
    );
  }

  return result;
}
