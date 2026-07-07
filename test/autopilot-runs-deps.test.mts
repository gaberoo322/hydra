/**
 * Issue #2158 — the injectable-deps seam on src/autopilot/runs.ts.
 *
 * The run-lifecycle WRITERS (startRun / endRun / recordCycle / recordTurn /
 * sweepRunIfDead) own real write POLICY: idempotency keying, the #2063
 * enrichment-vs-dedup gate, the #1919 three-bucket counter identity, and the
 * dead-pid running→killed/crash sweep. Before #2158 every test of that policy
 * (autopilot-runs.test.mts, autopilot-cycle-records.test.mts) had to stand up a
 * `new Redis(REDIS_URL)` in a `beforeEach`. This suite exercises the SAME policy
 * on an IN-MEMORY deps fixture — no live Redis, no clock — which is the whole
 * point of the seam.
 *
 * Invariants asserted (from the approved design concept):
 *   - startRun idempotency (deduped:true keeps the original row).
 *   - endRun keeps the FIRST terminal term_reason; 404 on unknown / clean drop
 *     of crash_detail; crash persists crash_detail.
 *   - recordCycle counters fire EXACTLY ONCE per cycleId; the #1919 identity
 *     (run == merged + failed + unaccounted); the #2063 enrich-vs-dedup gate
 *     (a duplicate with new files enriches WITHOUT re-firing a counter).
 *   - recordTurn idempotency on (runId, turn_n) and counter updates.
 *   - sweepRunIfDead's dead-pid branch is reachable purely by INJECTING
 *     isPidAlive=false on a synthetic running row — never by faking a real PID.
 *   - The injected `now()` clock is the single source of truth for both the
 *     `*_epoch` seconds fields and the ISO timestamps.
 *
 * Pure → no Redis. This file deliberately imports the writers directly from
 * src/autopilot/runs.ts and passes a fabricated `AutopilotRunsDeps`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  startRun,
  endRun,
  recordTurn,
  type AutopilotRunsDeps,
} from "../src/autopilot/runs.ts";
// getRunDispatchClasses (a composite READ orchestrator) was extracted into the
// sibling run-reads Module (issue #2904 — completing the write/read split #1183
// began and #2568 extended). Its injectable DispatchClassesDeps seam is
// unchanged, so the getRunDispatchClasses cases below pass their stub as before.
import { getRunDispatchClasses } from "../src/autopilot/run-reads.ts";
// recordCycle (the cross-domain cycle-close coordinator) + UNCLASSIFIED_ANCHOR_TYPE
// + the CycleCloseDeps bag moved to the sibling cycle-close Module (#2768). The
// fixture below builds a single object satisfying BOTH AutopilotRunsDeps (the
// run/turn writers + sweeper) and CycleCloseDeps (recordCycle), so it is passed
// to each writer unchanged — this suite exercises the same policy across both.
import {
  recordCycle,
  UNCLASSIFIED_ANCHOR_TYPE,
  type CycleCloseDeps,
} from "../src/autopilot/cycle-close.ts";
// sweepRunIfDead was extracted into the sibling sweep-reader Module (#2568).
// The wide fixture makeDeps() builds still structurally satisfies the sweeper's
// narrow SweepReaderDeps, so the fixture is passed unchanged.
import { sweepRunIfDead } from "../src/autopilot/sweep-reader.ts";

// ---------------------------------------------------------------------------
// In-memory deps fixture — a tiny store standing in for the Redis Adapters.
// ---------------------------------------------------------------------------

interface MemStore {
  runs: Map<string, Record<string, string>>;
  runIndex: Map<string, number>;
  runTurns: Map<string, Set<number>>;
  cycles: Map<string, Record<string, string>>;
  cycleIndex: Map<string, number>;
  metrics: Map<string, Record<string, string>>;
  counters: Record<string, number>;
  /** Issue #2942: the per-dispatch outcome-record store fake. */
  outcomes: Map<string, Record<string, unknown>>;
  /**
   * Issue #2956: captures the args of each stampWorklessHint call so endRun's
   * zero-dispatch idle-stamp path is assertable without Redis. Empty = never
   * stamped.
   */
  worklessStamps: Array<{ worklessUntilMs: number; nowMs: number }>;
}

function newStore(): MemStore {
  return {
    runs: new Map(),
    runIndex: new Map(),
    runTurns: new Map(),
    cycles: new Map(),
    cycleIndex: new Map(),
    metrics: new Map(),
    counters: { run: 0, merged: 0, failed: 0, unaccounted: 0 },
    outcomes: new Map(),
    worklessStamps: [],
  };
}

interface FixtureOpts {
  /** Fixed clock value (epoch-ms). Defaults to a stable constant. */
  nowMs?: number;
  /** Liveness override. Defaults to "every pid is alive". */
  isPidAlive?: (pid: number) => boolean;
}

const FIXED_NOW_MS = 1_750_000_000_000; // 2025-06-15T14:13:20.000Z, stable.

