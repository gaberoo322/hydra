/**
 * Autopilot data-plane endpoints (issue #430).
 *
 * After PR-3 (#383) deleted the in-process control loop, `src/cycle.ts`'s
 * header comment declared that autopilot subagents would write their own
 * cycle records into Redis. That handoff was never built: `/api/cycle/history`,
 * `/api/metrics`, and the lifetime `hydra:scheduler:cycles-*` counters were
 * all serving frozen pre-cut-over data, because nobody was writing the
 * post-cut numbers.
 *
 * This router is the missing writer. `POST /api/autopilot/cycle-record` is
 * called from `scripts/autopilot/` once per autopilot turn that dispatched a
 * code-writing subagent (a "cycle" in the post-cut sense — one autopilot
 * turn, not the deleted codex-era control-loop cycle). It performs three
 * complementary writes:
 *
 *   1. `hydra:cycle:<id>` hash + ZADD to `hydra:cycle:index` — read by
 *      `/api/cycle/history`.
 *   2. `recordCycleMetrics(cycleId, { source: "claude", ... })` — populates
 *      `hydra:metrics:<id>` (read by `/api/metrics`) and the metrics ZSET
 *      that `/api/scheduler/status.mergeRateWindow` reasons over.
 *   3. Lifetime counter increments on `hydra:scheduler:cycles-{run,merged,
 *      failed}` so the lifetime merge-rate stops being a codex-era fossil.
 *
 * The route is idempotent on `cycleId`: if the cycle hash already exists,
 * the second call is a no-op (no double counting on Phase 2 / Phase 6 retry).
 * Callers key by a stable identifier — autopilot turn ID or worktree branch
 * name — so retries collapse cleanly.
 */

import { Router } from "express";
import { redisKeys } from "../redis-keys.ts";
import {
  hashSet,
  hashGetAll,
  zAdd,
  expireKey,
  incrSchedulerCyclesRun,
  incrSchedulerCyclesMerged,
  incrSchedulerCyclesFailed,
} from "../redis-adapter.ts";
import { recordCycleMetrics } from "../metrics.ts";

const CYCLE_TTL_SECONDS = 7 * 24 * 3600; // 7 days — matches /cycle/register

// Status values that count toward `cycles-merged` (vs `cycles-failed`).
// Aligned with the autopilot taxonomy: a "cycle" merged when the dispatched
// subagent landed a PR; failed when it abandoned, timed out, or its PR
// closed unmerged.
const MERGED_STATUSES = new Set(["merged", "completed", "succeeded"]);
const FAILED_STATUSES = new Set(["failed", "abandoned", "aborted", "timeout", "timed-out"]);

interface CycleRecordBody {
  cycleId?: string;
  status?: string;
  source?: string;
  startedAt?: string;
  completedAt?: string;
  // Task accounting — used by cycle-history readers and metric trend.
  total?: number;
  completed?: number;
  failed?: number;
  abandoned?: number;
  // Metric payload (forwarded to recordCycleMetrics). Optional fields the
  // autopilot can fill in if known; absent fields default sensibly.
  anchorType?: string;
  anchorReference?: string;
  taskTitle?: string;
  tasksAttempted?: number;
  tasksMerged?: number;
  tasksFailed?: number;
  tasksAbandoned?: number;
  prNumber?: number | string;
  totalDurationMs?: number;
  costUsd?: number;
  abandonReason?: string;
  regressionIntroduced?: boolean;
  // Tags carried for free into the metric hash so dashboards can filter on
  // them later (e.g. autopilot turn ID, worktree branch).
  autopilotTurnId?: string;
  worktreeBranch?: string;
}

