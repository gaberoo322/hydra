/**
 * Autopilot Run **I/O projection coordinator** — the Redis-touching read
 * surface that powers `GET /api/autopilot/runs(/...)` and the dashboard.
 *
 * Split out of `src/autopilot/runs.ts` (issue #1183) so the lifecycle WRITES
 * (`startRun`/`endRun`/`recordTurn`/`recordCycle`/`sweepRunIfDead`/...) and the
 * read PROJECTIONS live in separate modules. This module owns the projection
 * coordinator — the raw-hash mapping + turn-join derivations:
 *
 *   - `fetchTurnsWithJoins` — turn-fetch + cycle-outcome join (Redis)
 *   - `projectRunView` — raw hash → public run view
 *   - `projectRunDigest` — raw hash + joins → history-table digest (Redis)
 *
 * The two Redis-touching projections (`fetchTurnsWithJoins`, `projectRunDigest`)
 * accept an injectable `deps` reader bag so tests can pin the projection
 * boundary without a live Redis (the default `deps` reads through the real
 * typed accessors).
 *
 * The pure, zero-I/O **run-lifecycle state machine** — `deriveLifecycleState`,
 * `summarizeTerminationHealth`, `deriveInflightSlotSeed` (+ their constants and
 * types) — was extracted into the sibling leaf `run-lifecycle-state.ts`
 * (issue #3106), following the `retro-dispatch-classifier.ts` extraction
 * precedent (#3090 / PR #3094): pure state-machine logic lives apart from the
 * I/O coordinator that calls it. This module imports DOWN from the leaf for the
 * `WEDGE_AGE_THRESHOLD_S` constant `projectRunView` still needs, and re-exports
 * that constant below so callers already resolving it through this path do not
 * churn. The three lifecycle FUNCTION re-exports (`deriveLifecycleState`,
 * `summarizeTerminationHealth`, `deriveInflightSlotSeed`) were dropped once every
 * caller migrated to importing them from the leaf directly (issue #3143), and the
 * lifecycle TYPE re-exports (`AutopilotLifecycle`, `AutopilotLifecycleState`,
 * `InflightSlotSeed`) followed for the same reason (issue #3147) — every caller
 * now imports them from the leaf.
 *
 * This Module is the canonical home for the projection-coordinator symbols. The
 * back-compat re-export relay that once forwarded them through `runs.ts` was
 * retired (issue #2125), so callers import from here directly.
 */

import {
  getCycleHashesBatch,
} from "../redis/cycle-tracking.ts";
import {
  listAutopilotRunTurnsDesc,
  listPrLifecycleEventsSince,
} from "../redis/autopilot-runs.ts";
import { osHeartbeatAgeS, isOsHeartbeatStale } from "./os-heartbeat.ts";
import { bucketCycleStatus } from "./cycle-status.ts";
import type { PrLifecycleMergeEvent } from "./pr-lifecycle-snapshot.ts";
import { isLivePid } from "../process-probe.ts";
import { WEDGE_AGE_THRESHOLD_S } from "./run-lifecycle-state.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Back-compat re-export relay (issue #3106, #2125 migration window)
//
// The pure run-lifecycle state machine now lives in `run-lifecycle-state.ts`.
// `projectRunView` in this module still reads `WEDGE_AGE_THRESHOLD_S`, so that
// constant is re-exported here to preserve the public surface at this import
// path. The three lifecycle FUNCTIONS were dropped from the relay once every
// caller migrated to the leaf (issue #3143); the lifecycle TYPES followed for
// the same reason (issue #3147). New callers of the state machine SHOULD import
// from `run-lifecycle-state.ts`.
// ---------------------------------------------------------------------------
export {
  WEDGE_AGE_THRESHOLD_S,
} from "./run-lifecycle-state.ts";

// ---------------------------------------------------------------------------
// Constants (read-side)
// ---------------------------------------------------------------------------