function makeDeps(store: MemStore, opts: FixtureOpts = {}): AutopilotRunsDeps & CycleCloseDeps {
  const nowMs = opts.nowMs ?? FIXED_NOW_MS;
  return {
    runs: {
      async getAutopilotRun(runId) {
        return { ...(store.runs.get(runId) ?? {}) };
      },
      async initAutopilotRun(runId, fields) {
        store.runs.set(runId, { ...fields });
      },
      async updateAutopilotRunFields(runId, fields) {
        const existing = store.runs.get(runId) ?? {};
        store.runs.set(runId, { ...existing, ...fields });
      },
      async setAutopilotRunField(runId, field, value) {
        const existing = store.runs.get(runId) ?? {};
        existing[field] = value;
        store.runs.set(runId, existing);
      },
      async incrAutopilotRunField(runId, field, by) {
        const existing = store.runs.get(runId) ?? {};
        existing[field] = String(Number(existing[field] || "0") + by);
        store.runs.set(runId, existing);
      },
      async refreshAutopilotRunTTL() {
        /* no-op in memory */
      },
      async addAutopilotRunToIndex(runId, scoreEpochSeconds) {
        store.runIndex.set(runId, scoreEpochSeconds);
      },
      async addAutopilotRunTurn(runId, turnN) {
        const set = store.runTurns.get(runId) ?? new Set<number>();
        set.add(turnN);
        store.runTurns.set(runId, set);
      },
      async hasAutopilotRunTurnAt(runId, turnN) {
        return store.runTurns.get(runId)?.has(turnN) ?? false;
      },
    },
    cycle: {
      async getCycleHash(cycleId) {
        return { ...(store.cycles.get(cycleId) ?? {}) };
      },
      async initCycleHash(cycleId, fields) {
        store.cycles.set(cycleId, { ...fields });
      },
      async addCycleToIndex(cycleId, score) {
        store.cycleIndex.set(cycleId, score);
      },
      // Issue #2860: additive HSET onto the cycle-hash, used only by the
      // completed→merged status upgrade on the dedup path.
      async updateCycleHash(cycleId, fields) {
        const existing = store.cycles.get(cycleId) ?? {};
        store.cycles.set(cycleId, { ...existing, ...fields });
      },
    },
    scheduler: {
      async incrSchedulerCyclesRun() {
        return ++store.counters.run;
      },
      async incrSchedulerCyclesMerged() {
        return ++store.counters.merged;
      },
      async incrSchedulerCyclesFailed() {
        return ++store.counters.failed;
      },
      async incrSchedulerCyclesUnaccounted() {
        return ++store.counters.unaccounted;
      },
    },
    metrics: {
      async recordCycleMetrics(cycleId, metrics) {
        const existing = store.metrics.get(cycleId) ?? {};
        for (const [k, v] of Object.entries(metrics)) {
          if (v === undefined) continue;
          existing[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
        }
        store.metrics.set(cycleId, existing);
      },
    },
    // Issue #2942: the per-dispatch outcome-record seam fake.
    dispatchOutcomes: {
      async put(record) {
        store.outcomes.set(record.cycleId, { ...record });
        return { ok: true as const };
      },
      async upgrade(cycleId, patch) {
        const existing = store.outcomes.get(cycleId) ?? { cycleId };
        store.outcomes.set(cycleId, { ...existing, ...patch });
        return { ok: true as const };
      },
      async readCycleTokens() {
        return null;
      },
    },
    isPidAlive: opts.isPidAlive ?? (() => true),
    now: () => nowMs,
    // Issue #2956: capture-only fake for the workless-hint stamp so endRun's
    // idle path is assertable without Redis.
    async stampWorklessHint(worklessUntilMs, nowMsArg) {
      store.worklessStamps.push({ worklessUntilMs, nowMs: nowMsArg });
      return worklessUntilMs;
    },
  };
}

// ---------------------------------------------------------------------------
// startRun
// ---------------------------------------------------------------------------

describe("startRun — injected deps, no Redis (#2158)", () => {
  test("writes the run hash + index on a fresh run, with the injected clock", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const r = await startRun(
      { run_id: "run-a", trigger: "manual", limits: { token_budget: 5 } } as any,
      deps,
    );
    assert.equal(r.ok, true);
    assert.equal((r as any).deduped, false);

    const row = store.runs.get("run-a")!;
    assert.equal(row.status, "running");
    assert.equal(row.trigger, "manual");
    // started_epoch derives from the injected clock (seconds).
    assert.equal(row.started_epoch, String(Math.floor(FIXED_NOW_MS / 1000)));
    // started ISO derives from the SAME injected clock — one source of truth.
    assert.equal(row.started, new Date(FIXED_NOW_MS).toISOString());
    assert.equal(row.turns, "0");
    assert.equal(store.runIndex.get("run-a"), Math.floor(FIXED_NOW_MS / 1000));
  });

  test("is idempotent on run_id — re-start is a no-op that preserves counters", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-b", limits: {} } as any, deps);
    // Mutate a counter on the row; a dedup re-start must not clobber it.
    store.runs.get("run-b")!.cumulative_tokens = "999";

    const r = await startRun({ run_id: "run-b", limits: {} } as any, deps);
    assert.equal((r as any).deduped, true);
    assert.equal(store.runs.get("run-b")!.cumulative_tokens, "999");
  });
});

