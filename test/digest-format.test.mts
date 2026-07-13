/**
 * Pure-core digest formatter tests (issue #1181).
 *
 * Exercises `buildDigestMessage` and `formatCriticalAlert` directly — no
 * Telegram calls, no timers, no dynamic imports, no module state. The two async
 * fan-out assemblers (`buildDailyHeartbeat`, `buildWeeklySummary`) moved to
 * `src/digest-fanout.ts` in issue #2215 and are tested in
 * `test/digest-fanout.test.mts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDigestMessage,
  formatCriticalAlert,
  formatBuilderHealthLines,
  formatStagnationPanelLines,
} from "../src/digest-format.ts";
import type { StagnationPanel } from "../src/aggregators/builder-health-stagnation-panel.ts";
import type { StagnationResult } from "../src/aggregators/builder-health-stagnation.ts";

// ---------------------------------------------------------------------------
// buildDigestMessage
// ---------------------------------------------------------------------------
describe("buildDigestMessage", () => {
  it("renders the header and an empty-period digest with no events", () => {
    const msg = buildDigestMessage([]);
    assert.match(msg, /📊 \*Hydra Digest\*/);
    assert.match(msg, /\*Cycles:\* None completed in this period/);
    // Capacity block always renders, even with no snapshot.
    assert.match(msg, /\*Capacity split:\*/);
    assert.match(msg, /No cycle history yet/);
    // Builder-health block always renders its header.
    assert.match(msg, /\*Builder health:\*/);
    assert.match(msg, /No builder-health data yet/);
    assert.match(msg, /_Period: no events_/);
  });

  it("summarises merged and failed cycles", () => {
    const events = [
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T08:00:00.000Z",
        payload: { task: { title: "Add thing", finalState: "merged" }, commitSha: "abcdef1234567" },
      },
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T09:00:00.000Z",
        payload: { task: { title: "Broke thing", finalState: "failed" } },
      },
    ];
    const msg = buildDigestMessage(events);
    assert.match(msg, /\*Cycles:\* 2 completed — 1 merged, 1 failed, 0 abandoned/);
    assert.match(msg, /\*Merged:\*/);
    assert.match(msg, /• Add thing/);
    assert.match(msg, /\*Failed:\*/);
    assert.match(msg, /• Broke thing — failed/);
  });

  it("renders the capacity split when a snapshot is supplied", () => {
    const snapshot = {
      orchestrator: { share: 0.3, count: 3, window: 10, floor: 0.25 },
      target: { share: 0.7, count: 7 },
      idle: { count: 0 },
      floorMet: true,
      recent: [],
    };
    const msg = buildDigestMessage([], snapshot);
    assert.match(msg, /• Orchestrator: 30% \(3\/10\) ✅ floor 25%/);
    assert.match(msg, /• Target: 70% \(7\/10\)/);
  });

  it("flags an action item when verification failures cross the threshold", () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      type: "task:verification_failed",
      timestamp: `2026-06-07T0${i}:00:00.000Z`,
      payload: {},
    }));
    const msg = buildDigestMessage(events);
    assert.match(msg, /\*Action items:\*/);
    assert.match(msg, /3 verification failures/);
  });

  it("truncates messages that exceed the Telegram limit", () => {
    // A single merged event with a >4000-char title overflows the message
    // (the merged list caps at 10 rows, so length must come from row width).
    const events = [
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T08:00:00.000Z",
        payload: {
          task: { title: "X".repeat(5000), finalState: "merged" },
        },
      },
    ];
    const msg = buildDigestMessage(events);
    assert.ok(msg.length <= 4000, `expected <= 4000 chars, got ${msg.length}`);
    assert.match(msg, /_\(truncated\)_$/);
  });
});

// ---------------------------------------------------------------------------
// formatCriticalAlert
// ---------------------------------------------------------------------------
describe("formatCriticalAlert", () => {
  it("formats a rollback-failed alert", () => {
    const out = formatCriticalAlert({
      type: "cycle:rollback_failed",
      payload: { title: "Risky change", commitSha: "deadbeefcafe", error: "merge conflict" },
    });
    assert.match(out, /🚨 \*CRITICAL: Rollback Failed\*/);
    assert.match(out, /Task: Risky change/);
    assert.match(out, /deadbee/);
    assert.match(out, /merge conflict/);
  });

  it("formats a scheduler-stopped alert", () => {
    const out = formatCriticalAlert({
      type: "scheduler:stopped",
      payload: { reason: "budget exhausted", cyclesRun: 12 },
    });
    assert.match(out, /🛑 \*Scheduler Stopped\*/);
    assert.match(out, /Reason: budget exhausted/);
    assert.match(out, /Cycles run: 12/);
  });

  it("falls back to a generic alert for unknown types", () => {
    const out = formatCriticalAlert({ type: "something:weird", payload: { a: 1 } });
    assert.match(out, /⚠️ \*something:weird\*/);
    assert.match(out, /"a":1/);
  });
});

// ---------------------------------------------------------------------------
// Builder-Health stagnation panel (issue #3289, epic #3285, ADR-0028)
// ---------------------------------------------------------------------------

/** Build a StagnationResult fixture with sensible defaults. */
function res(over: Partial<StagnationResult> = {}): StagnationResult {
  return { state: "ok", current: 1, baseline: 1, sustainedCycles: 0, ...over };
}

