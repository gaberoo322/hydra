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
 * **Issue #4762 amendments.** Status is read from the CYCLE hash (the metrics hash
 * has no `status`); the `tasksMerged > 0` skip is gone (dispatch.sh maps
 * completed to tasksMerged=1); and a work-queue row with NO prNumber is joined to
 * a merged PR via its `anchorReference` (`issue-<N>`) against
 * `mergedPrReferences([pr])` over ONE REST merged-PR listing per tick — one PR
 * credits at most one row (latest recordedAt <= mergedAt), `_target` rows skipped.
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
import { viewPr, resolveGithubRepo } from "../../github/issues.ts";
import { ghJson } from "../../github/gh.ts";
import { isGhFailure } from "../../github/exec.ts";
import { mergedPrReferences } from "../../github/pr-refs.ts";
import { getCycleHash } from "../../redis/cycle-tracking.ts";
import { decodePrStateAndHeadRef } from "../../github/view-pr.ts";
import { recordOrchestratorSideMerge } from "../../capacity-floor.ts";
import { publishOrchestratorShareMetric } from "../../metrics/publish.ts";
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

/**
 * How many recent cycle records to scan per tick (newest first). Raised 50 -> 200
 * (issue #4762): the 7-day metrics TTL window holds ~156 rows across all anchor
 * types, so 50 covered only ~2 days and aged dev rows out before the backstop
 * reached them.
 */