// ---------------------------------------------------------------------------
// endRun
// ---------------------------------------------------------------------------

describe("endRun — injected deps (#2158)", () => {
  test("transitions running → ended with the term_reason from cause", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-c", limits: {} } as any, deps);

    const r = await endRun({ run_id: "run-c", cause: "budget" } as any, deps);
    assert.equal(r.ok, true);
    assert.equal((r as any).status, "ended");
    assert.equal((r as any).term_reason, "budget");
    const row = store.runs.get("run-c")!;
    assert.equal(row.status, "ended");
    assert.equal(row.term_reason, "budget");
    // ended_epoch defaulted from the injected clock.
    assert.equal(row.ended_epoch, String(Math.floor(FIXED_NOW_MS / 1000)));
  });

  test("keeps the FIRST terminal term_reason on a re-end (idempotent)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-d", limits: {} } as any, deps);
    await endRun({ run_id: "run-d", cause: "wall_clock" } as any, deps);

    const r = await endRun({ run_id: "run-d", cause: "idle" } as any, deps);
    assert.equal((r as any).deduped, true);
    assert.equal((r as any).term_reason, "wall_clock");
    assert.equal(store.runs.get("run-d")!.term_reason, "wall_clock");
  });

  test("404s on an unknown run_id", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const r = await endRun({ run_id: "ghost", cause: "budget" } as any, deps);
    assert.equal(r.ok, false);
    assert.equal((r as any).code, "not-found");
  });

  test("crash persists crash_detail; a clean stop never does", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-crash", limits: {} } as any, deps);
    await endRun(
      {
        run_id: "run-crash",
        cause: "crash",
        crash_detail: { signal: "SEGV", exit_code: 139, log_tail: "boom" },
      } as any,
      deps,
    );
    const crashed = JSON.parse(store.runs.get("run-crash")!.crash_detail);
    assert.equal(crashed.signal, "SEGV");

    await startRun({ run_id: "run-clean", limits: {} } as any, deps);
    await endRun(
      { run_id: "run-clean", cause: "budget", crash_detail: { signal: "SEGV" } } as any,
      deps,
    );
    assert.equal(store.runs.get("run-clean")!.crash_detail, undefined);
  });

  // Issue #2956 — workless-board backoff hint stamped on a zero-dispatch idle exit.
  test("idle exit with ZERO dispatches stamps a future workless hint", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-idle0", limits: {} } as any, deps); // seeds dispatches:"0"

    await endRun({ run_id: "run-idle0", cause: "idle" } as any, deps);
    assert.equal(store.worklessStamps.length, 1, "should stamp exactly once");
    const stamp = store.worklessStamps[0];
    assert.equal(stamp.nowMs, FIXED_NOW_MS);
    // A FUTURE instant (now + the backoff window).
    assert.ok(stamp.worklessUntilMs > FIXED_NOW_MS, "hint must be in the future");
  });

  test("idle exit WITH dispatches (>0) does NOT stamp — real work was available", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-idleN", limits: {} } as any, deps);
    // Simulate a run that dispatched during its life.
    store.runs.get("run-idleN")!.dispatches = "3";

    await endRun({ run_id: "run-idleN", cause: "idle" } as any, deps);
    assert.equal(store.worklessStamps.length, 0, "a run that dispatched must launch normally");
  });

  test("a NON-idle exit (budget) never stamps a workless hint", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-budget", limits: {} } as any, deps);

    await endRun({ run_id: "run-budget", cause: "budget" } as any, deps);
    assert.equal(store.worklessStamps.length, 0);
  });

  test("an unparseable dispatches count fails SAFE to had-work (no stamp)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-garbage", limits: {} } as any, deps);
    store.runs.get("run-garbage")!.dispatches = "not-a-number";

    await endRun({ run_id: "run-garbage", cause: "idle" } as any, deps);
    assert.equal(store.worklessStamps.length, 0, "garbage count must not suppress launch");
  });
});

// ---------------------------------------------------------------------------
// recordCycle — counters, bucketing identity (#1919), enrichment gate (#2063)
// ---------------------------------------------------------------------------