/**
 * Soft cap on turns the detail endpoint / digest projection will fetch
 * per run. Run TTL is 7d and token budgets keep autopilot runs well
 * under a few hundred turns; 10k is two orders of magnitude above that
 * ceiling so the cap only bites pathological data. Keeps Redis's LIMIT
 * arg inside the 64-bit signed-int comfort zone.
 */
export const RUN_TURNS_MAX_FETCH = 10000;

// `WEDGE_AGE_THRESHOLD_S` now lives in the `run-lifecycle-state.ts` leaf
// (issue #3106) and is imported DOWN above; `projectRunView` reads it and the
// re-export relay preserves the public surface at this path.

// ---------------------------------------------------------------------------
// Read-only leaf helpers
// ---------------------------------------------------------------------------

/**
 * `kill -0 pid` liveness probe. Returns true iff the pid is alive AND
 * we have permission to signal it (EPERM = alive-from-our-perspective).
 * An invalid pid (`!Number.isFinite || pid <= 0`) is treated as alive so the
 * sweeper doesn't promote rows from older writers that never stamped a pid.
 *
 * This is now a re-export of the canonical {@link isLivePid} predicate in
 * src/process-probe.ts (consolidated in issue #2816, extracted to its focused
 * leaf in issue #3503 — the semantics were
 * already identical here; the two former unguarded copies in src/index.ts and
 * scripts/ci/branch-prune-runner.ts diverged only on non-finite pids). The
 * `isPidAlive` name is kept as an alias so the ~6 downstream deps-bag
 * references (runs.ts, sweep-reader.ts, cycle-close.ts + their tests, all keyed
 * on the field name `isPidAlive`) do not churn; the rename is an opportunistic
 * follow-up, out of scope here.
 */
export const isPidAlive = isLivePid;

/**
 * Parse a persisted `crash_detail` JSON string back into an object for the
 * read projection. A missing / unparseable value yields `null` (treated as
 * "no crash detail captured") rather than throwing — the read surface must
 * stay loud-but-non-fatal.
 */
