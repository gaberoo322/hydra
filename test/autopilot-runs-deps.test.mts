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
  recordCycle,
  recordTurn,
  sweepRunIfDead,
  type AutopilotRunsDeps,
} from "../src/autopilot/runs.ts";

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
  };
}

interface FixtureOpts {
  /** Fixed clock value (epoch-ms). Defaults to a stable constant. */
  nowMs?: number;
  /** Liveness override. Defaults to "every pid is alive". */
  isPidAlive?: (pid: number) => boolean;
}

const FIXED_NOW_MS = 1_750_000_000_000; // 2025-06-15T14:13:20.000Z, stable.

function makeDeps(store: MemStore, opts: FixtureOpts = {}): AutopilotRunsDeps {
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
    isPidAlive: opts.isPidAlive ?? (() => true),
    now: () => nowMs,
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
    const r2 = await recordCycle(
      { cycleId: "c-dur0", status: "merged", totalDurationMs: 0 } as any,
      deps,
    );
    assert.equal((r2 as any).deduped, true);
    assert.equal((r2 as any).enriched, false, "a 0 duration is not an enrichment");
    assert.equal(store.metrics.get("c-dur0")!.totalDurationMs, "12345", "real span preserved");
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