describe("recordCycle — injected deps (#2158)", () => {
  test("a merged record bumps run + merged exactly once and writes all three surfaces", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const r = await recordCycle(
      { cycleId: "c-merged", status: "merged", prNumber: 7, filesChanged: 3 } as any,
      deps,
    );
    assert.equal((r as any).bucketed, "merged");
    assert.equal((r as any).deduped, false);
    assert.equal((r as any).enriched, false);
    assert.equal(store.counters.run, 1);
    assert.equal(store.counters.merged, 1);
    assert.equal(store.counters.failed, 0);
    assert.equal(store.cycles.get("c-merged")!.status, "merged");
    assert.equal(store.metrics.get("c-merged")!.filesChanged, "3");
    assert.equal(store.metrics.get("c-merged")!.prNumber, "7");
    // Cycle hash startedAt/completedAt default to the injected clock's ISO.
    assert.equal(store.cycles.get("c-merged")!.startedAt, new Date(FIXED_NOW_MS).toISOString());
  });

  test("re-posting the same cycleId does NOT double-count (fire-exactly-once)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const body = { cycleId: "c-dup", status: "merged" } as any;
    await recordCycle(body, deps);
    const r2 = await recordCycle(body, deps);
    assert.equal((r2 as any).deduped, true);
    assert.equal((r2 as any).bucketed, null);
    assert.equal(store.counters.run, 1, "run counter fires once");
    assert.equal(store.counters.merged, 1, "merged counter fires once");
  });

  test("the #1919 identity holds on a mixed batch: run == merged + failed + unaccounted", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const statuses = [
      "merged", "completed", "succeeded",   // 3 merged
      "failed", "abandoned", "timeout",     // 3 failed
      "no-op", "idle",                      // 2 unaccounted
    ];
    for (let i = 0; i < statuses.length; i++) {
      await recordCycle({ cycleId: `c-mix-${i}`, status: statuses[i] } as any, deps);
    }
    assert.equal(store.counters.run, statuses.length);
    assert.equal(store.counters.merged, 3);
    assert.equal(store.counters.failed, 3);
    assert.equal(store.counters.unaccounted, 2);
    assert.equal(
      store.counters.run,
      store.counters.merged + store.counters.failed + store.counters.unaccounted,
    );
  });

  test("the #2063 enrich path updates filesChanged WITHOUT re-firing a counter", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // Phase 1 — reap-time write: status only, no PR/files.
    await recordCycle({ cycleId: "c-enrich", status: "completed" } as any, deps);
    assert.equal(store.counters.run, 1);
    assert.equal(store.counters.merged, 1);
    assert.equal(store.metrics.get("c-enrich")?.filesChanged, undefined);

    // Phase 2 — auto-merge follow-up: now PR-aware, with a file count.
    const r2 = await recordCycle(
      { cycleId: "c-enrich", status: "merged", prNumber: 42, filesChanged: 4 } as any,
      deps,
    );
    assert.equal((r2 as any).deduped, true, "count/bucket surface still no-ops");
    assert.equal((r2 as any).bucketed, null);
    assert.equal((r2 as any).enriched, true, "metrics hash was enriched");
    // Counters did NOT advance.
    assert.equal(store.counters.run, 1);
    assert.equal(store.counters.merged, 1);
    // But the metrics hash now carries the enriched fields.
    assert.equal(store.metrics.get("c-enrich")!.filesChanged, "4");
    assert.equal(store.metrics.get("c-enrich")!.prNumber, "42");
  });

  test("a plain duplicate carrying no new data stays enriched:false", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const body = { cycleId: "c-plain", status: "merged" } as any;
    await recordCycle(body, deps);
    const r2 = await recordCycle(body, deps);
    assert.equal((r2 as any).deduped, true);
    assert.equal((r2 as any).enriched, false);
  });

  test("an explicit filesChanged=0 records a measured zero", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle({ cycleId: "c-zero", status: "merged", filesChanged: 0 } as any, deps);
    assert.equal(store.metrics.get("c-zero")!.filesChanged, "0");
  });

  // Issue #2364: the dedup/enrichment path must forward a non-zero
  // totalDurationMs so the post-merge follow-up's real wall-clock span reaches
  // the metrics hash when the reap-time `completed` write recorded a 0 (or never
  // wrote a duration). recordCycleMetrics enforces monotonic-max separately
  // (tested against real Redis in cycle-metrics-monotonic-duration.test.mts);
  // this asserts the forwarding policy that feeds it.
  test("the #2364 enrich path forwards a non-zero totalDurationMs to repair a 0-duration first write", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // Phase 1 — reap-time `completed` write with no usable start stamp → 0 span.
    await recordCycle({ cycleId: "c-dur", status: "completed", totalDurationMs: 0 } as any, deps);
    assert.equal(store.metrics.get("c-dur")!.totalDurationMs, "0");

    // Phase 2 — post-merge follow-up carries the real duration. It dedups on the
    // count/bucket surface but enriches the metrics hash with the real span.
    const r2 = await recordCycle(
      { cycleId: "c-dur", status: "merged", prNumber: 9, totalDurationMs: 619721 } as any,
      deps,
    );
    assert.equal((r2 as any).deduped, true, "count/bucket surface still no-ops");
    assert.equal((r2 as any).bucketed, null);
    assert.equal((r2 as any).enriched, true, "metrics hash was enriched with the duration");
    assert.equal(store.counters.run, 1, "no counter re-fire");
    assert.equal(store.metrics.get("c-dur")!.totalDurationMs, "619721");
  });

  test("the #2364 enrich path does NOT forward a 0 totalDurationMs (no spurious enrichment)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // First write lands a real duration.
    await recordCycle({ cycleId: "c-dur0", status: "completed", totalDurationMs: 12345 } as any, deps);
    assert.equal(store.metrics.get("c-dur0")!.totalDurationMs, "12345");

    // A follow-up carrying duration 0 and no other new data must stay a true
    // no-op — it must NOT enrich (and the real first-write duration is untouched).
    // NOTE (#2860): the status is kept `completed` here (not `merged`) so this
    // case isolates the #2364 DURATION-forwarding policy from the #2860
    // completed→merged status upgrade — a `merged` re-post would legitimately
    // enrich via the status bump, which is asserted separately in the #2860 block.
    const r2 = await recordCycle(
      { cycleId: "c-dur0", status: "completed", totalDurationMs: 0 } as any,
      deps,
    );
    assert.equal((r2 as any).deduped, true);
    assert.equal((r2 as any).enriched, false, "a 0 duration is not an enrichment");
    assert.equal(store.metrics.get("c-dur0")!.totalDurationMs, "12345", "real span preserved");
  });

  // Issue #2854: the merge-watch cycle-record enrichment now carries
  // status:'merged' + tasksMerged/tasksAttempted:1. For the qa_orch RELAY case —
  // where reap.py never wrote a prior cycle-record for this cycleId — that
  // enrichment is the FIRST write. Before #2854 the body carried no status/
  // counters, so recordCycle defaulted the counters to 0 and the "completed"
  // status fallback bucketed the cycle `unaccounted`/empty, inflating the
  // empty-cycle rate. This asserts the first-write body now buckets `merged`
  // with tasksMerged=1 (this is the exact shape holdback-merge-watch.ts sends).
  test("#2854: a first-write merge-watch enrichment (no prior record) buckets merged with tasksMerged=1, NOT unaccounted", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // The exact cycleBody holdback-merge-watch.ts sends for a landed PR whose
    // cycleId reap.py never recorded (the qa_orch relay first-write case).
    const r = await recordCycle(
      { cycleId: "c-relay", prNumber: 88, filesChanged: 5, status: "merged", tasksMerged: 1, tasksAttempted: 1 } as any,
      deps,
    );
    assert.equal((r as any).bucketed, "merged", "first write buckets merged, not unaccounted");
    assert.equal((r as any).deduped, false, "no prior record ⇒ genuine first write");
    assert.equal(store.counters.merged, 1);
    assert.equal(store.counters.unaccounted, 0, "the empty-cycle bucket is NOT bumped");
    assert.equal(store.cycles.get("c-relay")!.status, "merged");
    assert.equal(store.metrics.get("c-relay")!.tasksMerged, "1");
    assert.equal(store.metrics.get("c-relay")!.tasksAttempted, "1");
  });

  // Issue #2854 safety: on the dedup path recordCycle short-circuits on
  // `existing.status`, so the new status/tasksMerged/tasksAttempted fields the
  // merge-watch now sends are IGNORED for an already-recorded cycle — no
  // re-bucket, no counter re-fire. This proves the fix does not disturb the
  // already-recorded (reap-then-merge) case.
  test("#2854: the dedup path ignores the new status/counter fields (already-recorded cycle unaffected)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // Phase 1 — reap-time write buckets the cycle as `failed`.
    await recordCycle({ cycleId: "c-relay-dedup", status: "failed", tasksMerged: 0 } as any, deps);
    assert.equal(store.counters.failed, 1);
    assert.equal(store.counters.merged, 0);

    // Phase 2 — the merge-watch enrichment arrives with status:'merged' etc. The
    // dedup early-return keys on existing.status, so the record stays `failed`
    // and no counter re-fires.
    const r2 = await recordCycle(
      { cycleId: "c-relay-dedup", prNumber: 88, filesChanged: 2, status: "merged", tasksMerged: 1, tasksAttempted: 1 } as any,
      deps,
    );
    assert.equal((r2 as any).deduped, true, "already-recorded ⇒ dedup");
    assert.equal((r2 as any).bucketed, null, "no re-bucket on the dedup path");
    assert.equal((r2 as any).status, "failed", "returned status is the pre-existing one");
    assert.equal(store.counters.failed, 1, "failed counter did NOT re-fire");
    assert.equal(store.counters.merged, 0, "the merged counter is NOT bumped by the ignored status");
    assert.equal(store.cycles.get("c-relay-dedup")!.status, "failed", "stored status unchanged");
  });

  // Issue #2860: the `completed → merged` UPGRADE on the dedup path. reap.py
  // files EVERY cycle at status='completed' with tasksMerged UNSET (it runs
  // before the merge decision, #430). Before #2860 the dedup branch enriched
  // only filesChanged/prNumber/duration and DROPPED the incoming merged status +
  // tasksMerged — so an already-`completed` record's tasksMerged stayed 0 forever
  // and the dashboard trend (which reads tasksMerged>0 as its SINGLE merged
  // predicate) showed merged cycles as 0% merged. This asserts the upgrade bumps
  // the metrics tasksMerged (and the cycle-hash status) WITHOUT re-firing any
  // lifetime counter — 'completed' is already in MERGED_STATUSES, so the first
  // write already bumped cyclesMerged once; the upgrade must not double-count.
  test("#2860: a completed→merged enrichment upgrades tasksMerged to 1 WITHOUT re-firing a counter", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // Phase 1 — reap-time first write: completed, tasksMerged unset (defaults 0).
    await recordCycle({ cycleId: "c-2860", status: "completed" } as any, deps);
    assert.equal(store.counters.run, 1);
    assert.equal(store.counters.merged, 1, "completed is a MERGED_STATUS ⇒ counter fired once");
    assert.equal(store.metrics.get("c-2860")!.tasksMerged, "0", "reap-time record has 0 merged");
    assert.equal(store.cycles.get("c-2860")!.status, "completed");

    // Phase 2 — the PR merged; merge-watch/reconciler re-posts status:'merged'.
    const r2 = await recordCycle(
      { cycleId: "c-2860", status: "merged", tasksMerged: 1, prNumber: 2860 } as any,
      deps,
    );
    assert.equal((r2 as any).deduped, true, "still a dedup on the count/bucket surface");
    assert.equal((r2 as any).bucketed, null, "no re-bucket");
    assert.equal((r2 as any).enriched, true, "the metrics hash was upgraded");
    assert.equal((r2 as any).status, "merged", "returned status reflects the upgrade");
    // The merged predicate is now satisfied.
    assert.equal(store.metrics.get("c-2860")!.tasksMerged, "1", "tasksMerged upgraded to 1");
    assert.equal(store.metrics.get("c-2860")!.prNumber, "2860", "prNumber also enriched");
    assert.equal(store.cycles.get("c-2860")!.status, "merged", "cycle-hash status upgraded");
    // The invariant that matters: NO counter re-fire (fire-exactly-once).
    assert.equal(store.counters.run, 1, "run counter did NOT re-fire");
    assert.equal(store.counters.merged, 1, "merged counter did NOT re-fire on the upgrade");
    assert.equal(store.counters.unaccounted, 0);
  });

  // Issue #2860: the upgrade is idempotent — once a record is at 'merged',
  // re-observing a merged re-post is a plain dedup no-op (no further mutation,
  // no counter). This proves a reconciler that re-scans an already-upgraded
  // record does not double-anything.
  test("#2860: re-posting merged onto an already-merged record is an idempotent no-op", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle({ cycleId: "c-2860-idem", status: "completed" } as any, deps);
    // First upgrade.
    await recordCycle({ cycleId: "c-2860-idem", status: "merged", tasksMerged: 1 } as any, deps);
    assert.equal(store.metrics.get("c-2860-idem")!.tasksMerged, "1");
    assert.equal(store.counters.merged, 1);

    // Second merged re-post — existing status is now 'merged' (terminal), so no
    // upgrade branch fires and nothing carrying new data means enriched:false.
    const r3 = await recordCycle(
      { cycleId: "c-2860-idem", status: "merged", tasksMerged: 1 } as any,
      deps,
    );
    assert.equal((r3 as any).deduped, true);
    assert.equal((r3 as any).enriched, false, "no new data ⇒ plain dedup, not a re-upgrade");
    assert.equal((r3 as any).status, "merged");
    assert.equal(store.counters.merged, 1, "merged counter still fired exactly once");
  });

  // Issue #2860: the upgrade fires ONLY for completed→merged. A completed record
  // that receives a NON-merged re-post (e.g. a plain filesChanged enrichment)
  // must NOT be flipped to merged and must NOT gain a tasksMerged. This guards
  // against a stray enrichment silently marking a not-yet-landed cycle merged.
  test("#2860: a completed record is NOT upgraded when the re-post status is not 'merged'", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle({ cycleId: "c-2860-noup", status: "completed" } as any, deps);
    const r2 = await recordCycle(
      { cycleId: "c-2860-noup", status: "completed", filesChanged: 3 } as any,
      deps,
    );
    assert.equal((r2 as any).enriched, true, "filesChanged still enriches");
    assert.equal((r2 as any).status, "completed", "status stays completed, not upgraded");
    assert.equal(store.cycles.get("c-2860-noup")!.status, "completed");
    assert.equal(store.metrics.get("c-2860-noup")!.tasksMerged, "0", "no spurious tasksMerged bump");
    assert.equal(store.metrics.get("c-2860-noup")!.filesChanged, "3");
  });
});

