/**
 * test/now-pixel-derive-sprite-state.test.mts — covers the pure derivation
 * functions in dashboard/src/pages/now-pixel/derive-sprite-state.ts.
 *
 * The /now-pixel page (epic #642, slice 2 → #644) keeps all business logic
 * in derive-sprite-state.ts so the React components are dumb binders. This
 * test asserts that contract: same input → same output, edge cases handled
 * the same way the components would render them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePavilionState,
  deriveDispatchesStripState,
  formatDuration,
} from "../dashboard/src/pages/now-pixel/derive-sprite-state.ts";

// ---------------------------------------------------------------------------
// derivePavilionState
// ---------------------------------------------------------------------------

test("derivePavilionState: null payload → no-run mode with sensible defaults", () => {
  const s = derivePavilionState(null);
  assert.equal(s.mode, "no-run");
  assert.equal(s.runId, null);
  assert.equal(s.turns, 0);
  assert.equal(s.dispatches, 0);
  assert.equal(s.elapsedLabel, "—");
  assert.equal(s.lastTickAt, null);
  assert.match(s.emptyMessage, /not yet loaded/i);
});

test("derivePavilionState: running=true + currentRun → running mode with formatted stats", () => {
  const s = derivePavilionState({
    running: true,
    lastTickAt: "2026-05-27T19:03:03Z",
    currentRun: {
      id: "ab97a2d5-4025-4bef-8d24-14f91184093b",
      startedAt: "2026-05-27T17:21:42Z",
      trigger: "manual",
      turns: 12,
      dispatches: 8,
      elapsedSeconds: 1337,
      ageSeconds: 45,
    },
    generatedAt: "2026-05-27T19:08:15Z",
  });
  assert.equal(s.mode, "running");
  assert.equal(s.runId, "ab97a2d5-4025-4bef-8d24-14f91184093b");
  assert.equal(s.trigger, "manual");
  assert.equal(s.turns, 12);
  assert.equal(s.dispatches, 8);
  assert.equal(s.elapsedLabel, "22m");
  assert.equal(s.heartbeatAgeLabel, "45s");
  assert.equal(s.lastTickAt, "2026-05-27T19:03:03Z");
  assert.equal(s.emptyMessage, "");
});

test("derivePavilionState: running=false → stopped mode (so the sprite knows to nap)", () => {
  const s = derivePavilionState({
    running: false,
    lastTickAt: "2026-05-27T19:00:00Z",
    currentRun: null,
    generatedAt: "2026-05-27T19:08:15Z",
  });
  assert.equal(s.mode, "stopped");
  assert.equal(s.runId, null);
  assert.equal(s.lastTickAt, "2026-05-27T19:00:00Z");
  assert.match(s.emptyMessage, /stopped/i);
});

test("derivePavilionState: running=true but currentRun=null → no-run mode (scheduler alive, no autopilot)", () => {
  const s = derivePavilionState({
    running: true,
    lastTickAt: "2026-05-27T19:00:00Z",
    currentRun: null,
    generatedAt: "2026-05-27T19:08:15Z",
  });
  assert.equal(s.mode, "no-run");
  assert.equal(s.runId, null);
  assert.match(s.emptyMessage, /no active autopilot run/i);
});

// ---------------------------------------------------------------------------
// deriveDispatchesStripState
// ---------------------------------------------------------------------------

test("deriveDispatchesStripState: empty items → empty=true and zero rows", () => {
  const s = deriveDispatchesStripState({
    items: [],
    generatedAt: "2026-05-27T19:08:16Z",
  });
  assert.equal(s.empty, true);
  assert.equal(s.rows.length, 0);
});

test("deriveDispatchesStripState: null payload → empty=true (no NPE)", () => {
  const s = deriveDispatchesStripState(null);
  assert.equal(s.empty, true);
  assert.deepEqual(s.rows, []);
});

test("deriveDispatchesStripState: items mapped to placeholder pikachu + tooltips include currentStep when present", () => {
  const s = deriveDispatchesStripState({
    items: [
      {
        id: "d1",
        classLabel: "dev_orch",
        source: "autopilot",
        startedAt: "2026-05-27T19:00:00Z",
        currentStep: "writing code",
      },
      {
        id: "d2",
        classLabel: "qa_target",
        source: "operator",
        startedAt: "2026-05-27T19:05:00Z",
      },
    ],
    generatedAt: "2026-05-27T19:08:16Z",
  });
  assert.equal(s.empty, false);
  assert.equal(s.rows.length, 2);
  assert.equal(s.rows[0].spriteFile, "025-pikachu.png");
  assert.equal(s.rows[0].tooltip, "dev_orch · writing code");
  assert.equal(s.rows[1].tooltip, "qa_target");
  assert.equal(s.rows[1].source, "operator");
});

// ---------------------------------------------------------------------------
// formatDuration — small but load-bearing helper
// ---------------------------------------------------------------------------

test("formatDuration: seconds → s, minutes → m, hours → h Xm", () => {
  assert.equal(formatDuration(30), "30s");
  assert.equal(formatDuration(90), "2m");
  assert.equal(formatDuration(3700), "1h 2m");
  assert.equal(formatDuration(7200), "2h");
});

test("formatDuration: invalid / negative → em dash sentinel", () => {
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatDuration(NaN), "—");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(undefined), "—");
});
