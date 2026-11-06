/**
 * LAUNCH FLOW delivery (issue #3848, gamma; GLM-sterile #3868/#4691; ported to
 * TypeScript by issue #5097, epic #5094).
 *
 * Delivery is the half every detection-only attempt missed: at the exact tick
 * a signal's fired marker flips absent->present the check surfaces it on a
 * channel derived from whether the Orchestrator is provably up in that
 * signal's failure mode:
 *
 *   fail-safe, meter-dark          -> Operator Channel page only (no bus publish)
 *   quota, latency, pause, glm-sterile -> EventBus.publish() envelope PLUS one
 *                                      page, dedupKey == kind
 *
 * These cases drive the real `runLaunchFlow` over the in-memory ports in
 * test/_helpers/launch-flow-fakes.mts: a recording fake channel, a recording
 * fake bus and a scripted WatchdogGithub. The kind strings come from
 * NOTIFICATION_EVENT_TYPES / PAGE_KINDS and the freshness windows from
 * src/redis/autopilot.ts, so a typo is a compile error rather than a drifted
 * regex pin.
 */

import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { STREAMS } from "../src/event-bus-stream-keys.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../src/event-bus-vocabulary.ts";
import { formatAlertMessage } from "../src/notification/alert-grammar.ts";
import { ALERT_TYPES, PAGE_KINDS, isPageKind } from "../src/operator-channel/page-list.ts";
import { GLM_DRAINER_HEARTBEAT_STALE_MS, GLM_DRAINER_HEARTBEAT_TTL_SECONDS } from "../src/redis/autopilot.ts";
import { WATCHDOG_LAUNCH_SIGNALS } from "../src/redis/launch-flow.ts";
import {
  DEFAULT_LAUNCH_FLOW_CONFIG,
  LAUNCH_FLOW_PAGE_KIND,
  LAUNCH_FLOW_SIGNAL_ORDER,
  readGlmSterile,
  runLaunchFlow,
  type LaunchFlowConfig,
} from "../src/watchdog/launch-flow.ts";
import { countDrainerPrsInRows } from "../src/watchdog/ports.ts";
import { T0, firedOf, makeHarness, seedFired, seedSince, sinceOf } from "./_helpers/launch-flow-fakes.mts";

const HOUR = 3_600_000;
const cfg = (over: Partial<LaunchFlowConfig> = {}): LaunchFlowConfig => ({ ...DEFAULT_LAUNCH_FLOW_CONFIG, nowMs: T0, ...over });

// =============================================================================
// TypeScript delivery grammar (unchanged vocabulary the check publishes into)
// =============================================================================

describe("issue #3848 — TypeScript delivery grammar", () => {
  test("three launch-flow event types exist in the vocabulary", () => {
    assert.equal(E.LAUNCH_QUOTA_STRETCH, "launch:quota_stretch");
    assert.equal(E.LAUNCH_LATENCY_BREACH, "launch:latency_breach");
    assert.equal(E.LAUNCH_PAUSE_FORGOTTEN, "launch:pause_forgotten");
  });

  test("quota and latency are in ALERT_TYPES; pause is NOT (digest line only)", () => {
    assert.ok(ALERT_TYPES.has(E.LAUNCH_QUOTA_STRETCH), "quota stretch must raise a dashboard alert");
    assert.ok(ALERT_TYPES.has(E.LAUNCH_LATENCY_BREACH), "latency breach must raise a dashboard alert");
    assert.ok(!ALERT_TYPES.has(E.LAUNCH_PAUSE_FORGOTTEN), "a forgotten pause must NEVER raise a dashboard alert (alarm-fatigue guard)");
  });

  test("all three are on the closed page list (immediate Page)", () => {
    for (const t of [E.LAUNCH_QUOTA_STRETCH, E.LAUNCH_LATENCY_BREACH, E.LAUNCH_PAUSE_FORGOTTEN]) {
      assert.ok(isPageKind(t), `${t} must be a Page`);
    }
  });

  test("formatAlertMessage renders the two alert-worthy signals", () => {
    const quota = formatAlertMessage({
      type: E.LAUNCH_QUOTA_STRETCH,
      payload: { signal: "quota", reason: "session-blocked", durationMs: 6 * HOUR, thresholdMs: 4 * HOUR },
    });
    assert.match(quota, /Launch quota stretch/);
    assert.match(quota, /session-blocked/);
    assert.match(quota, /6h/);
    assert.match(quota, /4h/);

    const latency = formatAlertMessage({
      type: E.LAUNCH_LATENCY_BREACH,
      payload: { signal: "latency", reason: "eligible-launch", durationMs: 90 * 60_000, thresholdMs: 60 * 60_000 },
    });
    assert.match(latency, /Launch latency breach/);
    assert.match(latency, /1\.5h/);
  });

  test("TS grammar: glm:drainer_sterile is an alert type AND an immediate page", () => {
    assert.equal(E.GLM_DRAINER_STERILE, "glm:drainer_sterile");
    assert.ok(ALERT_TYPES.has(E.GLM_DRAINER_STERILE), "a sterile drainer must raise a dashboard alert");
    assert.ok(isPageKind(E.GLM_DRAINER_STERILE), "a sterile drainer must be a Page (board starvation is per-hour damage)");
    const msg = formatAlertMessage({
      type: E.GLM_DRAINER_STERILE,
      payload: { signal: "glm-sterile", reason: "eligible-launch", durationMs: 2 * HOUR, thresholdMs: HOUR },
    });
    assert.match(msg, /GLM drainer sterile/);
    assert.match(msg, /2h/);
    assert.match(msg, /1h/);
  });
});