// ---------------------------------------------------------------------------
// recordTurn
// ---------------------------------------------------------------------------

describe("recordTurn — injected deps (#2158)", () => {
  test("records an immutable turn + counter updates, deriving epoch from the clock", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-t", limits: {} } as any, deps);

    const r = await recordTurn(
      {
        run_id: "run-t",
        turn_n: 3,
        actions: [{ type: "dispatch" }, { type: "dispatch" }, { type: "wait" }],
        tokens_after: 1234,
        idle_turns: 1,
      } as any,
      deps,
    );
    assert.equal(r.ok, true);
    assert.equal((r as any).turn_n, 3);
    assert.equal((r as any).dispatch_count, 2);
    assert.equal((r as any).deduped, false);

    const row = store.runs.get("run-t")!;
    assert.equal(row.turns, "3");
    assert.equal(row.dispatches, "2");
    assert.equal(row.cumulative_tokens, "1234");
    assert.equal(row.idle_turns, "1");
    // last_heartbeat_epoch defaulted from the injected clock.
    assert.equal(row.last_heartbeat_epoch, String(Math.floor(FIXED_NOW_MS / 1000)));
    assert.ok(store.runTurns.get("run-t")!.has(3));
  });

  test("is idempotent on (runId, turn_n) — a duplicate turn is a no-op", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await startRun({ run_id: "run-t2", limits: {} } as any, deps);
    await recordTurn({ run_id: "run-t2", turn_n: 1, actions: [] } as any, deps);
    const r = await recordTurn({ run_id: "run-t2", turn_n: 1, actions: [] } as any, deps);
    assert.equal((r as any).deduped, true);
    assert.equal((r as any).dispatch_count, 0);
  });

  test("404s on a turn for an unknown run", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const r = await recordTurn({ run_id: "nope", turn_n: 1, actions: [] } as any, deps);
    assert.equal(r.ok, false);
    assert.equal((r as any).code, "not-found");
  });
});