/**
 * A panel fixture. `orchStates` sets each signal's orch verdict; the target
 * realm is dark (null) by construction on this substrate (ADR-0028).
 */
function panel(
  orch: Partial<Record<"cycleYield" | "reworkRate" | "mutationKillRate", StagnationResult | null>>,
  windowCtx: Partial<StagnationPanel["windowContext"]> = {},
): StagnationPanel {
  return {
    signals: {
      cycleYield: { orch: orch.cycleYield ?? res(), target: null },
      reworkRate: { orch: orch.reworkRate ?? res(), target: null },
      mutationKillRate: { orch: orch.mutationKillRate ?? res(), target: null },
    },
    windowContext: {
      cycles: 50,
      mix: { cleanup: 10, feature: 30 },
      anchorTypes: {},
      ...windowCtx,
    },
  };
}

describe("formatStagnationPanelLines", () => {
  it("renders the per-realm panel with a ⚠ flag on a breached signal", () => {
    const p = panel({
      cycleYield: res({ state: "breach", current: 0.3, baseline: 0.8, sustainedCycles: 4 }),
    });
    const out = formatStagnationPanelLines(p).join("\n");
    // Header present.
    assert.match(out, /Stagnation \(per-realm, vs self-baseline\):/);
    // Breached signal carries the ⚠ flag with current-vs-baseline values.
    assert.match(out, /Cycle-yield \[orch\]: now 0\.30 vs baseline 0\.80 ⚠/);
    // A non-breached signal has no flag.
    assert.match(out, /Rework-rate \[orch\]: now 1 vs baseline 1(?! ⚠)/);
    // No ⚠ on the healthy signals.
    assert.doesNotMatch(out, /Rework-rate \[orch\].*⚠/);
  });

  it("renders an un-instrumented realm signal as 'not instrumented', not a number", () => {
    const out = formatStagnationPanelLines(panel({})).join("\n");
    // The target realm is dark (null) for every signal → not instrumented.
    assert.match(out, /Cycle-yield \[target\]: not instrumented/);
    assert.match(out, /Rework-rate \[target\]: not instrumented/);
    assert.match(out, /Mutation-kill \[target\]: not instrumented/);
    // And it never prints a fabricated number for the dark realm.
    assert.doesNotMatch(out, /\[target\]: now/);
  });

  it("renders the window-context (tier/backlog mix) line", () => {
    const out = formatStagnationPanelLines(
      panel({}, { cycles: 42, mix: { cleanup: 7, feature: 21 } }),
    ).join("\n");
    assert.match(out, /Window: 42 cycles, mix 7 cleanup:21 feature/);
  });

  it("renders a warming signal without a baseline number", () => {
    const p = panel({
      mutationKillRate: res({ state: "warming", current: 85, baseline: null, sustainedCycles: 0 }),
    });
    const out = formatStagnationPanelLines(p).join("\n");
    assert.match(out, /Mutation-kill \[orch\]: warming \(now 85, baseline —\)/);
    // A warming signal is never flagged as a breach.
    assert.doesNotMatch(out, /Mutation-kill \[orch\].*⚠/);
  });

  it("returns no lines for a null or fully-dark panel", () => {
    assert.deepEqual(formatStagnationPanelLines(null), []);
    const dark: StagnationPanel = {
      signals: {
        cycleYield: { orch: null, target: null },
        reworkRate: { orch: null, target: null },
        mutationKillRate: { orch: null, target: null },
      },
      windowContext: { cycles: 0, mix: { cleanup: 0, feature: 0 }, anchorTypes: {} },
    };
    assert.deepEqual(formatStagnationPanelLines(dark), []);
  });
});

describe("formatBuilderHealthLines with stagnation panel", () => {
  it("renders the panel even when every scorecard aggregate slot is empty", () => {
    // Only the stagnation panel carries data — the section must still render it
    // (not the "no data yet" fallback), because the panel is the point of #3289.
    const scorecard: any = {
      generatedAt: "2026-07-13T00:00:00.000Z",
      selfImprovementShare: null,
      autonomyRate: null,
      reworkRate: null,
      timeToMerge: null,
      mutationKillRateTrend: null,
      scopeViolations: null,
      learningThroughput: null,
      stagnation: panel({
        cycleYield: res({ state: "breach", current: 0.2, baseline: 0.7, sustainedCycles: 5 }),
      }),
    };
    const out = formatBuilderHealthLines(scorecard).join("\n");
    assert.match(out, /\*Builder health:\*/);
    assert.doesNotMatch(out, /No builder-health data yet/);
    assert.match(out, /Cycle-yield \[orch\]: now 0\.20 vs baseline 0\.70 ⚠/);
    assert.match(out, /Window: 50 cycles/);
  });

  it("degrades to the no-data line when the panel is null and no aggregate has data", () => {
    const scorecard: any = {
      generatedAt: "2026-07-13T00:00:00.000Z",
      selfImprovementShare: null,
      autonomyRate: null,
      reworkRate: null,
      timeToMerge: null,
      mutationKillRateTrend: null,
      scopeViolations: null,
      learningThroughput: null,
      stagnation: null,
    };
    const out = formatBuilderHealthLines(scorecard).join("\n");
    assert.match(out, /No builder-health data yet/);
  });
});