// =============================================================================
// INV-17 — compile-time pins replace the deleted regex pins
// =============================================================================

describe("every kind the launch flow pages is on the closed page list (INV-17)", () => {
  test("LAUNCH_FLOW_PAGE_KIND covers all six signals, each isPageKind()-true and in PAGE_KINDS", () => {
    assert.deepEqual([...LAUNCH_FLOW_SIGNAL_ORDER].sort(), [...WATCHDOG_LAUNCH_SIGNALS, "glm-sterile"].sort());
    for (const sig of LAUNCH_FLOW_SIGNAL_ORDER) {
      const kind = LAUNCH_FLOW_PAGE_KIND[sig];
      assert.ok(isPageKind(kind), `${sig} -> ${kind} must be on the closed page list`);
      assert.ok((PAGE_KINDS as readonly string[]).includes(kind));
    }
  });

  test("the in-band kinds are the TS-owned vocabulary members; fail-safe / meter-dark are the page-list literals", () => {
    assert.equal(LAUNCH_FLOW_PAGE_KIND.quota, E.LAUNCH_QUOTA_STRETCH);
    assert.equal(LAUNCH_FLOW_PAGE_KIND.latency, E.LAUNCH_LATENCY_BREACH);
    assert.equal(LAUNCH_FLOW_PAGE_KIND.pause, E.LAUNCH_PAUSE_FORGOTTEN);
    assert.equal(LAUNCH_FLOW_PAGE_KIND["glm-sterile"], E.GLM_DRAINER_STERILE);
    assert.equal(LAUNCH_FLOW_PAGE_KIND["fail-safe"], "launch:fail_safe");
    assert.equal(LAUNCH_FLOW_PAGE_KIND["meter-dark"], "launch:meter_dark");
  });
});

// =============================================================================
// Delivery behaviour
// =============================================================================