// ---------------------------------------------------------------------------
// sweepRunIfDead — the headline friction: a dead-pid branch reachable purely by
// INJECTING isPidAlive=false on a synthetic running row, no real PID needed.
// ---------------------------------------------------------------------------

describe("sweepRunIfDead — injected liveness, no real PID (#2158)", () => {
  const baseRow = (over: Record<string, string> = {}): Record<string, string> => ({
    run_id: "run-sweep",
    status: "running",
    pid: "424242",
    started_epoch: String(Math.floor(FIXED_NOW_MS / 1000) - 300),
    last_heartbeat_epoch: String(Math.floor(FIXED_NOW_MS / 1000) - 250),
    ...over,
  });

  test("a live pid (injected true) is left untouched", async () => {
    const store = newStore();
    const deps = makeDeps(store, { isPidAlive: () => true });
    const res = await sweepRunIfDead("run-sweep", baseRow(), deps);
    assert.equal(res.swept, false);
    assert.equal(res.row.status, "running");
  });

  test("a dead pid with NO exit code sweeps to killed/crash + stamps crash_detail", async () => {
    const store = newStore();
    const deps = makeDeps(store, { isPidAlive: () => false });
    const res = await sweepRunIfDead("run-sweep", baseRow(), deps);
    assert.equal(res.swept, true);
    assert.equal(res.row.status, "killed");
    assert.equal(res.row.term_reason, "crash");
    assert.match(JSON.parse(res.row.crash_detail).last_action, /swept-dead-pid/);
    // The write went through the injected deps facade, not a live Redis.
    assert.equal(store.runs.get("run-sweep")!.status, "killed");
  });

  test("a dead pid with a clean exit_code=0 sweeps to ended/interrupted (no crash_detail)", async () => {
    const store = newStore();
    const deps = makeDeps(store, { isPidAlive: () => false });
    const res = await sweepRunIfDead("run-sweep", baseRow({ exit_code: "0" }), deps);
    assert.equal(res.swept, true);
    assert.equal(res.row.status, "ended");
    assert.equal(res.row.term_reason, "interrupted");
    assert.equal(res.row.crash_detail, undefined);
  });

  test("a dead pid with a non-zero exit_code sweeps to killed/crash", async () => {
    const store = newStore();
    const deps = makeDeps(store, { isPidAlive: () => false });
    const res = await sweepRunIfDead("run-sweep", baseRow({ exit_code: "137" }), deps);
    assert.equal(res.row.status, "killed");
    assert.equal(res.row.term_reason, "crash");
  });

  test("a non-running row is never swept regardless of liveness", async () => {
    const store = newStore();
    const deps = makeDeps(store, { isPidAlive: () => false });
    const res = await sweepRunIfDead(
      "run-sweep",
      baseRow({ status: "ended", term_reason: "budget" }),
      deps,
    );
    assert.equal(res.swept, false);
    assert.equal(res.row.status, "ended");
  });
});

