/**
 * Regression tests for stuckness-driven anchor selection (issue #253,
 * ADR-0003 vision vector 1).
 *
 * Bug class this guards against:
 *   - Vision vector 1 violated: when an outcome is stuck, the orchestrator
 *     keeps pulling from the kanban queue instead of researching the cause.
 *   - Cooldown not respected: same stuck outcome re-picked every cycle,
 *     starving other work and burning planner cost on duplicate research.
 *   - Leading vs terminal: terminal calibration cycles are too slow to act
 *     on per-cycle; leading outcomes must win when both are stuck.
 *   - Determinism: when multiple outcomes are stuck with the same depth,
 *     lex-by-name tiebreak ensures the same anchor is chosen across cycles.
 *   - Telemetry: `anchor.selected.stuckness` event must fire on selection.
 *
 * These tests exercise the pure helpers (`pickStuckOutcome`,
 * `buildStucknessAnchor`) directly — full `selectAnchor()` integration is
 * covered by the existing drift-prefilter test suite and not duplicated here.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import type { StucknessResult } from "../src/stuckness.ts";

// Shared across both describe blocks — closing in one would break the other.
// node:test runs `after()` hooks per suite, so we connect once and disconnect
// from a single top-level after() at the end of the file.
let redis: any;
let modCache: any;

async function ensureRedis() {
  if (!redis) {
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
    redis = new Redis(process.env.REDIS_URL);
  }
  if (!modCache) {
    modCache = await import("../src/anchor-selection.ts");
  }
  return { redis, mod: modCache };
}

async function cleanKeys() {
  if (!redis) return;
  const keys = await redis.keys("hydra:stuckness:cooldown:*");
  if (keys.length > 0) await redis.del(...keys);
}

after(async () => {
  if (redis) {
    await cleanKeys();
    redis.disconnect();
    redis = null;
  }
});

function stuckRow(overrides: Partial<StucknessResult>): StucknessResult {
  return {
    name: "outcome-default",
    cyclesStuck: 0,
    fired: false,
    threshold: 5,
    lastFavorableCycleId: null,
    kind: "leading",
    ...overrides,
  };
}

describe("pickStuckOutcome — selection rules (issue #253)", () => {
  let pickStuckOutcome: any;
  let stucknessCooldownKey: any;

  beforeEach(async () => {
    const { mod } = await ensureRedis();
    pickStuckOutcome = mod._testing.pickStuckOutcome;
    stucknessCooldownKey = mod._testing.stucknessCooldownKey;
    await cleanKeys();
  });

  test("no fired outcomes => returns null (existing priority chain unchanged)", async () => {
    const rows = [
      stuckRow({ name: "a", fired: false, cyclesStuck: 1 }),
      stuckRow({ name: "b", fired: false, cyclesStuck: 2 }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick, null);
  });

  test("empty rows => returns null", async () => {
    const pick = await pickStuckOutcome([]);
    assert.equal(pick, null);
  });

  test("single leading-stuck outcome => selected", async () => {
    const rows = [
      stuckRow({ name: "merge-rate", fired: true, cyclesStuck: 7, kind: "leading" }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.ok(pick);
    assert.equal(pick.name, "merge-rate");
    assert.equal(pick.cyclesStuck, 7);
  });

  test("multiple leading-stuck => most-stuck (highest cyclesStuck) wins", async () => {
    const rows = [
      stuckRow({ name: "a", fired: true, cyclesStuck: 6, kind: "leading" }),
      stuckRow({ name: "b", fired: true, cyclesStuck: 12, kind: "leading" }),
      stuckRow({ name: "c", fired: true, cyclesStuck: 8, kind: "leading" }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick!.name, "b", "deepest-stuck wins");
    assert.equal(pick!.cyclesStuck, 12);
  });

  test("tie on cyclesStuck => lexicographic name wins", async () => {
    const rows = [
      stuckRow({ name: "zeta", fired: true, cyclesStuck: 9, kind: "leading" }),
      stuckRow({ name: "alpha", fired: true, cyclesStuck: 9, kind: "leading" }),
      stuckRow({ name: "mu", fired: true, cyclesStuck: 9, kind: "leading" }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick!.name, "alpha");
  });

  test("leading wins over terminal even when terminal is more stuck", async () => {
    const rows = [
      stuckRow({ name: "terminal-deep", fired: true, cyclesStuck: 50, kind: "terminal" }),
      stuckRow({ name: "leading-shallow", fired: true, cyclesStuck: 6, kind: "leading" }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick!.name, "leading-shallow");
    assert.equal(pick!.kind, "leading");
  });

  test("terminal-only stuck => terminal is selected", async () => {
    const rows = [
      stuckRow({ name: "term-1", fired: true, cyclesStuck: 20, kind: "terminal" }),
      stuckRow({ name: "lead-ok", fired: false, cyclesStuck: 0, kind: "leading" }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick!.name, "term-1");
    assert.equal(pick!.kind, "terminal");
  });

  test("cooldown short-circuits selection of the same outcome", async () => {
    const rows = [
      stuckRow({ name: "lead-x", fired: true, cyclesStuck: 7, kind: "leading" }),
    ];
    // Seed cooldown.
    await redis.set(stucknessCooldownKey("lead-x"), "1", "EX", 60);
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick, null, "cooled-down outcome must not be re-picked");
  });

  test("cooldown on one outcome falls through to next eligible", async () => {
    const rows = [
      stuckRow({ name: "lead-cooled", fired: true, cyclesStuck: 20, kind: "leading" }),
      stuckRow({ name: "lead-fresh", fired: true, cyclesStuck: 6, kind: "leading" }),
    ];
    await redis.set(stucknessCooldownKey("lead-cooled"), "1", "EX", 60);
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick!.name, "lead-fresh", "fall-through picks the non-cooled-down leading outcome");
  });

  test("missing kind treated as leading (defensive default)", async () => {
    const rows = [
      // Legacy / synthesized rows that lack kind — treat as leading so we
      // don't silently de-prioritise a real signal.
      stuckRow({ name: "no-kind", fired: true, cyclesStuck: 8, kind: undefined }),
      stuckRow({ name: "terminal-x", fired: true, cyclesStuck: 50, kind: "terminal" }),
    ];
    const pick = await pickStuckOutcome(rows);
    assert.equal(pick!.name, "no-kind", "missing-kind row treated as leading and wins over terminal");
  });
});

describe("buildStucknessAnchor — shape, cooldown side-effect, telemetry (issue #253)", () => {
  let buildStucknessAnchor: any;
  let stucknessCooldownKey: any;

  beforeEach(async () => {
    const { mod } = await ensureRedis();
    buildStucknessAnchor = mod._testing.buildStucknessAnchor;
    stucknessCooldownKey = mod._testing.stucknessCooldownKey;
    await cleanKeys();
  });

  test("anchor has reference 'outcome-stuckness:<name>', research type, orchestrator-self-improvement domain", async () => {
    const row = stuckRow({ name: "merge-rate", fired: true, cyclesStuck: 11, threshold: 5, kind: "leading" });
    const events: any[] = [];
    const fakeBus = { async publish(stream: string, evt: any) { events.push({ stream, evt }); return "id"; } };
    const anchor = await buildStucknessAnchor(row, fakeBus);
    assert.equal(anchor.type, "research");
    assert.equal(anchor.reference, "outcome-stuckness:merge-rate");
    assert.equal(anchor.domain, "orchestrator-self-improvement");
    assert.equal(anchor.priority, 0);
    assert.ok(typeof anchor.description === "string");
    assert.match(anchor.description, /11 cycles/);
    assert.match(anchor.description, /threshold 5/);
    assert.match(anchor.description, /Vision vector 1/i);
  });

  test("terminal outcome gets calibration-cycles flag in description", async () => {
    const row = stuckRow({ name: "shipped-revenue", fired: true, cyclesStuck: 25, threshold: 20, kind: "terminal" });
    const anchor = await buildStucknessAnchor(row, null);
    assert.match(anchor.description, /terminal outcome/i);
    assert.match(anchor.description, /calibration cycles are slow/i);
  });

  test("leading outcome does NOT get the terminal-flag note", async () => {
    const row = stuckRow({ name: "merge-rate", fired: true, cyclesStuck: 9, threshold: 5, kind: "leading" });
    const anchor = await buildStucknessAnchor(row, null);
    assert.doesNotMatch(anchor.description, /terminal outcome/i);
    assert.doesNotMatch(anchor.description, /calibration cycles/i);
  });

  test("emits anchor.selected.stuckness on NOTIFICATIONS with cycle/threshold/kind", async () => {
    const row = stuckRow({ name: "merge-rate", fired: true, cyclesStuck: 7, threshold: 5, kind: "leading" });
    const events: any[] = [];
    const fakeBus = { async publish(stream: string, evt: any) { events.push({ stream, evt }); return "id"; } };
    await buildStucknessAnchor(row, fakeBus);
    assert.equal(events.length, 1);
    assert.equal(events[0].evt.type, "anchor.selected.stuckness");
    assert.equal(events[0].evt.source, "anchor-selection");
    assert.equal(events[0].evt.payload.outcomeName, "merge-rate");
    assert.equal(events[0].evt.payload.cycles, 7);
    assert.equal(events[0].evt.payload.threshold, 5);
    assert.equal(events[0].evt.payload.kind, "leading");
  });

  test("sets cooldown key with TTL ~30min so the same outcome is suppressed next cycle", async () => {
    const row = stuckRow({ name: "lead-y", fired: true, cyclesStuck: 7, threshold: 5, kind: "leading" });
    await buildStucknessAnchor(row, null);
    const value = await redis.get(stucknessCooldownKey("lead-y"));
    assert.equal(value, "1", "cooldown key is set");
    const ttl = await redis.ttl(stucknessCooldownKey("lead-y"));
    assert.ok(ttl > 0 && ttl <= 30 * 60, `cooldown TTL should be 0 < t <= 30min, got ${ttl}s`);
  });

  test("missing eventBus is tolerated (no throw)", async () => {
    const row = stuckRow({ name: "lead-z", fired: true, cyclesStuck: 6, threshold: 5, kind: "leading" });
    // Must not throw even when called with null/undefined eventBus.
    await buildStucknessAnchor(row, null);
    await buildStucknessAnchor(row, undefined);
  });

  test("eventBus publish failure does not break anchor build", async () => {
    const row = stuckRow({ name: "lead-q", fired: true, cyclesStuck: 7, threshold: 5, kind: "leading" });
    const fakeBus = {
      async publish() { throw new Error("simulated bus failure"); },
    };
    const originalError = console.error;
    const captured: string[] = [];
    console.error = (...args: any[]) => { captured.push(args.join(" ")); };
    try {
      const anchor = await buildStucknessAnchor(row, fakeBus);
      // Anchor still returned correctly.
      assert.equal(anchor.reference, "outcome-stuckness:lead-q");
      assert.ok(
        captured.some((m) => m.includes("anchor.selected.stuckness")),
        `expected publish-failure log, got: ${JSON.stringify(captured)}`,
      );
    } finally {
      console.error = originalError;
    }
  });
});