describe("runLaunchFlow — delivery behaviour (issue #3848; Operator Channel per #5046/#5097)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  const tick = (reason: string, latencyMs: number | null = null) => {
    h.state.tick = { reason, latencyMs };
  };

  test("fail-safe delivers out-of-band: one channel page, NO bus publish", async () => {
    tick("eligibility-unreachable");
    seedSince(h.store, "fail-safe", T0 - 2 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 0, "the Orchestrator is unproven: nothing rides the bus");
    assert.equal(h.pages.length, 1);
    const p = h.pages[0];
    assert.equal(p.kind, "launch:fail_safe");
    assert.equal(p.dedupKey, "launch:fail_safe", "dedupKey == kind");
    assert.equal(p.severity, "page");
    assert.equal(p.title, "Launch flow 'fail-safe' sustained 7200000ms (>= 7200000ms) — Orchestrator may be down");
    assert.deepEqual(p.facts, [
      { label: "signal", value: "fail-safe" },
      { label: "reason", value: "eligibility-unreachable" },
      { label: "sustained_ms", value: "7200000" },
      { label: "threshold_ms", value: "7200000" },
    ]);
  });

  test("meter-dark also delivers out-of-band as launch:meter_dark", async () => {
    tick("token-refresh-nudge");
    seedSince(h.store, "meter-dark", T0 - 3 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 0);
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, "launch:meter_dark");
    assert.match(h.pages[0].title, /Orchestrator may be down/);
  });

  test("quota delivers in-band: ONE bus envelope with the TS-owned type AND one page", async () => {
    tick("session-blocked");
    seedSince(h.store, "quota", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 1);
    const { stream, event } = h.published[0];
    assert.equal(stream, STREAMS.NOTIFICATIONS);
    assert.equal(event.type, E.LAUNCH_QUOTA_STRETCH);
    assert.equal(event.source, "watchdog-launch-flow");
    assert.equal(event.correlationId, "launch-flow-quota");
    assert.deepEqual(event.payload, { signal: "quota", reason: "session-blocked", durationMs: 5 * HOUR, thresholdMs: 4 * HOUR });
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, E.LAUNCH_QUOTA_STRETCH);
    assert.equal(h.pages[0].dedupKey, E.LAUNCH_QUOTA_STRETCH);
    assert.equal(h.pages[0].title, "Launch flow 'quota' sustained 18000000ms (>= 14400000ms)");
  });

  test("latency delivers in-band with launch:latency_breach plus one page", async () => {
    tick("eligible-launch", 4200);
    seedSince(h.store, "latency", T0 - HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].event.type, E.LAUNCH_LATENCY_BREACH);
    assert.equal(h.published[0].event.correlationId, "launch-flow-latency");
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, E.LAUNCH_LATENCY_BREACH);
  });

  test("pause delivers in-band with launch:pause_forgotten plus one page", async () => {
    tick("paused");
    seedSince(h.store, "pause", T0 - 25 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].event.type, E.LAUNCH_PAUSE_FORGOTTEN);
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, E.LAUNCH_PAUSE_FORGOTTEN);
  });

  test("the reason is sanitized for the envelope (a quote or backslash can never reach the payload)", async () => {
    seedSince(h.store, "latency", T0 - HOUR);
    tick('weird "reason"\\', 9000);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 1);
    assert.equal((h.published[0].event.payload as { reason: string }).reason, "weirdreason");
  });

  test("a failing channel never fails the run; the fired marker still holds; the WARN is distinguishable", async () => {
    tick("eligibility-unreachable");
    seedSince(h.store, "fail-safe", T0 - 3 * HOUR);
    h.state.failPage = true;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(firedOf(h.store, "fail-safe"), true, "marker set before delivery");
    assert.ok(h.logs.some((l) => /WARN operator-channel page FAILED for 'launch:fail_safe' \(best-effort/.test(l)));
    assert.ok(h.logs.some((l) => /launch-flow tick processed/.test(l)), "the run completed");
  });

  test("a failing bus never fails the run and the page is still attempted", async () => {
    tick("session-blocked");
    seedSince(h.store, "quota", T0 - 5 * HOUR);
    h.state.failPublish = true;
    await runLaunchFlow(h.deps, cfg());
    assert.ok(h.logs.some((l) => /WARN in-band delivery FAILED for 'quota'/.test(l)));
    assert.equal(h.pages.length, 1);
    assert.equal(firedOf(h.store, "quota"), true);
  });

  test("un-suppression is recurrence: recovery calls resolve ONCE; a fresh streak re-delivers", async () => {
    tick("session-blocked");
    seedSince(h.store, "quota", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 120_000 }));
    assert.equal(h.pages.length, 1, "the fired marker suppresses the second tick");
    assert.equal(h.published.length, 1);

    tick("eligible-launch");
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 240_000 }));
    assert.deepEqual(h.resolves, [{ key: E.LAUNCH_QUOTA_STRETCH, title: "Launch flow 'quota' recovered" }]);
    assert.equal(firedOf(h.store, "quota"), false);
    assert.equal(sinceOf(h.store, "quota"), null);

    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 360_000 }));
    assert.equal(h.resolves.length, 1, "healthy ticks after the edge do not re-resolve");

    tick("session-blocked");
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 480_000, quotaS: 0 }));
    assert.equal(h.pages.length, 2, "a fresh streak crossing the threshold delivers again");
  });

  test("no delivery before threshold or after a read failure", async () => {
    tick("session-blocked");
    seedSince(h.store, "quota", T0 - HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.pages.length + h.published.length, 0, "under threshold");

    seedSince(h.store, "quota", T0 - 9 * HOUR);
    h.state.tick = "throw";
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.pages.length + h.published.length, 0, "unreadable last-tick");
    h.state.tick = { reason: "session-blocked", latencyMs: null };
    h.store.failReads = true;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.pages.length + h.published.length, 0, "unreadable episode store");
  });

  test("the WARNING line keeps the pre-port wording", async () => {
    tick("session-blocked");
    seedSince(h.store, "quota", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.ok(
      h.logs.includes(
        "hydra-launch-flow-watchdog: WARNING LAUNCH FLOW — signal 'quota' sustained 18000000ms >= 14400000ms threshold (reason=session-blocked); see epic #3844",
      ),
    );
  });
});