// ---------------------------------------------------------------------------
// getRunDispatchClasses — injected listTurnsDesc, no Redis (#2640)
//
// The dispatch-class projection moved out of behavior-gallery.ts's dynamic-
// import `defaultFetchClasses` into this domain Module. Its narrow
// `{ listTurnsDesc }` deps bag (mirroring ProjectionDeps) makes the turn-scan /
// dedup / sort / tolerant-parse logic exercisable without a live Redis.
// ---------------------------------------------------------------------------

describe("getRunDispatchClasses — injected listTurnsDesc, no Redis (#2640)", () => {
  const turn = (actions: unknown[]) => JSON.stringify({ turn_n: 1, actions });

  test("harvests dispatch classes deduped + alphabetically sorted", async () => {
    const members = [
      turn([
        { type: "dispatch", class: "qa" },
        { type: "dispatch", class: "dev_orch" },
      ]),
      turn([{ type: "dispatch", class: "dev_orch" }]), // dup across turns
      turn([{ type: "reason", class: "ignored" }]), // non-dispatch action skipped
    ];
    const classes = await getRunDispatchClasses("r1", {
      listTurnsDesc: async () => members,
    });
    assert.deepEqual(classes, ["dev_orch", "qa"]);
  });

  test("returns [] for a run with no turns", async () => {
    const classes = await getRunDispatchClasses("empty", {
      listTurnsDesc: async () => [],
    });
    assert.deepEqual(classes, []);
  });

  test("tolerantly skips malformed turn rows without blanking the result", async () => {
    const members = [
      "{not json", // unparseable
      JSON.stringify({ turn_n: 2, actions: "not-an-array" }), // non-array actions
      turn([{ type: "dispatch" }]), // dispatch missing class
      turn([{ type: "dispatch", class: "cleanup_orch" }]), // the one good row
    ];
    const classes = await getRunDispatchClasses("mixed", {
      listTurnsDesc: async () => members,
    });
    assert.deepEqual(classes, ["cleanup_orch"]);
  });

  test("passes the 200-turn scan cap through to listTurnsDesc", async () => {
    let seenLimit = -1;
    await getRunDispatchClasses("r-cap", {
      listTurnsDesc: async (_runId, limit) => {
        seenLimit = limit;
        return [];
      },
    });
    assert.equal(seenLimit, 200);
  });
});

