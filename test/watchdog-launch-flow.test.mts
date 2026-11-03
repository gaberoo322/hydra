/**
 * LAUNCH FLOW detection (issue #3847, epic #3844; ported to TypeScript by
 * issue #5097, epic #5094).
 *
 * The check lives in `src/watchdog/launch-flow.ts` (pure `decideLaunchFlow`
 * membership + `runLaunchFlow` over injected ports) on top of the one shared
 * episode tracker in `src/watchdog/episode.ts`. Every case below drives the
 * real functions over the in-memory ports in `test/_helpers/launch-flow-fakes.mts`
 * — no bash, no docker, no wall-clock waits: `now` is the injected
 * `LaunchFlowConfig.nowMs`.
 *
 * Delivery (pages / bus envelope) is asserted in test/launch-flow-delivery.test.mts.
 */

import test, { describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  LAUNCH_FLOW_KEY_PREFIX,
  LAUNCH_FLOW_REASON_SIGNAL,
  PACE_GATE_LAST_TICK_KEY,
  WATCHDOG_LAUNCH_SIGNALS,
  classifyLaunchSignal,
  clearLaunchFlowStreak,
  getLaunchFlowSince,
  getPaceGateLastTick,
  isLaunchFlowFired,
  launchFlowEpisodeKeys,
  launchFlowFiredKey,
  launchFlowSinceKey,
} from "../src/redis/launch-flow.ts";
import {
  anchorEpisodeSince,
  clearEpisodeKeys,
  episodeFiredExists,
  markEpisodeFired,
  readEpisodeSince,
} from "../src/redis/watchdog-episodes.ts";
import { getRedisConnection } from "../src/redis/connection.ts";
import { decideEpisode, runEpisode } from "../src/watchdog/episode.ts";
import {
  DEFAULT_LAUNCH_FLOW_CONFIG,
  LAUNCH_FLOW_LOG_PREFIX,
  decideLaunchFlow,
  runLaunchFlow,
  type LaunchFlowConfig,
} from "../src/watchdog/launch-flow.ts";
import { T0, firedOf, makeHarness, memoryEpisodeStore, seedFired, seedSince, sinceOf } from "./_helpers/launch-flow-fakes.mts";

const HOUR = 3_600_000;
/** The default threshold (ms) of each reason-keyed signal. */
const THRESHOLD_MS = { "fail-safe": 2 * HOUR, "meter-dark": 2 * HOUR, quota: 4 * HOUR, pause: 24 * HOUR, latency: HOUR } as const;

function cfg(over: Partial<LaunchFlowConfig> = {}): LaunchFlowConfig {
  return { ...DEFAULT_LAUNCH_FLOW_CONFIG, nowMs: T0, ...over };
}

const warnLines = (logs: string[]): string[] => logs.filter((l) => l.includes("WARNING LAUNCH FLOW"));

// ---------------------------------------------------------------------------
// decideEpisode — the pure rule (INV-2, INV-3)
// ---------------------------------------------------------------------------

describe("decideEpisode — the one pure episode rule (issue #5097, INV-2/INV-3)", () => {
  const base = { fired: false, nowMs: T0, thresholdMs: 1000 };

  test("member with no anchor yet: the first tick anchors (duration 0)", () => {
    assert.deepEqual(decideEpisode({ ...base, member: true, sinceMs: null }), { kind: "anchor", durationMs: 0 });
  });

  test("member below threshold with an anchor extends", () => {
    assert.deepEqual(decideEpisode({ ...base, member: true, sinceMs: T0 - 999 }), { kind: "extend", durationMs: 999 });
  });

  test("member at EXACTLY the threshold fires (>=), and only while the fired marker is absent", () => {
    assert.deepEqual(decideEpisode({ ...base, member: true, sinceMs: T0 - 1000 }), { kind: "fire", durationMs: 1000 });
    assert.deepEqual(decideEpisode({ ...base, member: true, sinceMs: T0 - 5000, fired: true }), { kind: "noop", durationMs: 5000 });
  });

  test("a zero threshold fires on the very first (unanchored) tick, as the SET NX bash did", () => {
    assert.deepEqual(decideEpisode({ ...base, member: true, sinceMs: null, thresholdMs: 0 }), { kind: "fire", durationMs: 0 });
  });

  test("a negative duration (anchor in the future) clamps to 0", () => {
    assert.deepEqual(decideEpisode({ ...base, member: true, sinceMs: T0 + 5000 }), { kind: "extend", durationMs: 0 });
  });

  test("non-member: recover when the fired marker existed, otherwise a silent clear", () => {
    assert.deepEqual(decideEpisode({ ...base, member: false, sinceMs: T0 - 9999, fired: true }), { kind: "recover", durationMs: 0 });
    assert.deepEqual(decideEpisode({ ...base, member: false, sinceMs: null, fired: false }), { kind: "clear", durationMs: 0 });
  });
});