// =============================================================================
// glm-sterile membership (INV-8, INV-9)
// =============================================================================

describe("runLaunchFlow — glm-sterile (issues #3868, #4691; INV-9)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    h.state.tick = { reason: "eligible-launch", latencyMs: null };
    // fresh heartbeat + a fresh verdict that ADMITTED issue 4242
    h.state.heartbeatMs = T0 - 60_000;
    h.state.pick = { at: T0 - 120_000, picked: 4242, reason: "ready", candidates: 3, skipped: {} };
  });

  test("fires: fresh heartbeat + pickable verdict + zero drainer PRs -> in-band event + page, deduped", async () => {
    seedSince(h.store, "glm-sterile", T0 - HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].event.type, E.GLM_DRAINER_STERILE);
    assert.equal(h.published[0].event.correlationId, "launch-flow-glm-sterile");
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].kind, E.GLM_DRAINER_STERILE);
    await runLaunchFlow(h.deps, cfg({ nowMs: T0 + 120_000 }));
    assert.equal(h.published.length, 1, "deduped by the fired marker");
  });

  test("the PR window is the trailing GLM_STERILE_WINDOW_HOURS (default 6h) and is the ONLY gh call", async () => {
    await runLaunchFlow(h.deps, cfg());
    assert.deepEqual(h.ghCalls, [T0 - 6 * HOUR]);
    h.ghCalls.length = 0;
    await runLaunchFlow(h.deps, cfg({ glmSterileWindowHours: 2 }));
    assert.deepEqual(h.ghCalls, [T0 - 2 * HOUR]);
  });

  test("quiet: a recent drainer PR clears membership and the streak", async () => {
    h.state.drainerPrs = 2;
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    seedFired(h.store, "glm-sterile");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "glm-sterile"), null);
    assert.equal(firedOf(h.store, "glm-sterile"), false);
    assert.equal(h.resolves.length, 1, "the fired streak recovers with one resolve");
  });

  test("quiet: idle verdict (picked=null, every candidate skipped) is the #4286 shape — clears, ZERO gh calls", async () => {
    h.state.pick = { at: T0 - 60_000, picked: null, reason: "idle", candidates: 4, skipped: { "artifact-missing": 4 } };
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 0);
    assert.equal(sinceOf(h.store, "glm-sterile"), null);
  });

  test("INV-4: an UNREADABLE heartbeat is a failed measurement — streak and fired marker untouched, no recovered page, zero gh calls", async () => {
    h.state.heartbeatMs = "unreadable";
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    seedFired(h.store, "glm-sterile");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "glm-sterile"), T0 - 5 * HOUR, "streak untouched");
    assert.equal(firedOf(h.store, "glm-sterile"), true, "fired marker untouched");
    assert.equal(h.resolves.length, 0, "no spurious recovered page");
    assert.equal(h.ghCalls.length, 0);
  });

  test("sibling pin: an ABSENT heartbeat (drainer measurably down) still clears the streak and recovers", async () => {
    h.state.heartbeatMs = null;
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    seedFired(h.store, "glm-sterile");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "glm-sterile"), null);
    assert.equal(h.resolves.length, 1);
  });

  test("INV-4: an UNREADABLE last-pick is a failed measurement — streak and fired marker untouched, no recovered page, zero gh calls", async () => {
    h.state.pick = "unreadable";
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    seedFired(h.store, "glm-sterile");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "glm-sterile"), T0 - 5 * HOUR, "streak untouched");
    assert.equal(firedOf(h.store, "glm-sterile"), true, "fired marker untouched");
    assert.equal(h.resolves.length, 0, "no spurious recovered page");
    assert.equal(h.ghCalls.length, 0);
  });

  test("sibling pin: an ABSENT last-pick (measured no verdict) still clears the streak and recovers", async () => {
    h.state.pick = null;
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    seedFired(h.store, "glm-sterile");
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "glm-sterile"), null);
    assert.equal(h.resolves.length, 1);
  });

  test("quiet: no last-pick record — fail-quiet like the heartbeat's own direction, zero gh calls", async () => {
    h.state.pick = null;
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 0);
    assert.equal(sinceOf(h.store, "glm-sterile"), null, "a measured fact (no verdict) clears the old anchor");
  });

  test("quiet: a verdict older than the writer's TTL is not sterile; exactly the TTL still counts", async () => {
    const ttlMs = GLM_DRAINER_HEARTBEAT_TTL_SECONDS * 1000;
    h.state.pick = { at: T0 - ttlMs - 1, picked: 4242, reason: "ready", candidates: 1, skipped: {} };
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 0, "stale verdict -> zero gh calls");
    h.state.pick = { at: T0 - ttlMs, picked: 4242, reason: "ready", candidates: 1, skipped: {} };
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 1, "the boundary is inclusive (0 <= age <= TTL)");
  });

  test("the verdict window is the writer's TTL, deliberately wider than the 45-min heartbeat window", async () => {
    assert.ok(GLM_DRAINER_HEARTBEAT_TTL_SECONDS * 1000 > GLM_DRAINER_HEARTBEAT_STALE_MS);
    h.state.pick = { at: T0 - GLM_DRAINER_HEARTBEAT_STALE_MS - 60_000, picked: 7, reason: "ready", candidates: 1, skipped: {} };
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 1, "a 46-min-old verdict is still a fresh verdict");
  });

  test("quiet: a verdict timestamped in the future is not fresh", async () => {
    h.state.pick = { at: T0 + 60_000, picked: 7, reason: "ready", candidates: 1, skipped: {} };
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 0);
  });

  for (const [label, picked] of [
    ["picked zero", 0],
    ["picked negative", -3],
    ["picked fractional", 2.5],
    ["picked a string", "7"],
    ["picked NaN-ish object", {}],
  ] as const) {
    test(`quiet: malformed verdict (${label}) — fail-quiet, cleared streak, zero gh calls`, async () => {
      h.state.pick = { at: T0 - 60_000, picked: picked as unknown as number, reason: "ready", candidates: 1, skipped: {} };
      seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
      await runLaunchFlow(h.deps, cfg());
      assert.equal(h.ghCalls.length, 0);
      assert.equal(sinceOf(h.store, "glm-sterile"), null);
    });
  }

  test("INV-4: a failed PR-window query leaves the streak state UNTOUCHED (never extends, never clears)", async () => {
    h.state.drainerPrs = null;
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    seedFired(h.store, "glm-sterile");
    const writesBefore = h.store.writes.length;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 1);
    assert.equal(sinceOf(h.store, "glm-sterile"), T0 - 5 * HOUR);
    assert.equal(firedOf(h.store, "glm-sterile"), true);
    assert.equal(
      h.store.writes.slice(writesBefore).filter((w) => w.endsWith(":glm-sterile")).length,
      0,
      "no glm-sterile write of any kind",
    );
    assert.ok(h.logs.some((l) => /WARN glm-sterile PR-window query failed\/unparseable/.test(l)));
    assert.equal(h.pages.length + h.published.length + h.resolves.length, 0);
  });

  test("INV-4: a THROWN PR-window query is the same failed measurement — skipped, other signals still run", async () => {
    h.state.drainerPrs = "throw";
    h.state.tick = { reason: "curl-missing", latencyMs: null };
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(sinceOf(h.store, "glm-sterile"), T0 - 5 * HOUR);
    assert.equal(sinceOf(h.store, "fail-safe"), T0, "the other signals were still tracked");
    assert.ok(h.logs.some((l) => /WARN glm-sterile read failed \(gh exploded\)/.test(l)));
  });

  test("quiet: stale/absent heartbeat — the 'down' case is board-state's, so no alarm and NO verdict/gh reads", async () => {
    h.state.heartbeatMs = T0 - GLM_DRAINER_HEARTBEAT_STALE_MS - 1;
    seedSince(h.store, "glm-sterile", T0 - 5 * HOUR);
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 0);
    assert.equal(sinceOf(h.store, "glm-sterile"), null);

    h.state.heartbeatMs = null;
    await runLaunchFlow(h.deps, cfg());
    assert.equal(h.ghCalls.length, 0);
  });

  test("readGlmSterile reads cheap -> expensive: a stale heartbeat never even asks for the verdict", async () => {
    h.state.heartbeatMs = null;
    let verdictReads = 0;
    const deps = { ...h.deps, glm: { liveness: h.deps.glm.liveness, lastPick: async () => (verdictReads++, h.state.pick) } };
    assert.deepEqual(await readGlmSterile(deps, T0, 6), { known: true, member: false });
    assert.equal(verdictReads, 0);
  });

  test("readGlmSterile verdicts: member / not member / unknown", async () => {
    assert.deepEqual(await readGlmSterile(h.deps, T0, 6), { known: true, member: true });
    h.state.drainerPrs = 1;
    assert.deepEqual(await readGlmSterile(h.deps, T0, 6), { known: true, member: false });
    h.state.drainerPrs = null;
    assert.deepEqual(await readGlmSterile(h.deps, T0, 6), { known: false });
  });
});

