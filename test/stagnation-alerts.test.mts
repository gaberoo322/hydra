/**
 * Regression tests for the proactive builder-health stagnation alert
 * (issue #3290, epic #3285, ADR-0028) — the edge-trigger logic in
 * `emitStagnationAlerts` (`src/notification/stagnation-alerts.ts`, extracted
 * out of the Telegram transport by issue #3303).
 *
 * Invariants under test (the issue's acceptance criteria):
 *   - a `builder-health.stagnation` notification is emitted ONCE on the
 *     transition into breach, not repeated every tick;
 *   - NO notification while a signal is `warming` (cold-start suppressed);
 *   - the payload names the signal, realm, current, baseline, and sustained
 *     cycles (+ the not-tier-adjusted caveat);
 *   - a signal that leaves breach re-arms, so a later re-breach fires again;
 *   - a dark (null) realm block never fires;
 *   - a publish failure leaves the armed-state untouched so the edge re-attempts.
 *
 * The per-(signal, realm) previous-state store is an in-memory `Map`-backed
 * `StagnationAlertStateStore`, exercised without any live Redis / bus.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  emitStagnationAlerts,
  createInMemoryStagnationStore,
  BUILDER_HEALTH_STAGNATION_EVENT,
  type StagnationAlertStateStore,
} from "../src/notification/stagnation-alerts.ts";
import type { StagnationResult } from "../src/aggregators/builder-health-stagnation.ts";
import type { BuilderHealthScorecard } from "../src/aggregators/builder-health.ts";

interface PublishedEvent {
  stream: string;
  type: string;
  correlationId: string | null | undefined;
  payload: any;
}

function makeFakeBus(captured: PublishedEvent[]) {
  return {
    async publish(stream: string, event: any) {
      captured.push({
        stream,
        type: event.type,
        correlationId: event.correlationId,
        payload: event.payload,
      });
      return "fake-id";
    },
  };
}

/** A throwing bus — models a Telegram/Redis publish failure. */
function makeThrowingBus() {
  return {
    async publish(): Promise<never> {
      throw new Error("publish exploded");
    },
  };
}

function verdict(
  state: StagnationResult["state"],
  over: Partial<StagnationResult> = {},
): StagnationResult {
  return {
    state,
    current: over.current ?? null,
    baseline: over.baseline ?? null,
    sustainedCycles: over.sustainedCycles ?? 0,
  };
}

/**
 * Build a minimal scorecard carrying only the stagnation panel — the emitter
 * reads nothing else. Each signal's `orch`/`target` verdict is supplied; a
 * missing realm is `null` (dark).
 */
function scorecardWith(signals: Partial<Record<string, { orch?: StagnationResult | null; target?: StagnationResult | null }>>): BuilderHealthScorecard {
  const full: any = {};
  for (const [name, block] of Object.entries(signals)) {
    full[name] = { orch: block?.orch ?? null, target: block?.target ?? null };
  }
  return {
    generatedAt: new Date().toISOString(),
    selfImprovementShare: null,
    autonomyRate: null,
    reworkRate: null,
    timeToMerge: null,
    mutationKillRateTrend: null,
    scopeViolations: null,
    learningThroughput: null,
    stagnation: {
      signals: full,
      windowContext: { cycles: 0, mix: { cleanup: 0, feature: 0 }, anchorTypes: {} },
    },
  } as BuilderHealthScorecard;
}