describe("runEpisode — applies the decision over an EpisodeStore (issue #5097)", () => {
  const keys = launchFlowEpisodeKeys("quota");
  const input = (member: boolean, thresholdMs = 1000) => ({ signal: "quota", member, nowMs: T0, thresholdMs });
  function hooks() {
    const calls: string[] = [];
    return {
      calls,
      h: {
        log: (l: string) => calls.push(`log:${l}`),
        onBelowThreshold: (d: number) => calls.push(`below:${d}`),
        onFire: async (d: number) => {
          calls.push(`fire:${d}`);
        },
        onRecover: async () => {
          calls.push("recover");
        },
      },
    };
  }

  test("the fired marker is SET BEFORE delivery (dedup holds even when delivery fails)", async () => {
    const store = memoryEpisodeStore();
    store.kv.set(keys.since, String(T0 - 5000));
    let firedAtDelivery: boolean | null = null;
    await runEpisode(store, keys, input(true), {
      log: () => {},
      onBelowThreshold: () => {},
      onFire: async () => {
        firedAtDelivery = store.kv.has(keys.fired);
        throw new Error("delivery blew up");
      },
      onRecover: async () => {},
    });
    assert.equal(firedAtDelivery, true, "marker must exist by the time delivery runs");
    assert.equal(store.kv.has(keys.fired), true, "and survive the delivery failure");
  });

  test("fires once: the next tick with the marker present is a noop", async () => {
    const store = memoryEpisodeStore();
    store.kv.set(keys.since, String(T0 - 5000));
    const { calls, h } = hooks();
    await runEpisode(store, keys, input(true), h);
    await runEpisode(store, keys, input(true), h);
    assert.equal(calls.filter((c) => c.startsWith("fire:")).length, 1);
  });

  test("anchoring is SET NX: a later tick never moves the anchor", async () => {
    const store = memoryEpisodeStore();
    const { h } = hooks();
    await runEpisode(store, keys, { ...input(true, 10 * HOUR), nowMs: T0 }, h);
    await runEpisode(store, keys, { ...input(true, 10 * HOUR), nowMs: T0 + 60_000 }, h);
    assert.equal(store.kv.get(keys.since), String(T0));
  });

  test("recover calls onRecover ONLY when the fired marker existed, then DELs both", async () => {
    const store = memoryEpisodeStore();
    store.kv.set(keys.since, String(T0 - 5000));
    store.kv.set(keys.fired, "1");
    const { calls, h } = hooks();
    await runEpisode(store, keys, input(false), h);
    assert.deepEqual(calls, ["recover"]);
    assert.equal(store.kv.size, 0);

    store.kv.set(keys.since, String(T0 - 5000));
    calls.length = 0;
    await runEpisode(store, keys, input(false), h);
    assert.deepEqual(calls, [], "no fired marker -> no recovered message, but the anchor is still cleared");
    assert.equal(store.kv.size, 0);
  });

  test("a thrown store read skips the signal: no extend, no clear, a WARN, null result (INV-4)", async () => {
    const store = memoryEpisodeStore();
    store.kv.set(keys.since, String(T0 - 5000));
    store.kv.set(keys.fired, "1");
    store.failReads = true;
    const { calls, h } = hooks();
    const writesBefore = store.writes.length;
    assert.equal(await runEpisode(store, keys, input(false), h), null);
    assert.equal(await runEpisode(store, keys, input(true), h), null);
    assert.deepEqual(
      calls.filter((c) => !c.startsWith("log:WARN")),
      [],
      "no hook ran",
    );
    assert.ok(calls.some((c) => c.startsWith("log:WARN")), "the skip is a distinguishable WARN");
    assert.equal(store.kv.get(keys.since), String(T0 - 5000), "anchor untouched");
    assert.equal(store.kv.has(keys.fired), true, "fired marker untouched");
    // the member path may anchor with SET NX (a no-op on an existing key) before its read throws
    assert.ok(store.writes.slice(writesBefore).every((w) => w.startsWith("anchor:")), "only the idempotent NX anchor may write");
  });
});

// ---------------------------------------------------------------------------
// decideLaunchFlow — membership (reason -> signal, latency)
// ---------------------------------------------------------------------------