const DEFAULT_SCAN_LIMIT = 200;
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
interface ReconcilePrView {
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
 *
 * The `state`/`headRefName` decode itself is shared with
 * `holdback-merge-watch.ts`'s `fetchMergeStatusViaGh` via
 * {@link decodePrStateAndHeadRef} (issue #4328) — this site needs nothing else,
 * so it calls the shared decode directly on its (narrower) view.
 *
 * Exported (test-only) so a wired test can drive it through a fake `gh` binary
 * and count invocations — proving it still makes exactly one `viewPr` call.
 */
export async function fetchPrStateViaGh(prNumber: number): Promise<ReconcilePrView | null> {
  const view = await viewPr<RawPrState>(prNumber, "state,headRefName", {
    transport: "graphql",
  });
  if (view == null) return null;
  return decodePrStateAndHeadRef(view);
}

/** One merged PR as decoded from the REST listing (issue #4762, path (b)). */
export interface MergedPrRow {
  number: number;
  /** Epoch ms of `merged_at`. */
  mergedAtMs: number;
  headRefName: string | null;
  title: string;
  body: string;
}

/**
 * Default merged-PR listing: ONE REST call (`gh api repos/{repo}/pulls?state=closed
 * &base=master&sort=updated&direction=desc&per_page=100`), keeping rows with a
 * non-null `merged_at`. REST, not GraphQL, because of the GraphQL rate-limit
 * exhaustion under a live autopilot. Returns `null` on any failure; never throws.
 */
export async function listMergedPrsViaRest(): Promise<MergedPrRow[] | null> {
  const repo = resolveGithubRepo();
  const res = await ghJson<unknown>([
    "api",
    `repos/${repo}/pulls?state=closed&base=master&sort=updated&direction=desc&per_page=100`,
  ]);
  if (isGhFailure(res)) return null;
  if (!Array.isArray(res.data)) {
    logger.error({ repo }, "cycle-merge-reconcile: merged-PR listing was not an array");
    return null;
  }
  const out: MergedPrRow[] = [];
  for (const raw of res.data as any[]) {
    if (!raw || typeof raw !== "object") continue;
    const mergedAtMs = typeof raw.merged_at === "string" ? Date.parse(raw.merged_at) : NaN;
    if (!Number.isFinite(mergedAtMs)) continue;
    if (!Number.isInteger(raw.number) || raw.number <= 0) continue;
    out.push({
      number: raw.number,
      mergedAtMs,
      headRefName: typeof raw.head?.ref === "string" ? raw.head.ref : null,
      title: typeof raw.title === "string" ? raw.title : "",
      body: typeof raw.body === "string" ? raw.body : "",
    });
  }
  return out;
}

/** External touchpoints (all injectable for tests so the logic runs without gh / live Redis). */
export interface CycleMergeReconcileDeps {
  /** List recent cycle IDs, newest first. Defaults to `getRecentMetricIdsDesc`. */
  listRecent?: (count: number) => Promise<string[]>;
  /** Fetch a cycle's metrics hash. Defaults to `getCycleMetrics`. */
  getMetrics?: (cycleId: string) => Promise<Record<string, string>>;
  /**
   * Read a cycle's status from the CYCLE hash (issue #4762, defect 1) — never
   * from the metrics hash, which carries no `status`. Defaults to
   * `getCycleHash(cycleId).status`.
   */
  getCycleStatus?: (cycleId: string) => Promise<string | null | undefined>;
  /**
   * ONE merged-PR listing per tick for the anchor-join path (issue #4762, path
   * (b)). Returns `null` on failure (never throws). Defaults to a REST listing.
   */
  listMergedPrs?: () => Promise<MergedPrRow[] | null>;
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
  // --- Capacity-ledger stamp touchpoints (issue #4299; both injectable) --------
  /**
   * Stamp a confirmed-merged PR into the capacity-floor history as
   * orchestrator-side (issue #4299, INV-2). Defaults to
   * `recordOrchestratorSideMerge` — this chore confirms merges only against
   * `gaberoo322/hydra` (the orchestrator repo), so a landing is orchestrator-
   * side by construction. `recordCycleSide` is idempotent on the `pr-<n>`
   * cycleId, so a PR both chores observe (or a re-observation after a failed
   * upgrade) collapses to exactly one entry.
   */
  recordCapacitySide?: typeof recordOrchestratorSideMerge;
  /**
   * Republish the orchestrator-share metric file after a capacity stamp
   * (issue #4299, INV-3) so `metrics/orchestrator-share.txt` tracks the
   * window after every write, not only after `cycle:completed` events.
   * Defaults to `publishOrchestratorShareMetric`.
   */
  publishShareMetric?: typeof publishOrchestratorShareMetric;
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
  /** Records upgraded through the anchor-join path (issue #4762, path (b)). */
  anchorJoined: number;
  /** 1 when the merged-PR listing failed this tick (path (b) disabled), else 0. */
  listFailed: number;
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
  const getCycleStatus =
    deps.getCycleStatus ?? (async (id: string) => (await getCycleHash(id)).status);
  const listMergedPrs = deps.listMergedPrs ?? listMergedPrsViaRest;
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
  // Capacity-ledger stamp touchpoints (issue #4299).
  const recordCapacitySide = deps.recordCapacitySide ?? recordOrchestratorSideMerge;
  const publishShareMetric = deps.publishShareMetric ?? publishOrchestratorShareMetric;

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
    anchorJoined: 0,
    listFailed: 0,
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

  // Path (b) pool (issue #4762): completed work-queue rows with NO prNumber,
  // joined to merged PRs by anchor after the scan.
  interface PoolRow {
    cycleId: string;
    m: Record<string, string>;
    issueNumber: number;
    recordedAtMs: number;
  }
  const pool: PoolRow[] = [];
  // prNumbers carried by ANY scanned work-queue row — path (a) owns those PRs.
  const scannedWorkQueuePrs = new Set<number>();

  /**
   * Everything that follows a CONFIRMED merge for one (cycle, PR): self-arm, the
   * capacity stamp, then the completed->merged upgrade re-post. Shared by path
   * (a) and path (b). Returns true when the upgrade landed.
   */
  async function applyConfirmedMerge(
    cycleId: string,
    m: Record<string, string>,
    prNumber: number,
    headRefName: string | null,
  ): Promise<boolean> {
    // Self-arm the pending-enroll registry (issue #3078) BEFORE the metrics
    // upgrade, recovering a dropped `POST /api/holdback/pending` arm. The per-PR
    // arm POLICY lives in the `attribution-self-arm.ts` leaf (issue #3639); this
    // coordinator owns the tick lifecycle: it disables self-arm for the whole
    // tick when the once-per-tick registry read failed (pendingSet===null ->
    // arm-blind avoidance) and maps the leaf's outcome onto its counters.
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

    // Issue #4299 (INV-2): capacity-ledger stamp on the `pr-<n>` key — the SAME
    // key holdback-merge-watch stamps; `recordCycleSide`'s cycleId idempotency
    // collapses the two observers into one entry. Best-effort (INV-6): a
    // stamp/publish failure never aborts the upgrade below.
    try {
      await recordCapacitySide(`pr-${prNumber}`, { source: "cycle-merge-reconcile" });
      await publishShareMetric();
    } catch (err: any) {
      logger.error(
        { prNumber, cycleId, err },
        "cycle-merge-reconcile: capacity stamp failed (non-fatal)",
      );
    }

    // Fire the completed->merged upgrade re-post. recordCycle's dedup path bumps
    // the metrics tasksMerged + cycle-hash status WITHOUT re-firing any lifetime
    // counter (issue #2860).
    //
    // Preserve the original anchorType (issue #3122): omitting it makes
    // `classifyAnchorType` re-infer from the cycleId, which for a bare-UUID
    // cycleId defaults to `unclassified`. A STORED SENTINEL
    // (`unclassified`/`unknown`) is NOT a real anchorType (issue #3604) — omit it
    // so the enrichment-path heal falls through to the head-branch decode.
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
    // Issue #3604: with NO genuine anchorType, forward the merged PR's fenced
    // head branch as the heal's decode source.
    if (!genuineAnchorType && headRefName) {
      upgradeBody.worktreeBranch = headRefName;
    }
    const rec = await recordCycleRecord(upgradeBody);
    if (rec.ok === false) {
      logger.error(
        { prNumber, cycleId, err: { message: rec.detail || rec.code, code: rec.code } },
        "cycle-merge-reconcile: upgrade re-post failed",
      );
      result.upgradeFailed += 1;
      return false;
    }
    result.upgraded += 1;
    return true;
  }

  for (const cycleId of ids) {
    try {
      const m = await getMetrics(cycleId);
      result.scanned += 1;
      if (!m || Object.keys(m).length === 0) continue;

      const prRaw = (m.prNumber || "").trim();
      const prNumber = Number(prRaw);
      const hasPr = !!prRaw && Number.isInteger(prNumber) && prNumber > 0;
      const isWorkQueue = (m.anchorType || "").trim() === "work-queue";
      if (isWorkQueue && hasPr) scannedWorkQueuePrs.add(prNumber);

      // Issue #4762 scope filter: dev_target rows carry a TARGET-repo issue
      // number; this chore only confirms against the orchestrator repo, so they
      // are skipped on BOTH paths (no false join of Target #N to hydra "Closes #N").
      if (/_target$/.test(cycleId)) continue;

      // Issue #4762 (defect 1): status comes from the CYCLE hash — the metrics
      // hash has no `status` field. Only `completed` is an upgrade candidate;
      // `merged` is terminal (the idempotency marker).
      const cycleStatus = ((await getCycleStatus(cycleId)) ?? "").trim().toLowerCase();
      if (cycleStatus !== "completed") continue;

      // Issue #4762 (defect 3): NO tasksMerged>0 skip — dispatch.sh maps completed
      // to tasksMerged=1, so that guard skipped every row. Cycle-hash `completed`
      // already means "not yet upgraded".

      if (!hasPr) {
        // Path (b) pool: work-queue rows only, keyed by anchorReference issue-<N>.
        if (!isWorkQueue) continue;
        const refMatch = /^issue-(\d+)$/.exec((m.anchorReference || "").trim());
        const recordedAtMs = Date.parse(m.recordedAt || "");
        if (!refMatch || !Number.isFinite(recordedAtMs)) continue;
        pool.push({ cycleId, m, issueNumber: Number(refMatch[1]), recordedAtMs });
        continue;
      }

      // Path (a): per-PR confirm, bounded by confirmLimit (the gh calls are the
      // cost). The scan itself continues so path (b) still sees every row.
      if (result.upgraded + result.notMerged + result.fetchFailed >= confirmLimit) continue;
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
      await applyConfirmedMerge(cycleId, m, prNumber, prView.headRefName);
    } catch (err: any) {
      // Defensive: no dep should throw, but if one does, log and continue —
      // never abort the pass.
      logger.error({ cycleId, err }, "cycle-merge-reconcile: unexpected error");
    }
  }

  // Path (b) (issue #4762): anchor join. ONE merged-PR listing per tick; a null
  // listing disables this path for the tick only. Attribution is one-to-one: a
  // merged PR P credits AT MOST ONE row — among pooled rows whose issue-<N> is in
  // mergedPrReferences([P]), the greatest recordedAt <= P.mergedAt. Oldest merge
  // first keeps the tie-break stable. These resolutions make no per-PR gh call so
  // they do not count against confirmLimit.
  if (pool.length > 0) {
    let merged: MergedPrRow[] | null = null;
    try {
      merged = await listMergedPrs();
    } catch (err: any) {
      logger.error({ err }, "cycle-merge-reconcile: merged-PR listing threw");
    }
    if (merged === null) {
      logger.error(
        { pooled: pool.length },
        "cycle-merge-reconcile: merged-PR listing failed; anchor-join disabled this tick",
      );
      result.listFailed += 1;
    } else {
      const ordered = [...merged].sort((a, b) => a.mergedAtMs - b.mergedAtMs);
      for (const pr of ordered) {
        if (scannedWorkQueuePrs.has(pr.number)) continue;
        try {
          const refs = mergedPrReferences([pr]);
          let best: PoolRow | null = null;
          for (const row of pool) {
            if (!refs.has(row.issueNumber)) continue;
            if (row.recordedAtMs > pr.mergedAtMs) continue;
            if (best === null || row.recordedAtMs > best.recordedAtMs) best = row;
          }
          if (best === null) continue;
          // A row is credited by at most one PR — drop it from the pool whether
          // or not the upgrade lands (a failed upgrade retries next tick).
          pool.splice(pool.indexOf(best), 1);
          result.candidates += 1;
          const ok = await applyConfirmedMerge(best.cycleId, best.m, pr.number, pr.headRefName);
          if (ok) result.anchorJoined += 1;
        } catch (err: any) {
          logger.error({ prNumber: pr.number, err }, "cycle-merge-reconcile: anchor-join unexpected error");
        }
      }
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
        anchorJoined: result.anchorJoined,
        listFailed: result.listFailed,
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
      movesFailed:
        result.fetchFailed + result.upgradeFailed + result.selfArmFailed + result.listFailed,
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