describe("emitStagnationAlerts — proactive breach edge-trigger", () => {
  test("fires exactly one notification on the transition INTO breach, with full payload", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    const card = scorecardWith({
      cycleYield: { orch: verdict("breach", { current: 0.2, baseline: 0.8, sustainedCycles: 3 }) },
    });
    const fired = await emitStagnationAlerts(card, bus, { store });

    assert.equal(fired.length, 1);
    assert.equal(captured.length, 1);
    const ev = captured[0];
    assert.equal(ev.type, BUILDER_HEALTH_STAGNATION_EVENT);
    assert.equal(ev.type, "builder-health.stagnation");
    assert.equal(ev.stream, "hydra:notifications");
    // Payload names signal, realm, current, baseline, sustained cycles.
    assert.equal(ev.payload.signal, "cycleYield");
    assert.equal(ev.payload.realm, "orch");
    assert.equal(ev.payload.current, 0.2);
    assert.equal(ev.payload.baseline, 0.8);
    assert.equal(ev.payload.sustainedCycles, 3);
    // The not-tier-adjusted caveat is carried.
    assert.equal(ev.payload.notTierAdjusted, true);
    assert.ok(String(ev.payload.summary).toLowerCase().includes("not tier-adjusted"));
  });

  test("does NOT repeat while the signal stays in breach (suppressed on the next tick)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    const card = scorecardWith({
      reworkRate: { orch: verdict("breach", { current: 0.9, baseline: 0.3, sustainedCycles: 4 }) },
    });

    await emitStagnationAlerts(card, bus, { store }); // tick 1 — fires
    const fired2 = await emitStagnationAlerts(card, bus, { store }); // tick 2 — suppressed
    const fired3 = await emitStagnationAlerts(card, bus, { store }); // tick 3 — suppressed

    assert.equal(captured.length, 1);
    assert.equal(fired2.length, 0);
    assert.equal(fired3.length, 0);
  });

  test("never fires while a signal is warming (cold-start suppressed)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    const card = scorecardWith({
      mutationKillRate: { orch: verdict("warming", { current: 80, baseline: null, sustainedCycles: 0 }) },
    });
    const fired = await emitStagnationAlerts(card, bus, { store });

    assert.equal(fired.length, 0);
    assert.equal(captured.length, 0);
  });

  test("warming -> breach fires (warming is a valid pre-breach state, not a suppressor of the edge)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    // tick 1: warming — records state, no fire.
    await emitStagnationAlerts(
      scorecardWith({ cycleYield: { orch: verdict("warming") } }),
      bus,
      { store },
    );
    assert.equal(captured.length, 0);

    // tick 2: breach — the warming -> breach edge fires.
    const fired = await emitStagnationAlerts(
      scorecardWith({ cycleYield: { orch: verdict("breach", { current: 0.1, baseline: 0.7, sustainedCycles: 3 }) } }),
      bus,
      { store },
    );
    assert.equal(fired.length, 1);
    assert.equal(captured.length, 1);
  });

  test("re-arms after leaving breach, so a later re-breach fires again", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    const breach = scorecardWith({ cycleYield: { orch: verdict("breach", { current: 0.2, baseline: 0.8, sustainedCycles: 3 }) } });
    const recovered = scorecardWith({ cycleYield: { orch: verdict("ok", { current: 0.8, baseline: 0.79, sustainedCycles: 0 }) } });

    await emitStagnationAlerts(breach, bus, { store }); // fires (1)
    await emitStagnationAlerts(recovered, bus, { store }); // recovers — re-arms, no fire
    await emitStagnationAlerts(breach, bus, { store }); // re-breach fires again (2)

    assert.equal(captured.length, 2);
  });

  test("a dark (null) realm block never fires", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    // target is dark (null); orch is ok — nothing to fire.
    const card = scorecardWith({
      cycleYield: { orch: verdict("ok"), target: null },
    });
    const fired = await emitStagnationAlerts(card, bus, { store });

    assert.equal(fired.length, 0);
    assert.equal(captured.length, 0);
  });

  test("independent per-signal edges: two signals in breach fire two distinct notifications", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    const card = scorecardWith({
      cycleYield: { orch: verdict("breach", { current: 0.1, baseline: 0.9, sustainedCycles: 3 }) },
      reworkRate: { orch: verdict("breach", { current: 0.8, baseline: 0.2, sustainedCycles: 5 }) },
    });
    const fired = await emitStagnationAlerts(card, bus, { store });

    assert.equal(fired.length, 2);
    assert.equal(captured.length, 2);
    const keys = captured.map((e) => `${e.payload.signal}:${e.payload.realm}`).sort();
    assert.deepEqual(keys, ["cycleYield:orch", "reworkRate:orch"]);
    // Distinct correlation ids so downstream dedupe keys per signal/realm.
    const corr = new Set(captured.map((e) => e.correlationId));
    assert.equal(corr.size, 2);
  });

  test("a null / missing stagnation panel is a no-op (never throws)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const store = createInMemoryStagnationStore();

    assert.deepEqual(await emitStagnationAlerts(null, bus, { store }), []);
    assert.deepEqual(await emitStagnationAlerts(undefined, bus, { store }), []);
    assert.deepEqual(
      await emitStagnationAlerts({ stagnation: null } as any, bus, { store }),
      [],
    );
    assert.equal(captured.length, 0);
  });

  test("a publish failure leaves the armed-state untouched so the edge re-attempts next tick", async () => {
    const throwing = makeThrowingBus();
    const store = createInMemoryStagnationStore();
    const card = scorecardWith({
      cycleYield: { orch: verdict("breach", { current: 0.2, baseline: 0.8, sustainedCycles: 3 }) },
    });

    // First attempt: publish throws -> nothing "fired", store NOT advanced.
    const fired1 = await emitStagnationAlerts(card, throwing, { store });
    assert.equal(fired1.length, 0);

    // Second attempt against a working bus: the edge is STILL open (not swallowed).
    const captured: PublishedEvent[] = [];
    const workingBus = makeFakeBus(captured);
    const fired2 = await emitStagnationAlerts(card, workingBus, { store });
    assert.equal(fired2.length, 1);
    assert.equal(captured.length, 1);
  });
});

describe("createInMemoryStagnationStore", () => {
  test("get returns null for an unseen key, then round-trips a set value", () => {
    const store: StagnationAlertStateStore = createInMemoryStagnationStore();
    assert.equal(store.get("cycleYield:orch"), null);
    store.set("cycleYield:orch", "breach");
    assert.equal(store.get("cycleYield:orch"), "breach");
    store.set("cycleYield:orch", "ok");
    assert.equal(store.get("cycleYield:orch"), "ok");
  });
});