describe("decideLaunchFlow — reason and latency membership (issue #3847, INV-1)", () => {
  const none = { "fail-safe": false, "meter-dark": false, quota: false, pause: false, latency: false };
  const decide = (reason: string, latencyMs: number | null = null) =>
    decideLaunchFlow({ reason, latencyMs, latencyBudgetMs: 1000 });

  test("membership follows classifyLaunchSignal for EVERY mapped reason (the TS table is the only copy)", () => {
    for (const [reason, signal] of Object.entries(LAUNCH_FLOW_REASON_SIGNAL)) {
      assert.equal(classifyLaunchSignal(reason), signal);
      assert.deepEqual(decide(reason), { ...none, [signal as string]: true }, `${reason} -> ${signal} only`);
    }
  });

  test("healthy reasons (launch / already-running / deliberate skips) are members of nothing", () => {
    for (const r of ["eligible-launch", "eligible-exec", "already-running-service", "pace-ahead", "allow-false", "workless-backoff", "unheard-of-reason"]) {
      assert.deepEqual(decide(r), none, r);
    }
  });

  test("latency is INDEPENDENT of reason: over budget extends, at/under budget or absent clears", () => {
    assert.equal(decide("eligible-launch", 1001).latency, true);
    assert.equal(decide("eligible-launch", 1000).latency, false, "the budget itself is not a breach");
    assert.equal(decide("eligible-launch", null).latency, false, "absent latency_ms (probe never reached) clears");
    assert.deepEqual(decide("session-blocked", 5000), { ...none, quota: true, latency: true }, "both can hold at once");
  });

  test("WATCHDOG_LAUNCH_SIGNALS stays the five reason-derived signals; glm-sterile is not in it", () => {
    assert.deepEqual([...WATCHDOG_LAUNCH_SIGNALS], ["fail-safe", "meter-dark", "quota", "pause", "latency"]);
  });
});

// ---------------------------------------------------------------------------
// runLaunchFlow — detection behaviour (ported 1:1 from the bash-backed cases)
// ---------------------------------------------------------------------------

