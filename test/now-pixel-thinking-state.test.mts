/**
 * test/now-pixel-thinking-state.test.mts — covers the thinking-state
 * derivation introduced in issue #660 (follow-up to /now-pixel slice 4
 * / slice 6 from epic #642).
 *
 * The pure `deriveThinking()` function is the boundary the React
 * component (HabitatGrid) binds to. These tests pin time and thread
 * the tracker through to mimic successive polls.
 *
 * Spec recap (from #660):
 *   - Slot is "thinking" iff occupied ≥30s with NO partial_tokens delta
 *     in that window.
 *   - Token delta resets the inactivity clock.
 *   - Slot emptying drops the tracker (next occupancy starts fresh).
 *   - `deriveThinking` is pure — explicit `now`, no Date.now usage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveThinking,
  THINKING_WINDOW_SEC,
  type ThinkingTracker,
} from "../dashboard/src/pages/now-pixel/derive-sprite-state.ts";

const NOW = 1779905000;

function slot(taskId: string, tokens: number) {
  return { skill: "hydra-dev", task_id: taskId, partial_tokens: tokens };
}

// ---------------------------------------------------------------------------
// Behavioural cases (the four acceptance criteria from the issue body).
// ---------------------------------------------------------------------------

test("deriveThinking: empty slots → not thinking, tracker stays empty", () => {
  const r = deriveThinking({}, NOW, {});
  // All seven pipeline classes should be keyed false.
  for (const cls of [
    "dev_orch",
    "qa_orch",
    "research_orch",
    "design_concept_orch",
    "dev_target",
    "qa_target",
    "research_target",
  ] as const) {
    assert.equal(r.thinking[cls], false, `${cls} should not be thinking`);
  }
  assert.deepEqual(r.nextTracker, {});
});

test("deriveThinking: fresh occupancy → not thinking yet; tracker seeded at `now`", () => {
  const r = deriveThinking({ dev_orch: slot("task-1", 0) }, NOW, {});
  assert.equal(r.thinking.dev_orch, false);
  assert.deepEqual(r.nextTracker.dev_orch, {
    lastTokens: 0,
    lastChangeAt: NOW,
    taskId: "task-1",
  });
});

test("deriveThinking: token delta < 30s window → not thinking; clock advances on each delta", () => {
  // Poll 1: occupancy.
  let r = deriveThinking({ dev_orch: slot("task-1", 0) }, NOW, {});
  assert.equal(r.thinking.dev_orch, false);

  // Poll 2: 10s later, tokens jumped — clock resets to NOW+10.
  r = deriveThinking(
    { dev_orch: slot("task-1", 1500) },
    NOW + 10,
    r.nextTracker,
  );
  assert.equal(r.thinking.dev_orch, false);
  assert.equal(r.nextTracker.dev_orch?.lastChangeAt, NOW + 10);
  assert.equal(r.nextTracker.dev_orch?.lastTokens, 1500);

  // Poll 3: 20s after the LAST delta (NOW+30 absolute) — still not 30s
  // of inactivity yet (only 20s since last delta).
  r = deriveThinking(
    { dev_orch: slot("task-1", 1500) },
    NOW + 30,
    r.nextTracker,
  );
  assert.equal(r.thinking.dev_orch, false);
});

test("deriveThinking: ≥30s of no delta → thinking flips true", () => {
  // Seed at NOW; same tokens at NOW+30 (exactly the threshold).
  const seed = deriveThinking({ dev_orch: slot("task-1", 500) }, NOW, {});
  const after = deriveThinking(
    { dev_orch: slot("task-1", 500) },
    NOW + THINKING_WINDOW_SEC,
    seed.nextTracker,
  );
  assert.equal(after.thinking.dev_orch, true);
  // Tracker preserves the original lastChangeAt — we don't restart it
  // just because we noticed the slot is now thinking.
  assert.equal(after.nextTracker.dev_orch?.lastChangeAt, NOW);
});

test("deriveThinking: thinking, then delta arrives → flips back to not-thinking", () => {
  // Already thinking after 60s of silence.
  const seed = deriveThinking({ dev_orch: slot("task-1", 500) }, NOW, {});
  const stalled = deriveThinking(
    { dev_orch: slot("task-1", 500) },
    NOW + 60,
    seed.nextTracker,
  );
  assert.equal(stalled.thinking.dev_orch, true);

  // Tokens move on the next poll — back to not-thinking.
  const moved = deriveThinking(
    { dev_orch: slot("task-1", 800) },
    NOW + 65,
    stalled.nextTracker,
  );
  assert.equal(moved.thinking.dev_orch, false);
  assert.equal(moved.nextTracker.dev_orch?.lastChangeAt, NOW + 65);
});

test("deriveThinking: slot empties → not thinking; tracker entry is dropped", () => {
  const seed = deriveThinking({ dev_orch: slot("task-1", 500) }, NOW, {});
  const stalled = deriveThinking(
    { dev_orch: slot("task-1", 500) },
    NOW + 60,
    seed.nextTracker,
  );
  assert.equal(stalled.thinking.dev_orch, true);

  // Slot emptied — derivation flips to false and the tracker entry is
  // dropped so the next occupancy restarts the clock from zero.
  const emptied = deriveThinking({ dev_orch: null }, NOW + 65, stalled.nextTracker);
  assert.equal(emptied.thinking.dev_orch, false);
  assert.equal(emptied.nextTracker.dev_orch, undefined);
});

// ---------------------------------------------------------------------------
// Robustness — task_id swaps and non-numeric tokens.
// ---------------------------------------------------------------------------

test("deriveThinking: same slot, different task_id → tracker restarts (not thinking)", () => {
  const seed = deriveThinking({ dev_orch: slot("task-1", 500) }, NOW, {});
  const stalled = deriveThinking(
    { dev_orch: slot("task-1", 500) },
    NOW + 60,
    seed.nextTracker,
  );
  assert.equal(stalled.thinking.dev_orch, true);

  // Reaped + dispatched: same class, fresh task_id, fresh poll. The
  // inactivity clock has to start from zero on the new occupant.
  const swapped = deriveThinking(
    { dev_orch: slot("task-2", 0) },
    NOW + 65,
    stalled.nextTracker,
  );
  assert.equal(swapped.thinking.dev_orch, false);
  assert.equal(swapped.nextTracker.dev_orch?.lastChangeAt, NOW + 65);
  assert.equal(swapped.nextTracker.dev_orch?.taskId, "task-2");
});

test("deriveThinking: missing/non-numeric partial_tokens treated as 0 (no NPE)", () => {
  const r1 = deriveThinking(
    { dev_orch: { skill: "hydra-dev", task_id: "t1" } },
    NOW,
    {},
  );
  assert.equal(r1.nextTracker.dev_orch?.lastTokens, 0);

  // Same shape on the next poll, 30s later → still 0, no delta → thinking.
  const r2 = deriveThinking(
    { dev_orch: { skill: "hydra-dev", task_id: "t1" } },
    NOW + THINKING_WINDOW_SEC,
    r1.nextTracker,
  );
  assert.equal(r2.thinking.dev_orch, true);
});

test("deriveThinking: purity — same inputs return equal outputs without mutating tracker", () => {
  const prev: ThinkingTracker = {
    dev_orch: { lastTokens: 100, lastChangeAt: NOW, taskId: "task-1" },
  };
  const a = deriveThinking({ dev_orch: slot("task-1", 100) }, NOW + 40, prev);
  const b = deriveThinking({ dev_orch: slot("task-1", 100) }, NOW + 40, prev);
  assert.deepEqual(a.thinking, b.thinking);
  assert.deepEqual(a.nextTracker, b.nextTracker);
  // prev untouched.
  assert.deepEqual(prev, {
    dev_orch: { lastTokens: 100, lastChangeAt: NOW, taskId: "task-1" },
  });
});

test("deriveThinking: null/undefined snapshot → all-false, empty tracker", () => {
  const r1 = deriveThinking(null, NOW, {});
  assert.equal(r1.thinking.dev_orch, false);
  assert.deepEqual(r1.nextTracker, {});
  const r2 = deriveThinking(undefined, NOW, {});
  assert.equal(r2.thinking.qa_orch, false);
  assert.deepEqual(r2.nextTracker, {});
});

// ---------------------------------------------------------------------------
// Window-boundary edge cases.
// ---------------------------------------------------------------------------

test("deriveThinking: exactly 29s of silence → NOT thinking (boundary)", () => {
  const seed = deriveThinking({ dev_orch: slot("task-1", 1) }, NOW, {});
  const r = deriveThinking(
    { dev_orch: slot("task-1", 1) },
    NOW + (THINKING_WINDOW_SEC - 1),
    seed.nextTracker,
  );
  assert.equal(r.thinking.dev_orch, false);
});

test("deriveThinking: exactly 30s of silence → thinking (boundary, >=)", () => {
  const seed = deriveThinking({ dev_orch: slot("task-1", 1) }, NOW, {});
  const r = deriveThinking(
    { dev_orch: slot("task-1", 1) },
    NOW + THINKING_WINDOW_SEC,
    seed.nextTracker,
  );
  assert.equal(r.thinking.dev_orch, true);
});