// ---------------------------------------------------------------------------
// recordCycle — anchorType is ALWAYS classified explicitly (issue #2689)
//
// A cycle-record whose body carries no explicit, non-empty anchorType must NOT
// leave the metrics record with an absent anchorType — that is exactly what the
// aggregator (src/metrics/aggregate.ts) buckets as "unknown", the data-quality
// black hole that made 24% of recent cycles invisible to metrics-driven
// decisions. recordCycle now records the `unclassified` sentinel instead, so
// the field is always present and non-empty, and "unknown" is never produced by
// a fall-through. A caller-supplied anchorType is passed through verbatim.
// ---------------------------------------------------------------------------

describe("recordCycle — anchorType classification (#2689)", () => {
  // Suppress the intentional fail-loud console.warn for the unclassified cases
  // so the suite output stays clean; restore after each test.
  function withSilencedWarn<T>(fn: () => Promise<T>): Promise<T> {
    const orig = console.warn;
    console.warn = () => {};
    return fn().finally(() => {
      console.warn = orig;
    });
  }

  test("passes a caller-supplied anchorType through verbatim", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "c-at-explicit", status: "merged", anchorType: "work-queue" } as any,
      deps,
    );
    assert.equal(store.metrics.get("c-at-explicit")!.anchorType, "work-queue");
  });

  test("records the 'unclassified' sentinel — NOT 'unknown', NOT absent — when anchorType is omitted", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await withSilencedWarn(() =>
      recordCycle({ cycleId: "c-at-absent", status: "completed" } as any, deps),
    );
    const m = store.metrics.get("c-at-absent")!;
    // The field is PRESENT and non-empty — the whole point of #2689: an absent
    // field would be stripped and bucket as "unknown" downstream.
    assert.ok("anchorType" in m, "anchorType must be written, never stripped");
    assert.equal(m.anchorType, UNCLASSIFIED_ANCHOR_TYPE);
    assert.notEqual(m.anchorType, "unknown");
  });

  test("records the sentinel for an empty-string anchorType (would-be 'unknown')", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await withSilencedWarn(() =>
      recordCycle({ cycleId: "c-at-empty", status: "completed", anchorType: "" } as any, deps),
    );
    assert.equal(store.metrics.get("c-at-empty")!.anchorType, UNCLASSIFIED_ANCHOR_TYPE);
  });

  test("records the sentinel for a whitespace-only anchorType", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await withSilencedWarn(() =>
      recordCycle({ cycleId: "c-at-ws", status: "completed", anchorType: "   " } as any, deps),
    );
    assert.equal(store.metrics.get("c-at-ws")!.anchorType, UNCLASSIFIED_ANCHOR_TYPE);
  });

  test("trims surrounding whitespace on a non-empty anchorType", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "c-at-trim", status: "merged", anchorType: "  grill  " } as any,
      deps,
    );
    assert.equal(store.metrics.get("c-at-trim")!.anchorType, "grill");
  });

  test("emits a fail-loud console.warn naming the cycle when classification falls back", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const orig = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await recordCycle({ cycleId: "c-at-warn", status: "completed" } as any, deps);
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1, "exactly one warning for one unclassified cycle");
    assert.match(warnings[0], /c-at-warn/, "warning names the offending cycleId");
    assert.match(warnings[0], /anchorType/i);
  });
});
