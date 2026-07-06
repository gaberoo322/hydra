/**
 * Regression tests for the per-dispatch outcome-record write inside
 * `recordCycle` (`src/autopilot/cycle-close.ts`, issue #2942).
 *
 * Coverage maps to the issue's acceptance criteria + design-concept invariants:
 *   AC1 — a record is written at reap time for EVERY cycle-record-bearing
 *         dispatch: merged, failed, AND no-op/unaccounted statuses all
 *         produce a record whose `outcome` reflects the status verbatim.
 *   Idempotency — a duplicate cycle-record post never creates a second record
 *         and never double-writes tokens (put fires only on the first-write
 *         path; the dedup path routes through upgrade only on the
 *         issue-2860 completed→merged transition).
 *   Lockstep — the completed→merged upgrade patches the record's `outcome`
 *         alongside the cycle-hash status.
 *   Dark tolerance — an unparseable cycleId records null run/turn/class/skill;
 *         tokens resolve body → per-cycle-token-hash fallback → null.
 *   Best-effort — a throwing/failing record write never alters the returned
 *         CycleRecordResult and never blocks the pre-existing writes.
 *
 * Pure in-memory deps — no Redis (the #2158/#2768 deps-bag precedent).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { recordCycle, type CycleCloseDeps } from "../src/autopilot/cycle-close.ts";

const FIXED_NOW_MS = 1_750_000_000_000;

interface MemStore {
  cycles: Map<string, Record<string, string>>;
  cycleIndex: Map<string, number>;
  metrics: Map<string, Record<string, string>>;
  counters: Record<string, number>;
  outcomes: Map<string, Record<string, unknown>>;
  putCalls: number;
  upgradeCalls: number;
}

function newStore(): MemStore {
  return {
    cycles: new Map(),
    cycleIndex: new Map(),
    metrics: new Map(),
    counters: { run: 0, merged: 0, failed: 0, unaccounted: 0 },
    outcomes: new Map(),
    putCalls: 0,
    upgradeCalls: 0,
  };
}

interface FixtureOpts {
  /** Per-cycle token-hash fallback value (issue #2942). Default: miss. */
  cycleTokensRaw?: string | null;
  /** Make the outcome-record put/upgrade fail or throw. */
  putBehavior?: "ok" | "err" | "throw";
}

function makeDeps(store: MemStore, opts: FixtureOpts = {}): CycleCloseDeps {
  return {
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
    dispatchOutcomes: {
      async put(record) {
        store.putCalls += 1;
        if (opts.putBehavior === "throw") throw new Error("boom-put");
        if (opts.putBehavior === "err") return { ok: false as const, error: "put-refused" };
        store.outcomes.set(record.cycleId, { ...record });
        return { ok: true as const };
      },
      async upgrade(cycleId, patch) {
        store.upgradeCalls += 1;
        if (opts.putBehavior === "throw") throw new Error("boom-upgrade");
        if (opts.putBehavior === "err") return { ok: false as const, error: "upgrade-refused" };
        const existing = store.outcomes.get(cycleId) ?? { cycleId };
        store.outcomes.set(cycleId, { ...existing, ...patch });
        return { ok: true as const };
      },
      async readCycleTokens() {
        return opts.cycleTokensRaw ?? null;
      },
    },
    now: () => FIXED_NOW_MS,
  };
}

const HARNESS_CYCLE_ID = "worktree-agent-277e4476-t4-dev_orch";

