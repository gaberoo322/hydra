/**
 * Regression tests for the outcome-attribution live recorder (issue #2632,
 * epic #2628): the per-metric window state machine (`windows.ts`) + the
 * merge-landing recorder chore (`subscribe.ts`) + the #2632 seam extensions
 * (void tombstone, window state, reverted-merge registry).
 *
 * Two layers, mirroring outcome-attribution-recorder.test.mts:
 *   1. Pure policy + chore decision logic against FAKE deps (no Redis, no gh):
 *      window duration/id, per-metric independent close, baseline snapshot at
 *      open, dark-metric skip on close, void tombstone on revert, fail-loud.
 *   2. The Redis accessor round-trip against a live Redis (DB 1, skipped if
 *      unreachable): open→list→close windows; append void marker → getLedger
 *      sees it but getObservations filters it; reverted-merge registry round-trip.
 *
 * Bug class this guards against:
 *   - A long-lived EventBus consumer / timer (the chore is drained at cadence).
 *   - All metrics sharing one window duration (each must close on its own).
 *   - Not snapshotting a baseline at window open.
 *   - Emitting a synthetic zero for a dark metric on close.
 *   - Deleting a reverted PR's rows instead of appending a void tombstone.
 *   - A failure throwing out of the chore instead of being logged + counted.
 */

// Point the Redis singleton at DB 1 before any seam import (matches sibling tests).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import type { LeadingOutcomeSample } from "../src/outcome-regression.ts";
import type { LoadOutcomesResult } from "../src/outcomes.ts";
import type {
  AttributionLedger,
  AttributionObservation,
  VoidMarker,
  AppendObservationResult,
  LoadObservationsResult,
} from "../src/redis/attribution-ledger.ts";
import type { AttributionWindow } from "../src/redis/attribution-windows.ts";
import type { RevertedMerge } from "../src/redis/attribution-reverted.ts";
import {
  appendObservation,
  appendVoidMarker,
  getObservations,
  getLedger,
  isVoidMarker,
  _resetLedger,
} from "../src/redis/attribution-ledger.ts";
import {
  openWindow,
  listOpenWindows,
  closeWindow,
  _resetWindows,
} from "../src/redis/attribution-windows.ts";
import {
  markMergeReverted,
  listRevertedMerges,
  removeRevertedMerge,
  _resetReverted,
} from "../src/redis/attribution-reverted.ts";
import {
  windowDurationMs,
  windowId,
  buildWindowsForMerge,
  dueWindows,
  selectMergesToOpen,
  ATTRIBUTION_DEFAULT_WINDOW_MS,
  type MergeWindowContext,
} from "../src/outcome-attribution/windows.ts";
import type { PendingEnrollEntry } from "../src/redis/holdback-merge-watch.ts";
import {
  runAttributionRecord,
  type AttributionRecordDeps,
  type MergeStatus,
} from "../src/outcome-attribution/subscribe.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fake, in-memory append-only ledger recording observations + voids. */
function makeFakeLedger(): AttributionLedger & {
  observations: AttributionObservation[];
  voids: VoidMarker[];
} {
  const observations: AttributionObservation[] = [];
  const voids: VoidMarker[] = [];
  return {
    observations,
    voids,
    async appendObservation(obs: AttributionObservation): Promise<AppendObservationResult> {
      observations.push(obs);
      return { ok: true };
    },
    async appendVoidMarker(marker: VoidMarker): Promise<AppendObservationResult> {
      voids.push(marker);
      return { ok: true };
    },
    async getObservations(): Promise<LoadObservationsResult> {
      return { ok: true, observations: [...observations] };
    },
  };
}

/** An in-memory open-window store honoring the seam signatures. */
function makeWindowStore() {
  const map = new Map<string, AttributionWindow>();
  return {
    map,
    openWindowFn: async (w: AttributionWindow) => {
      map.set(w.id, w);
      return { ok: true as const };
    },
    listWindowsFn: async () => ({
      ok: true as const,
      windows: [...map.values()].sort((a, b) => a.closesAt - b.closesAt),
    }),
    closeWindowFn: async (id: string) => {
      map.delete(id);
    },
  };
}