describe("runLaunchFlow — detection behaviour (issue #3847)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  const tick = (reason: string, latencyMs: number | null = null) => {
    h.state.tick = { reason, latencyMs };
  };

  test("fail-safe fires at threshold and sets its fired marker (no re-fire next tick)", async () => {
    tick("eligibility-unreachable");
    seedSince(h.store, "fail-safe", T0 - THRESHOLD_MS["fail-safe"]);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(warnLines(h.logs).length, 1);
    assert.match(warnLines(h.logs)[0], /signal 'fail-safe' sustained 7200000ms >= 7200000ms threshold \(reason=eligibility-unreachable\); see epic #3844/);
    assert.equal(firedOf(h.store, "fail-safe"), true);

    h.logs.length = 0;
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 120_000 }));
    assert.equal(warnLines(h.logs).length, 0, "the fired marker dedups the next tick");
  });

  test("fail-safe does NOT fire under threshold; the first tick anchors at now", async () => {
    tick("curl-missing");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "fail-safe"), T0, "first qualifying tick locks the anchor");
    assert.equal(warnLines(h.logs).length, 0);
    assert.ok(h.logs.some((l) => /signal 'fail-safe' streak 0ms \(< 7200000ms threshold\); not firing/.test(l)));
    assert.equal(firedOf(h.store, "fail-safe"), false);
  });

  test("fail-safe streak resets on any verdict-reached (healthy) tick — stateless recovery", async () => {
    seedSince(h.store, "fail-safe", T0 - HOUR);
    tick("allow-invalid");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "fail-safe"), T0 - HOUR, "still anchored while the streak continues");
    tick("eligible-launch");
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 120_000 }));
    assert.equal(sinceOf(h.store, "fail-safe"), null, "a healthy tick clears the anchor");
    assert.equal(firedOf(h.store, "fail-safe"), false);
  });

  test("meter-dark fires at its own 2h threshold and is distinct from fail-safe", async () => {
    tick("meter-unavailable");
    seedSince(h.store, "meter-dark", T0 - 2 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "meter-dark"), true);
    assert.equal(firedOf(h.store, "fail-safe"), false);
    assert.equal(sinceOf(h.store, "fail-safe"), null);
  });

  test("quota unification: a continuous streak across flipped reasons fires once, the anchor never resets", async () => {
    seedSince(h.store, "quota", T0 - 4 * HOUR + 120_000);
    for (const [i, r] of ["session-blocked", "emergency-stop", "weekly-emergency-stop"].entries()) {
      tick(r);
      await runLaunchFlow(h.deps, cfg({ nowMs: T0 + i * 120_000 }));
    }
    assert.equal(sinceOf(h.store, "quota"), T0 - 4 * HOUR + 120_000, "anchor unchanged across the flips");
    assert.equal(warnLines(h.logs).length, 1, "fired exactly once");
    assert.ok(firedOf(h.store, "quota"));
  });

  test("pause (forgotten operator pause) fires at the 24h threshold", async () => {
    tick("paused");
    seedSince(h.store, "pause", T0 - 24 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "pause"), true);
  });

  test("class change resets: a fail-safe -> pause transition clears the fail-safe streak", async () => {
    seedSince(h.store, "fail-safe", T0 - HOUR);
    seedFired(h.store, "fail-safe");
    tick("paused");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "fail-safe"), null);
    assert.equal(firedOf(h.store, "fail-safe"), false);
    assert.equal(sinceOf(h.store, "pause"), T0, "the new class anchors");
  });

  test("latency fires at its 1h breach (independent of reason) and clears when back under budget", async () => {
    tick("eligible-launch", 2500);
    seedSince(h.store, "latency", T0 - HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "latency"), true);

    tick("eligible-launch", 900);
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 120_000 }));
    assert.equal(firedOf(h.store, "latency"), false);
    assert.equal(sinceOf(h.store, "latency"), null);
  });

  test("an absent latency_ms clears the latency streak (the probe never reached)", async () => {
    seedSince(h.store, "latency", T0 - 30 * 60_000);
    tick("already-running-service", null);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "latency"), null);
  });

  test("latency is a LEADING indicator: fires strictly before the 2h fail-safe streak", async () => {
    seedSince(h.store, "latency", T0 - HOUR);
    seedSince(h.store, "fail-safe", T0 - HOUR);
    tick("eligibility-unparseable", 1500);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "latency"), true);
    assert.equal(firedOf(h.store, "fail-safe"), false, "1h of fail-safe is under its 2h threshold");
  });

  test("thresholds are injectable: a tiny override fires where the default would not", async () => {
    tick("jq-missing");
    seedSince(h.store, "fail-safe", T0 - 10_000);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "fail-safe"), false);
    await runLaunchFlow(h.deps, cfg({ failSafeS: 5 }));
    assert.equal(firedOf(h.store, "fail-safe"), true);
  });

  test("INV-4: an unreadable last-tick (Redis throws) logs the WARN and mutates nothing", async () => {
    seedSince(h.store, "fail-safe", T0 - HOUR);
    seedFired(h.store, "quota");
    h.state.tick = "throw";
    const writesBefore = h.store.writes.length;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.store.writes.length, writesBefore, "no write of any kind");
    assert.equal(sinceOf(h.store, "fail-safe"), T0 - HOUR);
    assert.equal(firedOf(h.store, "quota"), true);
    assert.ok(h.logs.some((l) => l.startsWith(LAUNCH_FLOW_LOG_PREFIX) && /WARN no pace-gate last-tick record/.test(l)));
    assert.equal(h.pages.length + h.published.length, 0);
  });

  test("INV-4: an absent last-tick (no tick ever recorded) logs the same WARN and mutates nothing", async () => {
    seedSince(h.store, "pause", T0 - HOUR);
    h.state.tick = null;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.store.writes.length, 0);
    assert.equal(sinceOf(h.store, "pause"), T0 - HOUR);
    assert.ok(h.logs.some((l) => /WARN no pace-gate last-tick record \(redis unreadable or key absent\)/.test(l)));
  });

  test("INV-4: a thrown EpisodeStore read skips that signal but the run still completes", async () => {
    tick("eligibility-unreachable");
    seedSince(h.store, "fail-safe", T0 - 3 * HOUR);
    h.store.failReads = true;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "fail-safe"), false, "no fire on an unreadable store");
    assert.equal(sinceOf(h.store, "fail-safe"), T0 - 3 * HOUR, "anchor untouched");
    assert.ok(h.logs.some((l) => /WARN episode 'fail-safe' state read failed/.test(l)));
    assert.ok(h.logs.some((l) => /launch-flow tick processed/.test(l)));
  });

  test("the processed line keeps its vocabulary (reason, latency_ms, now_ms)", async () => {
    tick("eligible-launch", 321);
    await runLaunchFlow(h.deps, cfg());
    assert.ok(h.logs.includes(`${LAUNCH_FLOW_LOG_PREFIX} launch-flow tick processed (reason=eligible-launch, latency_ms=321, now_ms=${T0})`));
    h.logs.length = 0;
    tick("eligible-launch", null);
    await runLaunchFlow(h.deps, cfg());
    assert.ok(h.logs.some((l) => l.includes("latency_ms=none")));
  });

  test("without an injected nowMs the clock port is used", async () => {
    tick("curl-missing");
    await runLaunchFlow(h.deps, { ...DEFAULT_LAUNCH_FLOW_CONFIG, nowMs: null });
    assert.equal(sinceOf(h.store, "fail-safe"), T0, "the harness clock reads T0");
  });
});