describe("recordCycle — per-dispatch outcome record (issue #2942)", () => {
  test("first write persists the full attribution join parsed from the cycleId", async () => {
    const store = newStore();
    const res = await recordCycle(
      {
        cycleId: HARNESS_CYCLE_ID,
        status: "completed",
        tokens: 123456,
        totalDurationMs: 90_000,
      } as any,
      makeDeps(store),
    );
    assert.equal(res.ok, true);
    assert.equal(store.putCalls, 1);
    const rec = store.outcomes.get(HARNESS_CYCLE_ID);
    assert.ok(rec, "outcome record should be written");
    assert.equal(rec!.runIdPrefix, "277e4476");
    assert.equal(rec!.turn, 4);
    assert.equal(rec!.className, "dev_orch");
    assert.equal(rec!.skill, "hydra-dev"); // taxonomy join (classes.json)
    assert.equal(rec!.outcome, "completed");
    assert.equal(rec!.tokens, 123456);
    assert.equal(rec!.durationMs, 90_000);
    assert.equal(rec!.recordedAt, FIXED_NOW_MS);
  });

  test("a failed dispatch still produces a record with outcome=failed (AC1)", async () => {
    const store = newStore();
    await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "failed" } as any,
      makeDeps(store),
    );
    const rec = store.outcomes.get(HARNESS_CYCLE_ID);
    assert.ok(rec);
    assert.equal(rec!.outcome, "failed");
  });

  test("a no-op/unaccounted status still produces a record, outcome verbatim (AC1)", async () => {
    const store = newStore();
    await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "no-op" } as any,
      makeDeps(store),
    );
    const rec = store.outcomes.get(HARNESS_CYCLE_ID);
    assert.ok(rec);
    assert.equal(rec!.outcome, "no-op");
  });

  test("an unparseable (bare-UUID) cycleId records null attribution, never drops (dark tolerance)", async () => {
    const store = newStore();
    const uuid = "8f1c2d3e-aaaa-bbbb-cccc-000000000000";
    await recordCycle({ cycleId: uuid, status: "completed" } as any, makeDeps(store));
    const rec = store.outcomes.get(uuid);
    assert.ok(rec, "record must be written even when the cycleId is unparseable");
    assert.equal(rec!.runIdPrefix, null);
    assert.equal(rec!.turn, null);
    assert.equal(rec!.className, null);
    assert.equal(rec!.skill, null);
    assert.equal(rec!.outcome, "completed");
  });

  test("tokens fall back to the per-cycle token hash when the body carries none", async () => {
    const store = newStore();
    await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "completed" } as any,
      makeDeps(store, { cycleTokensRaw: "98765" }),
    );
    assert.equal(store.outcomes.get(HARNESS_CYCLE_ID)!.tokens, 98765);
  });

  test("tokens record a truthful null when body AND fallback are both dark", async () => {
    const store = newStore();
    await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "completed" } as any,
      makeDeps(store, { cycleTokensRaw: null }),
    );
    assert.equal(store.outcomes.get(HARNESS_CYCLE_ID)!.tokens, null);
  });

  test("a duplicate post never creates a second record and never re-puts (idempotency)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle({ cycleId: HARNESS_CYCLE_ID, status: "failed" } as any, deps);
    const dup = await recordCycle({ cycleId: HARNESS_CYCLE_ID, status: "failed" } as any, deps);
    assert.equal(dup.ok, true);
    if (dup.ok === true) assert.equal(dup.deduped, true);
    assert.equal(store.putCalls, 1);
    // A plain dedup (no completed→merged transition) never touches the record.
    assert.equal(store.upgradeCalls, 0);
  });

  test("the completed→merged upgrade keeps the record's outcome in lockstep (issue #2860 path)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle({ cycleId: HARNESS_CYCLE_ID, status: "completed" } as any, deps);
    assert.equal(store.outcomes.get(HARNESS_CYCLE_ID)!.outcome, "completed");

    const up = await recordCycle(
      {
        cycleId: HARNESS_CYCLE_ID,
        status: "merged",
        tasksMerged: 1,
        totalDurationMs: 120_000,
      } as any,
      deps,
    );
    assert.equal(up.ok, true);
    if (up.ok === true) {
      assert.equal(up.status, "merged");
      assert.equal(up.deduped, true);
    }
    assert.equal(store.putCalls, 1, "upgrade must not create a second record");
    assert.equal(store.upgradeCalls, 1);
    const rec = store.outcomes.get(HARNESS_CYCLE_ID)!;
    assert.equal(rec.outcome, "merged");
    assert.equal(rec.durationMs, 120_000); // real span forwarded on the enrichment path
  });

  test("a throwing record write never alters the CycleRecordResult (best-effort)", async () => {
    const store = newStore();
    const res = await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "merged", tasksMerged: 1 } as any,
      makeDeps(store, { putBehavior: "throw" }),
    );
    assert.equal(res.ok, true);
    if (res.ok === true) {
      assert.equal(res.status, "merged");
      assert.equal(res.bucketed, "merged");
      assert.equal(res.deduped, false);
    }
    // The pre-existing writes are byte-for-byte unchanged.
    assert.equal(store.counters.run, 1);
    assert.equal(store.counters.merged, 1);
    assert.equal(store.cycles.get(HARNESS_CYCLE_ID)?.status, "merged");
  });

  test("a refused (ok:false) record write is logged, not propagated (best-effort)", async () => {
    const store = newStore();
    const res = await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "completed" } as any,
      makeDeps(store, { putBehavior: "err" }),
    );
    assert.equal(res.ok, true);
    assert.equal(store.counters.run, 1);
  });

  test("a throwing upgrade on the dedup path never alters the dedup result (best-effort)", async () => {
    const store = newStore();
    const okDeps = makeDeps(store);
    await recordCycle({ cycleId: HARNESS_CYCLE_ID, status: "completed" } as any, okDeps);

    // Same store — the cycle hash already carries status=completed, so the
    // dedup/upgrade path fires; only the outcome-record seam throws.
    const throwingDeps = makeDeps(store, { putBehavior: "throw" });
    const res = await recordCycle(
      { cycleId: HARNESS_CYCLE_ID, status: "merged", tasksMerged: 1 } as any,
      throwingDeps,
    );
    assert.equal(res.ok, true);
    if (res.ok === true) {
      assert.equal(res.status, "merged");
      assert.equal(res.deduped, true);
    }
  });
});