const LEADING: LeadingOutcomeSample[] = [
  { name: "fast-metric", direction: "up", noiseEpsilon: 0, value: 100 },
  { name: "slow-metric", direction: "down", noiseEpsilon: 0, value: 0.25 },
];

function outcomesLoader(
  windows: Record<string, number | undefined>,
): AttributionRecordDeps["loadOutcomesFn"] {
  return async (): Promise<LoadOutcomesResult> => ({
    ok: true,
    outcomes: Object.entries(windows).map(([name, ms]) => ({
      name,
      kind: "leading" as const,
      direction: "up" as const,
      source: "file" as const,
      query: `metrics/${name}.txt`,
      baseline: 0,
      target: 1,
      noise_epsilon: 0,
      ...(ms !== undefined ? { attribution_window_ms: ms } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// Layer 1a — pure window policy
// ---------------------------------------------------------------------------

describe("windows.ts — pure window policy (#2632)", () => {
  test("windowDurationMs: config wins, else conservative default", () => {
    assert.equal(windowDurationMs(60_000), 60_000);
    assert.equal(windowDurationMs(undefined), ATTRIBUTION_DEFAULT_WINDOW_MS);
    // Invalid values fall back to default.
    assert.equal(windowDurationMs(0), ATTRIBUTION_DEFAULT_WINDOW_MS);
    assert.equal(windowDurationMs(-5), ATTRIBUTION_DEFAULT_WINDOW_MS);
    assert.equal(windowDurationMs(Number.NaN), ATTRIBUTION_DEFAULT_WINDOW_MS);
  });

  test("ATTRIBUTION_DEFAULT_WINDOW_MS is a daily (not weekly) cadence (#3404)", () => {
    // Regression guard for #3404: the default window governs every UNCONFIGURED
    // leading metric, so a week-long default kept the impact ledger structurally
    // DARK (`metricCount: 0`) for a full week after the spine began opening
    // windows — no window closed → no observation row → the discovery
    // reverse-loop fell back to the notice-based signals it was built to
    // replace. The default MUST stay on a daily cadence so an unconfigured
    // metric produces a ledger row within a day. A genuinely slow metric opts
    // into a LONGER window per-metric via `attribution_window_ms`; this bound
    // does not constrain that escape hatch.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    assert.equal(
      ATTRIBUTION_DEFAULT_WINDOW_MS,
      ONE_DAY_MS,
      "default window must be exactly one day so the impact ledger is not dark for a week (#3404)",
    );
    // Explicit upper bound: never regress back to a multi-day default that
    // re-darkens the ledger for the continuous discovery loop.
    assert.ok(
      ATTRIBUTION_DEFAULT_WINDOW_MS <= 2 * ONE_DAY_MS,
      "default window must be <= 2 days so discovery gets impact signal on a daily cadence (#3404)",
    );
    // An unconfigured metric (windowDurationMs(undefined)) closes within a day.
    assert.ok(windowDurationMs(undefined) <= ONE_DAY_MS);
  });

  test("windowId: stable, SHA-preferred, PR fallback", () => {
    assert.equal(windowId("m", "abc123", 42), "m@abc123");
    assert.equal(windowId("m", null, 42), "m@pr-42");
    assert.equal(windowId("m", "", 42), "m@pr-42");
    assert.equal(windowId("m", null, null), "m@unknown");
  });

  test("buildWindowsForMerge: one window per metric, baseline snapshot + own closesAt", () => {
    const ctx: MergeWindowContext = {
      sourcePrNumbers: [7],
      sourceCommitSha: "sha7",
      classCounts: { dev_orch: 1 },
      scopeTouched: "orch",
      tier: 3,
    };
    const metricWindowMs = new Map<string, number | undefined>([
      ["fast-metric", 1_000],
      ["slow-metric", 100_000],
    ]);
    const windows = buildWindowsForMerge(LEADING, metricWindowMs, ctx, 500);
    assert.equal(windows.length, 2);
    const fast = windows.find((w) => w.metric === "fast-metric")!;
    const slow = windows.find((w) => w.metric === "slow-metric")!;
    // Baseline value snapshotted at open.
    assert.equal(fast.baselineValue, 100);
    assert.equal(slow.baselineValue, 0.25);
    // Each metric closes on ITS OWN duration (fast != slow).
    assert.equal(fast.closesAt, 500 + 1_000);
    assert.equal(slow.closesAt, 500 + 100_000);
    // Merge-identity carried for later voiding.
    assert.deepEqual(fast.sourcePrNumbers, [7]);
    assert.equal(fast.sourceCommitSha, "sha7");
    assert.deepEqual(fast.classCounts, { dev_orch: 1 });
    assert.equal(fast.tier, 3);
  });

  test("dueWindows: partitions by closesAt independently", () => {
    const mk = (id: string, closesAt: number): AttributionWindow => ({
      id,
      metric: id,
      baselineValue: 1,
      openedAt: 0,
      closesAt,
      classCounts: {},
      scopeTouched: "orch",
      tier: null,
      sourcePrNumbers: [],
      sourceCommitSha: null,
    });
    const { due, stillOpen } = dueWindows([mk("a", 100), mk("b", 500)], 200);
    assert.deepEqual(due.map((w) => w.id), ["a"]);
    assert.deepEqual(stillOpen.map((w) => w.id), ["b"]);
  });

  test("selectMergesToOpen: landed AND not-already-opened, in input order", () => {
    const mkEntry = (prNumber: number): PendingEnrollEntry => ({
      prNumber,
      tier: 3,
      cycleId: `cycle-${prNumber}-dev_orch`,
      registeredAt: 0,
    });
    const entries = [mkEntry(1), mkEntry(2), mkEntry(3), mkEntry(4)];
    const statusByPr = new Map([
      [1, { state: "MERGED", mergeCommitSha: "sha1" }], // landed, new → OPEN
      [2, { state: "OPEN", mergeCommitSha: null }], // not landed → skip
      [3, { state: "MERGED", mergeCommitSha: "sha3" }], // landed but already opened → skip
      // pr 4 has NO status (fetch failed upstream) → skip
    ]);
    const commitsWithWindows = new Set<string>(["sha3"]);

    const toOpen = selectMergesToOpen(entries, statusByPr, commitsWithWindows);

    assert.deepEqual(
      toOpen.map((m) => ({ pr: m.entry.prNumber, sha: m.mergeCommitSha })),
      [{ pr: 1, sha: "sha1" }],
    );
  });

  test("selectMergesToOpen: preserves input order across multiple opens", () => {
    const mkEntry = (prNumber: number): PendingEnrollEntry => ({
      prNumber,
      tier: null,
      cycleId: `cycle-${prNumber}`,
      registeredAt: 0,
    });
    const entries = [mkEntry(10), mkEntry(20)];
    const statusByPr = new Map([
      [10, { state: "MERGED", mergeCommitSha: "shaA" }],
      [20, { state: "MERGED", mergeCommitSha: "shaB" }],
    ]);
    const toOpen = selectMergesToOpen(entries, statusByPr, new Set());
    assert.deepEqual(toOpen.map((m) => m.entry.prNumber), [10, 20]);
    assert.deepEqual(toOpen.map((m) => m.mergeCommitSha), ["shaA", "shaB"]);
  });
});

// The pure producer-class derivation (producerClassFromCycleId) moved to the
// Dispatch-Class Taxonomy Module in issue #2920; its unit tests now live in
// test/taxonomy-classes.test.mts, next to classByName / classBySkill.

// ---------------------------------------------------------------------------
// Layer 1c — chore decision logic against fakes
// ---------------------------------------------------------------------------

describe("runAttributionRecord — open/close/void against fakes (#2632)", () => {
  test("landed merge opens one window per live metric (baseline snapshot)", async () => {
    const store = makeWindowStore();
    const ledger = makeFakeLedger();
    const result = await runAttributionRecord({
      ledger,
      listPending: async () => ({
        ok: true,
        entries: [{ prNumber: 7, tier: 3, cycleId: "x-dev_orch", registeredAt: 0 }],
      }),
      fetchMergeStatus: async (): Promise<MergeStatus> => ({ state: "MERGED", mergeCommitSha: "sha7" }),
      snapshot: async () => LEADING,
      loadOutcomesFn: outcomesLoader({ "fast-metric": 1_000, "slow-metric": 100_000 }),
      openWindowFn: store.openWindowFn,
      listWindowsFn: store.listWindowsFn,
      closeWindowFn: store.closeWindowFn,
      listRevertedFn: async () => ({ ok: true, reverts: [] }),
      removeRevertedFn: async () => {},
      nowMs: 1000,
    });
    assert.equal(result.windowsOpened, 2);
    assert.equal(result.windowsClosed, 0);
    assert.equal(store.map.size, 2);
    const fast = store.map.get("fast-metric@sha7")!;
    assert.equal(fast.baselineValue, 100);
    assert.equal(fast.closesAt, 1000 + 1_000);
    assert.deepEqual(fast.classCounts, { dev_orch: 1 });
  });

  test("a still-open (not landed) PR opens no window", async () => {
    const store = makeWindowStore();
    const result = await runAttributionRecord({
      ledger: makeFakeLedger(),
      listPending: async () => ({
        ok: true,
        entries: [{ prNumber: 9, tier: 2, cycleId: "x-dev_orch", registeredAt: 0 }],
      }),
      fetchMergeStatus: async (): Promise<MergeStatus> => ({ state: "OPEN", mergeCommitSha: null }),
      snapshot: async () => LEADING,
      loadOutcomesFn: outcomesLoader({}),
      openWindowFn: store.openWindowFn,
      listWindowsFn: store.listWindowsFn,
      closeWindowFn: store.closeWindowFn,
      listRevertedFn: async () => ({ ok: true, reverts: [] }),
      removeRevertedFn: async () => {},
      nowMs: 1000,
    });
    assert.equal(result.windowsOpened, 0);
    assert.equal(store.map.size, 0);
  });

  test("only the DUE window closes; each metric on its own duration", async () => {
    const store = makeWindowStore();
    const ledger = makeFakeLedger();
    // Pre-seed two open windows: fast closes at 2000, slow at 200000.
    store.map.set("fast-metric@sha7", {
      id: "fast-metric@sha7",
      metric: "fast-metric",
      baselineValue: 100,
      openedAt: 1000,
      closesAt: 2000,
      classCounts: { dev_orch: 1 },
      scopeTouched: "orch",
      tier: 3,
      sourcePrNumbers: [7],
      sourceCommitSha: "sha7",
    });
    store.map.set("slow-metric@sha7", {
      id: "slow-metric@sha7",
      metric: "slow-metric",
      baselineValue: 0.25,
      openedAt: 1000,
      closesAt: 200000,
      classCounts: { dev_orch: 1 },
      scopeTouched: "orch",
      tier: 3,
      sourcePrNumbers: [7],
      sourceCommitSha: "sha7",
    });
    const result = await runAttributionRecord({
      ledger,
      listPending: async () => ({ ok: true, entries: [] }),
      fetchMergeStatus: async (): Promise<MergeStatus> => ({ state: "MERGED", mergeCommitSha: "sha7" }),
      // current: fast moved +5 (105), slow moved -0.05 (0.20).
      snapshot: async () => [
        { name: "fast-metric", direction: "up", noiseEpsilon: 0, value: 105 },
        { name: "slow-metric", direction: "down", noiseEpsilon: 0, value: 0.2 },
      ],
      loadOutcomesFn: outcomesLoader({}),
      openWindowFn: store.openWindowFn,
      listWindowsFn: store.listWindowsFn,
      closeWindowFn: store.closeWindowFn,
      listRevertedFn: async () => ({ ok: true, reverts: [] }),
      removeRevertedFn: async () => {},
      nowMs: 5000, // fast is due (2000<=5000), slow is not (200000>5000)
    });
    assert.equal(result.windowsClosed, 1);
    assert.equal(result.rowsAppended, 1);
    assert.equal(ledger.observations.length, 1);
    const row = ledger.observations[0];
    assert.equal(row.metric, "fast-metric");
    assert.equal(row.delta, 5); // 105 - 100
    // Merge-identity attached for later voiding.
    assert.deepEqual(row.sourcePrNumbers, [7]);
    assert.equal(row.sourceCommitSha, "sha7");
    // The slow window stays open.
    assert.ok(store.map.has("slow-metric@sha7"));
    assert.ok(!store.map.has("fast-metric@sha7"));
  });

  test("dark metric on close appends NO row (never a synthetic zero)", async () => {
    const store = makeWindowStore();
    const ledger = makeFakeLedger();
    store.map.set("fast-metric@sha7", {
      id: "fast-metric@sha7",
      metric: "fast-metric",
      baselineValue: 100,
      openedAt: 0,
      closesAt: 10,
      classCounts: { dev_orch: 1 },
      scopeTouched: "orch",
      tier: 3,
      sourcePrNumbers: [7],
      sourceCommitSha: "sha7",
    });
    const result = await runAttributionRecord({
      ledger,
      listPending: async () => ({ ok: true, entries: [] }),
      fetchMergeStatus: async (): Promise<MergeStatus> => ({ state: "MERGED", mergeCommitSha: "sha7" }),
      // current value null → dark on the current side.
      snapshot: async () => [{ name: "fast-metric", direction: "up", noiseEpsilon: 0, value: null }],
      loadOutcomesFn: outcomesLoader({}),
      openWindowFn: store.openWindowFn,
      listWindowsFn: store.listWindowsFn,
      closeWindowFn: store.closeWindowFn,
      listRevertedFn: async () => ({ ok: true, reverts: [] }),
      removeRevertedFn: async () => {},
      nowMs: 100,
    });
    assert.equal(result.rowsAppended, 0);
    assert.equal(ledger.observations.length, 0);
    // Window is still closed (drained) even though it produced no row.
    assert.equal(result.windowsClosed, 1);
    assert.ok(!store.map.has("fast-metric@sha7"));
  });

  test("reverted merge appends a VOID tombstone (append, not delete) and drains the registry", async () => {
    const ledger = makeFakeLedger();
    let removed: { commitSha: string | null; prNumber: number | null } | null = null;
    const result = await runAttributionRecord({
      ledger,
      listPending: async () => ({ ok: true, entries: [] }),
      fetchMergeStatus: async (): Promise<MergeStatus> => ({ state: "MERGED", mergeCommitSha: "x" }),
      snapshot: async () => LEADING,
      loadOutcomesFn: outcomesLoader({}),
      listWindowsFn: async () => ({ ok: true, windows: [] }),
      openWindowFn: async () => ({ ok: true }),
      closeWindowFn: async () => {},
      listRevertedFn: async () => ({
        ok: true,
        reverts: [{ prNumber: 7, commitSha: "sha7", revertedAt: 0 }],
      }),
      removeRevertedFn: async (e) => {
        removed = e;
      },
      nowMs: 9000,
    });
    assert.equal(result.voidsAppended, 1);
    assert.equal(ledger.voids.length, 1);
    const v = ledger.voids[0];
    assert.equal(v.kind, "void");
    assert.equal(v.voidedPrNumber, 7);
    assert.equal(v.voidedCommitSha, "sha7");
    assert.equal(v.reason, "holdback-revert");
    assert.deepEqual(removed, { commitSha: "sha7", prNumber: 7 });
  });

  test("fail-loud: a pending-list failure is counted, never thrown", async () => {
    const store = makeWindowStore();
    // No throw should escape; errors counter increments.
    const result = await runAttributionRecord({
      ledger: makeFakeLedger(),
      listPending: async () => ({ ok: false, error: "redis down" }),
      fetchMergeStatus: async (): Promise<MergeStatus> => ({ state: "MERGED", mergeCommitSha: "x" }),
      snapshot: async () => LEADING,
      loadOutcomesFn: outcomesLoader({}),
      openWindowFn: store.openWindowFn,
      listWindowsFn: store.listWindowsFn,
      closeWindowFn: store.closeWindowFn,
      listRevertedFn: async () => ({ ok: true, reverts: [] }),
      removeRevertedFn: async () => {},
      nowMs: 1,
    });
    assert.ok(result.errors >= 1);
    assert.equal(result.windowsOpened, 0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — live Redis round-trip (DB 1; skipped if unreachable)
// ---------------------------------------------------------------------------

describe("attribution seam #2632 — live Redis round-trip", () => {
  let probe: Redis;
  let reachable = false;

  before(async () => {
    // Single-string-arg ioredis overload (`new Redis(url)`), matching
    // outcome-attribution-recorder.test.mts / holdback.test.mts: it connects on
    // construction; `ping()` (guarded by the catch) surfaces an unreachable
    // Redis so the live-DB cases self-skip cleanly.
    probe = new Redis(process.env.REDIS_URL!);
    try {
      await probe.ping();
      reachable = true;
    } catch {
      /* intentional: Redis not up in this env — the round-trip cases self-skip. */
      reachable = false;
    }
  });

  after(async () => {
    if (reachable) {
      await _resetLedger();
      await _resetWindows();
      await _resetReverted();
    }
    if (probe) probe.disconnect();
  });

  beforeEach(async () => {
    if (!reachable) return;
    await _resetLedger();
    await _resetWindows();
    await _resetReverted();
  });

  test("open → list → close windows round-trips (durable across restart)", async (t) => {
    if (!reachable) return t.skip("Redis unreachable");
    const w: AttributionWindow = {
      id: "fast-metric@sha7",
      metric: "fast-metric",
      baselineValue: 100,
      openedAt: 1000,
      closesAt: 2000,
      classCounts: { dev_orch: 1 },
      scopeTouched: "orch",
      tier: 3,
      sourcePrNumbers: [7],
      sourceCommitSha: "sha7",
    };
    assert.deepEqual(await openWindow(w), { ok: true });
    const listed = await listOpenWindows();
    assert.equal(listed.ok, true);
    assert.equal(listed.ok && listed.windows.length, 1);
    assert.deepEqual(listed.ok && listed.windows[0], w);
    await closeWindow(w.id);
    const after = await listOpenWindows();
    assert.equal(after.ok && after.windows.length, 0);
  });

  test("void tombstone: getLedger sees it, getObservations filters it (append-only)", async (t) => {
    if (!reachable) return t.skip("Redis unreachable");
    const obs: AttributionObservation = {
      metric: "fast-metric",
      delta: 5,
      classCounts: { dev_orch: 1 },
      scopeTouched: "orch",
      tier: 3,
      recordedAt: 1,
      sourcePrNumbers: [7],
      sourceCommitSha: "sha7",
    };
    assert.deepEqual(await appendObservation(obs), { ok: true });
    const marker: VoidMarker = {
      kind: "void",
      voidedPrNumber: 7,
      voidedCommitSha: "sha7",
      reason: "holdback-revert",
      recordedAt: 2,
    };
    assert.deepEqual(await appendVoidMarker(marker), { ok: true });

    // Full ledger keeps BOTH rows in append order (nothing deleted/trimmed).
    const ledger = await getLedger();
    assert.equal(ledger.ok, true);
    assert.equal(ledger.ok && ledger.rows.length, 2);
    assert.equal(ledger.ok && isVoidMarker(ledger.rows[1]), true);
    // getObservations filters the void, preserving the #2629 contract.
    const observations = await getObservations();
    assert.equal(observations.ok, true);
    assert.equal(observations.ok && observations.observations.length, 1);
    assert.equal(observations.ok && observations.observations[0].metric, "fast-metric");
  });

  test("reverted-merge registry round-trips and removes", async (t) => {
    if (!reachable) return t.skip("Redis unreachable");
    const entry: RevertedMerge = { prNumber: 7, commitSha: "sha7", revertedAt: 5 };
    assert.deepEqual(await markMergeReverted(entry), { ok: true });
    const listed = await listRevertedMerges();
    assert.equal(listed.ok && listed.reverts.length, 1);
    assert.deepEqual(listed.ok && listed.reverts[0], entry);
    await removeRevertedMerge({ commitSha: "sha7", prNumber: 7 });
    const after = await listRevertedMerges();
    assert.equal(after.ok && after.reverts.length, 0);
  });
});