export function createAutopilotRouter() {
  const router = Router();

  // POST /autopilot/cycle-record — autopilot Phase 6 calls this once per
  // code-writing subagent dispatch outcome.
  //
  // Returns { ok, cycleId, status, deduped } where deduped=true means the
  // record already existed and no counters were touched.
  router.post("/autopilot/cycle-record", async (req, res) => {
    try {
      const body = (req.body || {}) as CycleRecordBody;
      const cycleId = typeof body.cycleId === "string" ? body.cycleId.trim() : "";
      if (!cycleId) {
        return res.status(400).json({ error: "Missing cycleId" });
      }

      const status = typeof body.status === "string" && body.status.length > 0
        ? body.status
        : "completed";

      // Idempotency: if the cycle hash already exists with a status, the
      // record was filed by an earlier Phase 6 call — skip all writes.
      // (Avoids double-counting on autopilot retries; see issue #430 impl
      // notes about keying by autopilot turn ID / worktree branch.)
      const existing = await hashGetAll(redisKeys.cycle(cycleId));
      if (existing && existing.status) {
        return res.json({ ok: true, cycleId, status: existing.status, deduped: true });
      }

      const source = typeof body.source === "string" && body.source.length > 0
        ? body.source
        : "claude";
      const startedAt = body.startedAt || new Date().toISOString();
      const completedAt = body.completedAt || new Date().toISOString();

      // Task counters: prefer explicit completed/failed/abandoned; fall
      // back to the metric-shape names (tasksMerged/tasksFailed/...) so
      // callers can use either vocabulary.
      const total = numberOrDefault(body.total, 1);
      const completed = numberOrDefault(body.completed ?? body.tasksMerged, 0);
      const failed = numberOrDefault(body.failed ?? body.tasksFailed, 0);
      const abandoned = numberOrDefault(body.abandoned ?? body.tasksAbandoned, 0);

      // 1. Per-cycle hash + cycle index. The hash is what `/api/cycle/history`
      //    surfaces today (via a KEYS scan in `src/cycle.ts`); the ZSET is
      //    the forward-compat index callers can paginate against.
      await hashSet(
        redisKeys.cycle(cycleId),
        "status", status,
        "startedAt", startedAt,
        "completedAt", completedAt,
        "source", source,
        "total", String(total),
        "completed", String(completed),
        "failed", String(failed),
        "abandoned", String(abandoned),
      );
      await expireKey(redisKeys.cycle(cycleId), CYCLE_TTL_SECONDS);
      await zAdd(redisKeys.cycleIndex(), Date.now(), cycleId);

      // 2. Per-cycle metric — feeds `/api/metrics` and the rolling
      //    mergeRateWindow in /scheduler/status.
      //
      // We forward only the fields the autopilot knows about; recordCycleMetrics
      // will derive qualityGateCoverage etc. on its own and stringify the rest.
      const metrics: Record<string, any> = {
        source,
        anchorType: body.anchorType,
        anchorReference: body.anchorReference,
        taskTitle: body.taskTitle,
        tasksAttempted: numberOrDefault(body.tasksAttempted, total),
        tasksMerged: numberOrDefault(body.tasksMerged ?? body.completed, completed),
        tasksFailed: numberOrDefault(body.tasksFailed ?? body.failed, failed),
        tasksAbandoned: numberOrDefault(body.tasksAbandoned ?? body.abandoned, abandoned),
        totalDurationMs: numberOrDefault(body.totalDurationMs, 0),
        prNumber: body.prNumber !== undefined ? String(body.prNumber) : undefined,
        abandonReason: body.abandonReason,
        regressionIntroduced: body.regressionIntroduced === true ? true : undefined,
        autopilotTurnId: body.autopilotTurnId,
        worktreeBranch: body.worktreeBranch,
        // costUsd — pass through if the autopilot has a surrogate; if absent,
        // recordCycleMetrics will try to compute from agent-runs (which the
        // autopilot doesn't log today, so it'll resolve to 0). #394 owns
        // the surrogate semantics; here we only forward what we're given.
        costUsd: typeof body.costUsd === "number" ? body.costUsd : undefined,
      };
      // Strip undefined fields so recordCycleMetrics's deriveQualityGateCoverage
      // doesn't see literal "undefined" strings.
      for (const k of Object.keys(metrics)) {
        if (metrics[k] === undefined) delete metrics[k];
      }
      await recordCycleMetrics(cycleId, metrics);

      // 3. Lifetime counters. cycles-run increments unconditionally so the
      //    rate denominator reflects every dispatched cycle, not just the
      //    merges. cycles-merged / cycles-failed are mutually exclusive by
      //    status bucket.
      await incrSchedulerCyclesRun();
      const lowerStatus = status.toLowerCase();
      let bucketed: "merged" | "failed" | null = null;
      if (MERGED_STATUSES.has(lowerStatus)) {
        await incrSchedulerCyclesMerged();
        bucketed = "merged";
      } else if (FAILED_STATUSES.has(lowerStatus)) {
        await incrSchedulerCyclesFailed();
        bucketed = "failed";
      }

      return res.json({ ok: true, cycleId, status, bucketed, deduped: false });
    } catch (err: any) {
      console.error(`[autopilot] cycle-record failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

function numberOrDefault(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