function parseCrashDetail(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    logger.error({ err }, "[autopilot] failed to parse crash_detail");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Injectable reader deps (so projections are testable without Redis)
// ---------------------------------------------------------------------------

/**
 * Reader seam for the two Redis-touching projections. Defaults to the real
 * typed accessors; tests pass a stub bag to pin the join/digest boundary
 * without a live Redis. Kept narrow — only the reads the projections perform.
 */
export interface ProjectionDeps {
  listTurnsDesc: (runId: string, limit: number) => Promise<string[]>;
  getCycleHashesBatch: (cycleIds: string[]) => Promise<Record<string, Record<string, string>>>;
  /**
   * Read `pr_lifecycle` events off the slot-events stream at/after an epoch
   * (issue #4700) — the LIVE arm of `merged_count` for unstamped rows (a
   * running run, one swept dead, or a pre-#4700 legacy row). Defaults to the
   * typed accessor under src/redis/ (`listPrLifecycleEventsSince`); the
   * events are folded by the PURE `countWindowMerges`.
   */
  listPrLifecycleEvents: (fromEpochS: number) => Promise<PrLifecycleMergeEvent[]>;
}

export const defaultProjectionDeps: ProjectionDeps = {
  listTurnsDesc: listAutopilotRunTurnsDesc,
  getCycleHashesBatch,
  listPrLifecycleEvents: listPrLifecycleEventsSince,
};

// ---------------------------------------------------------------------------
// Projection: turn-join
// ---------------------------------------------------------------------------

/**
 * Read the latest `limit` turn rows for a run (descending by turn_n)
 * and attach cycle-record outcomes onto `action.type === "dispatch"`
 * actions.
 *
 * Each dispatch action may carry `cycleId` or `autopilotTurnId`. When
 * neither is present, we prefer the action's `worktreeBranch` — the
 * deterministic, run-scoped, `parseDispatchCycleId`-clean id `decide.py`
 * stamps on EVERY dispatch action (`_synthesize_worktree_branch`) and that
 * `reap.py` now keys its `hydra:cycle:*` write on (issue #3785; see that
 * issue for the root-cause writeup — live dispatch actions carry
 * `cycleId: null` and no `autopilotTurnId`, so without this the join
 * previously always fell through to the synthetic fallback below, which
 * matches no Redis key). Only when NONE of the three are present do we
 * synthesise `<run_id>:<turn_n>:<index>` — mirroring how `reap.py` /
 * `dispatch.sh` allocate cycle IDs for a dispatch action carrying no
 * identifier at all. Missing cycles surface as `outcome: null` (UI renders
 * "pending").
 *
 * O(turns + dispatches) Redis round-trips via the pipelined
 * `getCycleHashesBatch`. `deps` is injectable so the join boundary can
 * be pinned without Redis.
 */
export async function fetchTurnsWithJoins(
  runId: string,
  limit: number,
  deps: ProjectionDeps = defaultProjectionDeps,
): Promise<Array<Record<string, unknown>>> {
  const raw = await deps.listTurnsDesc(runId, limit);
  if (!raw || raw.length === 0) return [];

  const turns: Array<Record<string, unknown>> = [];
  const cycleIdsToFetch: string[] = [];

  for (const member of raw) {
    let parsed: any;
    try {
      parsed = JSON.parse(member);
    } catch (err) {
      logger.error({ err }, "[autopilot] failed to parse turn member");
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const turnN = Number(parsed.turn_n || 0);
    const actions: any[] = Array.isArray(parsed.actions) ? parsed.actions : [];
    actions.forEach((a, idx) => {
      if (a && a.type === "dispatch") {
        const cid =
          (typeof a.cycleId === "string" && a.cycleId) ||
          (typeof a.autopilotTurnId === "string" && a.autopilotTurnId) ||
          (typeof a.worktreeBranch === "string" && a.worktreeBranch) ||
          `${runId}:${turnN}:${idx}`;
        a._cycleId = cid;
        cycleIdsToFetch.push(cid);
      }
    });
    turns.push(parsed);
  }

  const cycleMap = await deps.getCycleHashesBatch(cycleIdsToFetch);

  for (const turn of turns) {
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    for (const a of actions) {
      if (a && a.type === "dispatch") {
        const cid = a._cycleId;
        delete a._cycleId;
        const hash = cycleMap[cid];
        if (hash) {
          a.outcome = {
            cycleId: cid,
            status: hash.status || "unknown",
            prNumber: hash.prNumber || hash.pr_number || null,
            filesChanged: hash.filesChanged || null,
            startedAt: hash.startedAt || null,
            completedAt: hash.completedAt || null,
          };
        } else {
          a.outcome = null;
        }
      }
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Projection: run view
// ---------------------------------------------------------------------------

/**
 * Project a raw Redis hash into the public response shape: parse JSON
 * limits, coerce numeric fields, compute elapsed_s / age_s, and on
 * `running` rows compute pid_alive + wedge_likely.
 *
 * `wedge_likely` cross-checks the OS heartbeat (#1091): the per-turn
 * `last_heartbeat_epoch` only refreshes at `recordTurn` close, so a run
 * mid-turn on slow background subagents has a stale `age_s` even while the
 * control loop is alive. We only flag a wedge when BOTH the per-turn
 * heartbeat AND the continuously-written OS heartbeat
 * (`/tmp/hydra-autopilot-heartbeat.txt`) are stale. `readOsHbAgeS` is
 * injectable for tests; the default reads the real heartbeat file and
 * fails open (unreadable → treated as stale).
 */
export function projectRunView(
  row: Record<string, string>,
  readOsHbAgeS: (nowS: number) => number | null = osHeartbeatAgeS,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const startedEpoch = Number(row.started_epoch || "0");
  const lastHb = Number(row.last_heartbeat_epoch || row.started_epoch || "0");
  const endedEpoch = row.ended_epoch ? Number(row.ended_epoch) : undefined;

  let limits: unknown = {};
  if (row.limits) {
    try {
      limits = JSON.parse(row.limits);
    } catch (err) {
      logger.error({ err }, "[autopilot] corrupt limits JSON in run row — degrading to {}");
      limits = {};
    }
  }

  const status = row.status || "running";
  const elapsedS =
    endedEpoch !== undefined ? Math.max(0, endedEpoch - startedEpoch) : Math.max(0, now - startedEpoch);
  const ageS = Math.max(0, now - lastHb);

  const view: Record<string, unknown> = {
    run_id: row.run_id || "",
    started: row.started || "",
    started_epoch: startedEpoch,
    status,
    trigger: row.trigger || "manual",
    pid: Number(row.pid || "0"),
    limits,
    turns: Number(row.turns || "0"),
    dispatches: Number(row.dispatches || "0"),
    cumulative_tokens: Number(row.cumulative_tokens || "0"),
    idle_turns: Number(row.idle_turns || "0"),
    last_heartbeat_epoch: lastHb,
    elapsed_s: elapsedS,
    age_s: ageS,
  };

  if (row.term_reason) view.term_reason = row.term_reason;
  if (endedEpoch !== undefined) view.ended_epoch = endedEpoch;
  if (row.exit_code !== undefined) view.exit_code = Number(row.exit_code);
  // Issue #1079: surface the durable crash snapshot on the run-detail view +
  // retro bundle (both read through this projection). Parsed back from the
  // persisted JSON string; absent / unparseable → field omitted.
  const crashDetail = parseCrashDetail(row.crash_detail);
  if (crashDetail) view.crash_detail = crashDetail;

  if (status === "running") {
    const pid = Number(row.pid || "0");
    view.pid_alive = isPidAlive(pid);
    // #1091: only a wedge when BOTH heartbeats are stale. A fresh OS
    // heartbeat means the loop is alive even though the per-turn heartbeat
    // (refreshed only at recordTurn close) lags during a long turn.
    const perTurnStale = ageS > WEDGE_AGE_THRESHOLD_S;
    const osStale = isOsHeartbeatStale(readOsHbAgeS(now), WEDGE_AGE_THRESHOLD_S);
    view.wedge_likely = perTurnStale && osStale;
  }

  return view;
}

// ---------------------------------------------------------------------------
// Projection: run digest
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// merged_count: pure window fold (issue #4700)
// ---------------------------------------------------------------------------

/**
 * The number of distinct `repo#pr_number` keys among `pr_lifecycle`
 * slot-events with `transition === "merged"` whose `merged_at` epoch lies in
 * `[startedEpochS, endedEpochS]` (inclusive both ends).
 *
 * This is the ONE pure fold shared by both merged_count writers (design
 * concept INV-7): endRun's first-terminal-write stamp (`src/autopilot/runs.ts`)
 * and this module's digest live arm. Rules, per the approved design concept:
 *
 * - Credited ONLY via `merged_at` (GitHub's `mergedAt`). Events with a
 *   missing / empty / unparseable `merged_at` are IGNORED — never
 *   window-joined on `ts_epoch` or the stream id. Measured on the live
 *   stream (2026-09-28): every orchestrator restart replays ~80-90 `merged`
 *   events for already-merged PRs stamped with the restart's `ts_epoch`
 *   (the bridge's first tick diffs against an empty snapshot), so an
 *   emission-time join would credit ~90 phantom merges per deploy. The
 *   `ts_epoch` field is carried on the input type precisely so tests can
 *   pin that it is never consulted.
 * - Dedup key is `${repo}#${pr_number}`: restart-burst replays of the same
 *   PR count once, and PR numbers — which are only unique WITHIN a repo —
 *   never collide across the orchestrator/target repos the bridge polls.
 * - `repo` filter: NONE. The run record does not name a repo, so any PR the
 *   bridge watches that merges inside the window is credited, regardless of
 *   who armed the merge (plan-level auto-merge OR a qa_orch subagent's
 *   hydra-qa step-10 PASS routing — the normal orch landing path, which
 *   writes no auto-merge action at all).
 */
export function countWindowMerges(
  events: PrLifecycleMergeEvent[],
  startedEpochS: number,
  endedEpochS: number,
): number {
  const seen = new Set<string>();
  for (const ev of events) {
    if (!ev || ev.transition !== "merged") continue;
    // INV-2: no usable merged_at → ignored. Deliberately no ts_epoch
    // fallback — see the doc comment above.
    const mergedAt = Number(ev.merged_at);
    if (!Number.isFinite(mergedAt) || !Number.isInteger(mergedAt) || mergedAt <= 0) continue;
    if (mergedAt < startedEpochS || mergedAt > endedEpochS) continue;
    const prNumber = String(ev.pr_number ?? "").trim();
    if (prNumber === "") continue;
    seen.add(`${ev.repo}#${prNumber}`);
  }
  return seen.size;
}

/**
 * Project a single run hash + its joined turns into the digest shape
 * used by the history table. One turn-fetch per run, reusing the same
 * joins we'd do for the live page. `deps` is injectable so the digest
 * boundary can be pinned without Redis.
 *
 * `merged_count` (issue #4700 — SUPERSEDES the #4343 definition): the
 * number of distinct `repo#pr_number` keys among slot-events with
 * event=pr_lifecycle, transition=merged, whose `merged_at` epoch lies in
 * [run.started_epoch, run.ended_epoch] (or [started_epoch, now] for a
 * running run). It counts merge EVENTS — PRs that actually merged inside
 * the window, from every repo the PR Lifecycle Bridge polls, regardless of
 * who armed the merge — NOT #4343's armed auto-merge DECISIONS (an armed
 * PR that merges in-window is already an event; one that never merges
 * should not count; #4700 measured a run that shipped two PRs via qa_orch's
 * hydra-qa step-10 PASS routing reading `merged_count: 0`).
 *
 * Durability: the slot-events stream retains only ~1 day (MAXLEN ~1000;
 * restart replay bursts dominate it) while run hashes live 7 days, so
 * endRun computes the window count ONCE at its first terminal write and
 * stamps `merged_count` onto the run hash in the same field write as
 * status/term_reason/ended_epoch (a deduped endRun and amendRunTally never
 * write or recompute it — first-wins, like term_reason). This digest reads
 * the stamped `row.merged_count` when present and a finite non-negative
 * integer; otherwise — a running run, a run swept dead by sweepRunIfDead,
 * or a pre-#4700 legacy row — it computes the window count live from the
 * stream via `deps.listPrLifecycleEvents` + the shared PURE
 * {@link countWindowMerges}. A stream read failure logs with context and
 * yields 0 (never throws); a row with no usable `started_epoch` (<= 0)
 * skips the live arm rather than widening the window to the whole stream.
 *
 * Known, accepted undercount: a merge whose poll lands after run-end (at
 * most one 60s bridge poll interval) is not stamped for that run — the
 * stamp is computed at run end. It is documented here, not engineered
 * around. `state.json` `merged_prs` / `terminate.merged_prs` is NOT read
 * anywhere (operator direction on #4700; #4343 established nothing in
 * scripts/ writes it deterministically).
 *
 * `failed_count` is UNCHANGED: still the count of dispatch actions whose
 * joined outcome buckets to `"failed"` via `bucketCycleStatus` — a failed
 * dispatch is a real per-run failure regardless of class.
 */
/**
 * The slot-events stream retains ~1 day (MAXLEN ~1000). A run window that
 * ended before this cutoff cannot reliably be recovered from the stream, so an
 * UNSTAMPED such row (pre-#4700 legacy) that folds to 0 is marked
 * `merged_count_source: "unavailable-outside-retention"` rather than being
 * read as a live 0 (issue #4700 QA round 2).
 */
export const SLOT_EVENTS_RETENTION_S = 24 * 60 * 60;

function isOutsideSlotEventsRetention(windowEndEpochS: number): boolean {
  return Math.floor(Date.now() / 1000) - windowEndEpochS > SLOT_EVENTS_RETENTION_S;
}

export async function projectRunDigest(
  runId: string,
  row: Record<string, string>,
  deps: ProjectionDeps = defaultProjectionDeps,
): Promise<Record<string, unknown>> {
  const turns = await fetchTurnsWithJoins(runId, RUN_TURNS_MAX_FETCH, deps);

  const startedEpoch = Number(row.started_epoch || "0");
  const endedEpoch = row.ended_epoch ? Number(row.ended_epoch) : null;

  // merged_count: the endRun STAMP wins whenever it is present and a valid
  // count; only unstamped rows (running / swept-dead / pre-#4700 legacy)
  // pay for a live stream read.
  const stamped = row.merged_count !== undefined && row.merged_count !== ""
    ? Number(row.merged_count)
    : NaN;
  let merged: number;
  let mergedSource: "stamped" | "live" | "unavailable-outside-retention" = "live";
  if (Number.isFinite(stamped) && Number.isInteger(stamped) && stamped >= 0) {
    merged = stamped;
    mergedSource = "stamped";
  } else {
    merged = 0;
    if (Number.isFinite(startedEpoch) && startedEpoch > 0) {
      const windowEnd =
        endedEpoch !== null && Number.isFinite(endedEpoch) && endedEpoch >= startedEpoch
          ? endedEpoch
          : Math.floor(Date.now() / 1000);
      try {
        const events = await deps.listPrLifecycleEvents(startedEpoch);
        merged = countWindowMerges(events, startedEpoch, windowEnd);
      } catch (err: any) {
        logger.error(
          { runId, startedEpoch, windowEnd, err },
          "[run-projections] live merged_count slot-events read failed; reporting 0",
        );
        merged = 0;
      }
      // A zero from a window older than the stream's retention is not
      // evidence of "no merges" - mark it explicitly. A nonzero live count
      // (stream still holds the events) is trusted as-is.
      if (merged === 0 && isOutsideSlotEventsRetention(windowEnd)) {
        mergedSource = "unavailable-outside-retention";
      }
    }
  }

  let failed = 0;
  for (const turn of turns) {
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    for (const a of actions) {
      if (!a || typeof a !== "object") continue;
      if (a.type === "dispatch" && a.outcome && typeof a.outcome === "object") {
        const bucket = bucketCycleStatus(String((a.outcome as any).status || ""));
        if (bucket === "failed") failed += 1;
      }
    }
  }

  const durationS =
    endedEpoch !== null && Number.isFinite(endedEpoch) && endedEpoch > startedEpoch
      ? endedEpoch - startedEpoch
      : row.status === "running"
        ? Math.max(0, Math.floor(Date.now() / 1000) - startedEpoch)
        : null;

  return {
    run_id: row.run_id || runId,
    started: row.started || "",
    started_epoch: startedEpoch,
    ended_epoch: endedEpoch,
    duration_s: durationS,
    status: row.status || "running",
    term_reason: row.term_reason || null,
    trigger: row.trigger || "manual",
    turns: Number(row.turns || "0"),
    dispatches: Number(row.dispatches || "0"),
    merged_count: merged,
    merged_count_source: mergedSource,
    failed_count: failed,
    total_tokens: Number(row.cumulative_tokens || "0"),
    exit_code: row.exit_code !== undefined ? Number(row.exit_code) : null,
  };
}
