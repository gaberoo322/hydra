/**
 * Focused unit tests for the extracted dispatch-outcome record leaf
 * (`src/autopilot/outcome-record.ts`, issue #3323).
 *
 * These exercise the leaf DIRECTLY through its narrow `OutcomeRecordDeps`
 * surface — only the dispatch-outcome facade + clock, NOT the full
 * `CycleCloseDeps` bag — which is exactly the testability win the extraction
 * was for: `resolveDispatchTokens` and `writeDispatchOutcomeRecord` were
 * private and untestable inside `cycle-close.ts`; as named exports they get an
 * assertion surface that accepts only the dispatch-outcome inputs.
 *
 * The end-to-end `recordCycle` coverage still lives in
 * `test/cycle-close-dispatch-outcome.test.mts` (the coordinator wiring); this
 * file pins the leaf's own contract.
 *
 * Pure in-memory deps — no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolveDispatchTokens,
  writeDispatchOutcomeRecord,
  upgradeDispatchOutcomeRecord,
  type OutcomeRecordDeps,
} from "../src/autopilot/outcome-record.ts";

const FIXED_NOW_MS = 1_750_000_000_000;
const HARNESS_CYCLE_ID = "worktree-agent-277e4476-t4-dev_orch";

interface OutcomeStore {
  records: Map<string, Record<string, unknown>>;
  putCalls: number;
  upgradeCalls: number;
}

interface OutcomeFixtureOpts {
  cycleTokensRaw?: string | null;
  behavior?: "ok" | "err" | "throw";
}

function newStore(): OutcomeStore {
  return { records: new Map(), putCalls: 0, upgradeCalls: 0 };
}

function makeDeps(store: OutcomeStore, opts: OutcomeFixtureOpts = {}): OutcomeRecordDeps {
  return {
    dispatchOutcomes: {
      async put(record) {
        store.putCalls += 1;
        if (opts.behavior === "throw") throw new Error("boom-put");
        if (opts.behavior === "err") return { ok: false as const, error: "put-refused" };
        store.records.set(record.cycleId, { ...record });
        return { ok: true as const };
      },
      async upgrade(cycleId, patch) {
        store.upgradeCalls += 1;
        if (opts.behavior === "throw") throw new Error("boom-upgrade");
        if (opts.behavior === "err") return { ok: false as const, error: "upgrade-refused" };
        const existing = store.records.get(cycleId) ?? { cycleId };
        store.records.set(cycleId, { ...existing, ...patch });
        return { ok: true as const };
      },
      async readCycleTokens() {
        return opts.cycleTokensRaw ?? null;
      },
    },
    now: () => FIXED_NOW_MS,
  };
}

describe("resolveDispatchTokens (issue #3323 leaf)", () => {
  test("prefers the body's tokens over the fallback hash", async () => {
    const store = newStore();
    const tokens = await resolveDispatchTokens(
      { tokens: 42_000 } as any,
      HARNESS_CYCLE_ID,
      makeDeps(store, { cycleTokensRaw: "99999" }),
    );
    assert.equal(tokens, 42_000);
  });

  test("falls back to the per-cycle token hash when the body carries none", async () => {
    const store = newStore();
    const tokens = await resolveDispatchTokens(
      {} as any,
      HARNESS_CYCLE_ID,
      makeDeps(store, { cycleTokensRaw: "98765" }),
    );
    assert.equal(tokens, 98_765);
  });

  test("records a truthful null when body AND fallback are both dark (never fabricates 0)", async () => {
    const store = newStore();
    const tokens = await resolveDispatchTokens(
      {} as any,
      HARNESS_CYCLE_ID,
      makeDeps(store, { cycleTokensRaw: null }),
    );
    assert.equal(tokens, null);
  });

  test("a negative/garbage body token clamps to the fallback, then null", async () => {
    const store = newStore();
    const tokens = await resolveDispatchTokens(
      { tokens: -5 } as any,
      HARNESS_CYCLE_ID,
      makeDeps(store, { cycleTokensRaw: null }),
    );
    assert.equal(tokens, null);
  });
});

describe("writeDispatchOutcomeRecord (issue #3323 leaf)", () => {
  test("persists the full attribution join parsed from the cycleId", async () => {
    const store = newStore();
    await writeDispatchOutcomeRecord(
      { tokens: 123456, totalDurationMs: 90_000 } as any,
      HARNESS_CYCLE_ID,
      "completed",
      makeDeps(store),
    );
    assert.equal(store.putCalls, 1);
    const rec = store.records.get(HARNESS_CYCLE_ID)!;
    assert.equal(rec.runIdPrefix, "277e4476");
    assert.equal(rec.turn, 4);
    assert.equal(rec.className, "dev_orch");
    assert.equal(rec.skill, "hydra-dev"); // taxonomy join
    assert.equal(rec.outcome, "completed");
    assert.equal(rec.tokens, 123456);
    assert.equal(rec.durationMs, 90_000);
    assert.equal(rec.recordedAt, FIXED_NOW_MS);
    assert.equal(rec.escalationAttempt, null);
    assert.equal(rec.escalatedModel, null);
  });

  test("an unparseable cycleId records null attribution, never drops (dark tolerance)", async () => {
    const store = newStore();
    const uuid = "8f1c2d3e-aaaa-bbbb-cccc-000000000000";
    await writeDispatchOutcomeRecord({} as any, uuid, "completed", makeDeps(store));
    const rec = store.records.get(uuid)!;
    assert.ok(rec);
    assert.equal(rec.runIdPrefix, null);
    assert.equal(rec.turn, null);
    assert.equal(rec.className, null);
    assert.equal(rec.skill, null);
    assert.equal(rec.outcome, "completed");
  });

  test("threads cascade-escalation provenance (issue #3284)", async () => {
    const store = newStore();
    await writeDispatchOutcomeRecord(
      { tokens: 55000, escalationAttempt: 2, escalatedModel: "sonnet" } as any,
      HARNESS_CYCLE_ID,
      "completed",
      makeDeps(store),
    );
    const rec = store.records.get(HARNESS_CYCLE_ID)!;
    assert.equal(rec.escalationAttempt, 2);
    assert.equal(rec.escalatedModel, "sonnet");
  });

  test("a throwing put is swallowed-and-logged, never propagated (best-effort)", async () => {
    const store = newStore();
    await assert.doesNotReject(
      writeDispatchOutcomeRecord(
        {} as any,
        HARNESS_CYCLE_ID,
        "merged",
        makeDeps(store, { behavior: "throw" }),
      ),
    );
    assert.equal(store.putCalls, 1);
    assert.equal(store.records.has(HARNESS_CYCLE_ID), false);
  });

  test("a refused (ok:false) put is swallowed-and-logged, never propagated (best-effort)", async () => {
    const store = newStore();
    await assert.doesNotReject(
      writeDispatchOutcomeRecord(
        {} as any,
        HARNESS_CYCLE_ID,
        "completed",
        makeDeps(store, { behavior: "err" }),
      ),
    );
    assert.equal(store.putCalls, 1);
  });
});

describe("upgradeDispatchOutcomeRecord (issue #3323 leaf)", () => {
  test("patches the record outcome=merged in lockstep, forwarding a real span", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await writeDispatchOutcomeRecord({} as any, HARNESS_CYCLE_ID, "completed", deps);
    await upgradeDispatchOutcomeRecord(
      { tokens: 77000 } as any,
      HARNESS_CYCLE_ID,
      120_000,
      deps,
    );
    assert.equal(store.upgradeCalls, 1);
    const rec = store.records.get(HARNESS_CYCLE_ID)!;
    assert.equal(rec.outcome, "merged");
    assert.equal(rec.tokens, 77000);
    assert.equal(rec.durationMs, 120_000);
  });

  test("omits a zero span from the patch (never regresses a stored non-zero)", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await writeDispatchOutcomeRecord(
      { totalDurationMs: 60_000 } as any,
      HARNESS_CYCLE_ID,
      "completed",
      deps,
    );
    await upgradeDispatchOutcomeRecord({} as any, HARNESS_CYCLE_ID, 0, deps);
    const rec = store.records.get(HARNESS_CYCLE_ID)!;
    assert.equal(rec.outcome, "merged");
    // durationMs from the first write (60_000) is untouched — no durationMs key
    // was in the patch, so the merge left it in place.
    assert.equal(rec.durationMs, 60_000);
  });

  test("a throwing upgrade is swallowed-and-logged, never propagated (best-effort)", async () => {
    const store = newStore();
    await assert.doesNotReject(
      upgradeDispatchOutcomeRecord(
        {} as any,
        HARNESS_CYCLE_ID,
        100_000,
        makeDeps(store, { behavior: "throw" }),
      ),
    );
    assert.equal(store.upgradeCalls, 1);
  });
});