// ---------------------------------------------------------------------------
// The typed Redis seam (INV-10, INV-11)
// ---------------------------------------------------------------------------

describe("src/redis launch-flow + watchdog-episodes — typed seam (issue #3847, #5097)", () => {
  const sig = "latency" as const;
  const keys = launchFlowEpisodeKeys(sig);

  async function reset(): Promise<void> {
    const r = getRedisConnection();
    await r.del(launchFlowSinceKey(sig), launchFlowFiredKey(sig), launchFlowSinceKey("glm-sterile"), launchFlowFiredKey("glm-sterile"));
  }
  beforeEach(reset);
  after(reset);

  test("INV-11: key names are byte-identical to the pre-port bash templates, glm-sterile included", () => {
    assert.equal(LAUNCH_FLOW_KEY_PREFIX, "hydra:autopilot:launch-flow");
    for (const s of [...WATCHDOG_LAUNCH_SIGNALS, "glm-sterile"] as const) {
      assert.equal(launchFlowSinceKey(s), `hydra:autopilot:launch-flow:since:${s}`);
      assert.equal(launchFlowFiredKey(s), `hydra:autopilot:launch-flow:fired:${s}`);
      assert.deepEqual(launchFlowEpisodeKeys(s), { since: launchFlowSinceKey(s), fired: launchFlowFiredKey(s) });
    }
  });

  test("the episode accessors round-trip: SET NX anchors once, fired marker, DEL both", async () => {
    await anchorEpisodeSince(keys, T0);
    await anchorEpisodeSince(keys, T0 + 999);
    assert.equal(await readEpisodeSince(keys), T0, "NX: the second anchor is a no-op");
    assert.equal(await getLaunchFlowSince(sig), T0, "and the legacy reader sees the same key");
    assert.equal(await episodeFiredExists(keys), false);
    await markEpisodeFired(keys);
    assert.equal(await episodeFiredExists(keys), true);
    assert.equal(await isLaunchFlowFired(sig), true);
    await clearEpisodeKeys(keys);
    assert.equal(await readEpisodeSince(keys), null);
    assert.equal(await episodeFiredExists(keys), false);
  });

  test("a non-numeric stored anchor reads as null, never throws", async () => {
    await getRedisConnection().set(keys.since, "not-a-number");
    assert.equal(await readEpisodeSince(keys), null);
    assert.equal(await getLaunchFlowSince(sig), null);
  });

  test("clearLaunchFlowStreak removes both keys of ONE signal and leaves others alone", async () => {
    await anchorEpisodeSince(keys, T0);
    await markEpisodeFired(keys);
    const other = launchFlowEpisodeKeys("glm-sterile");
    await anchorEpisodeSince(other, T0);
    await clearLaunchFlowStreak(sig);
    assert.equal(await readEpisodeSince(keys), null);
    assert.equal(await episodeFiredExists(keys), false);
    assert.equal(await readEpisodeSince(other), T0);
  });

  test("INV-10: getPaceGateLastTick is one typed HGETALL; absent/reasonless -> null, bad latency -> null latency", async () => {
    const r = getRedisConnection();
    const saved = await r.hgetall(PACE_GATE_LAST_TICK_KEY);
    try {
      await r.del(PACE_GATE_LAST_TICK_KEY);
      assert.equal(await getPaceGateLastTick(), null, "absent hash");
      await r.hset(PACE_GATE_LAST_TICK_KEY, { class: "launch", at: "1" });
      assert.equal(await getPaceGateLastTick(), null, "no reason field");
      await r.hset(PACE_GATE_LAST_TICK_KEY, { reason: "eligible-launch", latency_ms: "1234" });
      assert.deepEqual(await getPaceGateLastTick(), { reason: "eligible-launch", latencyMs: 1234 });
      await r.hset(PACE_GATE_LAST_TICK_KEY, { latency_ms: "12.5s" });
      assert.deepEqual(await getPaceGateLastTick(), { reason: "eligible-launch", latencyMs: null });
    } finally {
      await r.del(PACE_GATE_LAST_TICK_KEY);
      if (Object.keys(saved).length > 0) await r.hset(PACE_GATE_LAST_TICK_KEY, saved);
    }
  });
});