// =============================================================================
// The drainer-PR window predicate (INV-8)
// =============================================================================

describe("countDrainerPrsInRows — the shared isGlmProvenance predicate over REST rows (INV-8)", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const since = T0 - 6 * HOUR;
  const row = (over: Record<string, unknown>) => ({ labels: [], head: { ref: "feature/x" }, created_at: iso(T0), ...over });

  test("counts a PR by the glm-authored LABEL", () => {
    assert.equal(countDrainerPrsInRows([row({ labels: [{ name: "glm-authored" }] })], since), 1);
  });

  test("counts a PR by the worktree-agent-glm- BRANCH prefix alone (lost label, #3900)", () => {
    assert.equal(countDrainerPrsInRows([row({ head: { ref: "worktree-agent-glm-abc" } })], since), 1);
  });

  test("ignores non-drainer PRs, PRs outside the window, and rows with no parseable created_at", () => {
    const rows = [
      row({}),
      row({ labels: [{ name: "enhancement" }] }),
      row({ labels: [{ name: "glm-authored" }], created_at: iso(since - 1) }),
      row({ labels: [{ name: "glm-authored" }], created_at: "" }),
      row({ labels: [{ name: "glm-authored" }], created_at: undefined }),
      row({ labels: [{ name: "glm-authored" }], created_at: "not-a-date" }),
    ];
    assert.equal(countDrainerPrsInRows(rows, since), 0);
  });

  test("the window start is inclusive", () => {
    assert.equal(countDrainerPrsInRows([row({ labels: [{ name: "glm-authored" }], created_at: iso(since) })], since), 1);
  });

  test("tolerates malformed rows; a non-array payload is a failed measurement (null), not zero", () => {
    assert.equal(countDrainerPrsInRows([null, 7, "x", { labels: "nope" }, row({ head: null })], since), 0);
    assert.equal(countDrainerPrsInRows({ message: "Bad credentials" }, since), null);
    assert.equal(countDrainerPrsInRows(null, since), null);
  });

  test("an empty page is a measured zero", () => {
    assert.equal(countDrainerPrsInRows([], since), 0);
  });
});
