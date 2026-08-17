/**
 * now-pixel sprite derivation — derive-sprite-state.ts + sprite-map.ts
 * (issue #4140 consolidation).
 *
 * Merged verbatim from five test files that all sit on one pipeline:
 * now-pixel-derive-sprite-state, now-pixel-thinking-state,
 * now-pixel-stat-derivation, now-pixel-zone-derivation,
 * now-pixel-oak-town-crier.
 *
 * SCOPE NOTE. The other six now-pixel-*.test.mts files are deliberately NOT
 * here. They share this file's PAGE PREFIX but not its subject: each is the
 * sole test file for its own dashboard module (battle-card-state,
 * derive-dispatch-tween, oak-crier-state, oak-tab-state, reaping-fade,
 * recommendations-tab-state) and is therefore already the shape #4134's
 * ratchet protects. Folding them in would replace eight legible module-scoped
 * files with one grab-bag keyed on a page name. These five are different:
 * they resolve to just two tightly-coupled modules, and stat-derivation and
 * zone-derivation import both.
 *
 * Each source file's body is wrapped in its own block so its module-scope
 * fixtures stay private — block nesting does not change node:test nesting, so
 * every describe() below is still top-level. No test text was edited.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNAL_ACTIVE_WINDOW_SEC, THINKING_WINDOW_SEC, deriveCooldown, deriveDispatchesStripState, deriveExp, deriveHp, derivePavilionState, deriveThinking, deriveZoneState, formatDuration, type ThinkingTracker } from "../dashboard/src/pages/now-pixel/derive-sprite-state.ts";
import { CLASS_BUBBLE_COLOR, CLASS_SIDE, CLASS_TO_SPRITE, EVOLUTION_CHAINS, PIPELINE_CLASSES, SIGNAL_CLASSES, SIGNAL_COOLDOWNS, SIGNAL_POOLS, classSpriteFile, pickSignalSprite, resolveBubbleColor, subagentSpriteFile } from "../dashboard/src/pages/now-pixel/sprite-map.ts";

// ===========================================================================
// Merged from test/now-pixel-derive-sprite-state.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * test/now-pixel-derive-sprite-state.test.mts — covers the pure derivation
 * functions in dashboard/src/pages/now-pixel/derive-sprite-state.ts.
 *
 * The /now-pixel page (epic #642, slice 2 → #644) keeps all business logic
 * in derive-sprite-state.ts so the React components are dumb binders. This
 * test asserts that contract: same input → same output, edge cases handled
 * the same way the components would render them.
 */





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
}

// ===========================================================================
// Merged from test/now-pixel-thinking-state.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
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
}

// ===========================================================================
// Merged from test/now-pixel-stat-derivation.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * test/now-pixel-stat-derivation.test.mts — pins HP / EXP / Cooldown
 * derivations + the evolution-chain lookup for slice 6 of /now-pixel
 * (#642, #648).
 */






// ---------------------------------------------------------------------------
// deriveHp
// ---------------------------------------------------------------------------

test("deriveHp: green when ≥ 50% remaining", () => {
  const h = deriveHp(100_000, 800_000); // 700k remaining = 87.5%
  assert.equal(h.color, "green");
  assert.equal(h.flashing, false);
  assert.ok(h.percent >= 50);
});

test("deriveHp: yellow when 20-50% remaining", () => {
  const h = deriveHp(560_000, 800_000); // 240k = 30%
  assert.equal(h.color, "yellow");
  assert.equal(h.flashing, false);
});

test("deriveHp: red without flash at 10-20% remaining", () => {
  const h = deriveHp(680_000, 800_000); // 120k = 15%
  assert.equal(h.color, "red");
  assert.equal(h.flashing, false);
});

test("deriveHp: red + flashing below 10% remaining (the spec callout)", () => {
  const h = deriveHp(750_000, 800_000); // 50k = 6.25%
  assert.equal(h.color, "red");
  assert.equal(h.flashing, true);
});

test("deriveHp: hardMax ≤ 0 → grey (unknown ceiling)", () => {
  const h = deriveHp(100, 0);
  assert.equal(h.color, "grey");
  assert.equal(h.flashing, false);
  assert.equal(h.percent, 100);
});

test("deriveHp: tokensUsed > hardMax clamps remaining to 0 (no negative HP)", () => {
  const h = deriveHp(900_000, 800_000);
  assert.equal(h.percent, 0);
  assert.equal(h.color, "red");
  assert.equal(h.flashing, true);
});

// ---------------------------------------------------------------------------
// deriveExp
// ---------------------------------------------------------------------------

test("deriveExp: LV = floor((cum/budget)*50), clamped to 1..50", () => {
  // budget = 2M tokens (default schema-v2 limit), 1M cum = ratio 0.5 → LV 25
  const e = deriveExp(1_000_000, 2_000_000);
  assert.equal(e.level, 25);
  assert.ok(e.expPercent >= 0 && e.expPercent <= 100);
});

test("deriveExp: fresh run (0 cum) → LV 1 (floor clamps min)", () => {
  const e = deriveExp(0, 2_000_000);
  assert.equal(e.level, 1);
});

test("deriveExp: budget exhausted → LV 50, EXP bar full", () => {
  const e = deriveExp(3_000_000, 2_000_000);
  assert.equal(e.level, 50);
});

test("deriveExp: budget ≤ 0 → safe defaults", () => {
  const e = deriveExp(123, 0);
  assert.equal(e.level, 1);
  assert.equal(e.expPercent, 0);
});

// ---------------------------------------------------------------------------
// deriveCooldown
// ---------------------------------------------------------------------------

test("deriveCooldown: health is always ready (cooldown = 0)", () => {
  const c = deriveCooldown("health", 1779000000, 1779000000);
  assert.equal(c.ready, true);
  assert.equal(c.secondsRemaining, 0);
  assert.equal(c.totalSeconds, 0);
});

test("deriveCooldown: sweep_orch fired 100s ago → 800s remaining (15min cooldown)", () => {
  const lastFired = 1779000000;
  const now = lastFired + 100;
  const c = deriveCooldown("sweep_orch", lastFired, now);
  assert.equal(c.totalSeconds, SIGNAL_COOLDOWNS.sweep_orch);
  assert.equal(c.secondsRemaining, 800);
  assert.equal(c.ready, false);
});

test("deriveCooldown: signal past cooldown → ready=true, secondsRemaining=0", () => {
  const lastFired = 1779000000;
  const now = lastFired + 1800; // 30min later (sweep cooldown is 15min)
  const c = deriveCooldown("sweep_orch", lastFired, now);
  assert.equal(c.ready, true);
  assert.equal(c.secondsRemaining, 0);
});

test("deriveCooldown: never fired (lastFired=0) → ready=true", () => {
  const c = deriveCooldown("discover_target", 0, 1779000000);
  assert.equal(c.ready, true);
  assert.equal(c.secondsRemaining, 0);
});

// ---------------------------------------------------------------------------
// subagentSpriteFile + EVOLUTION_CHAINS
// ---------------------------------------------------------------------------

test("subagentSpriteFile: dev_target (Charizard) → Charmeleon (pre-evolution)", () => {
  const r = subagentSpriteFile("dev_target");
  assert.equal(r.spriteFile, "005-charmeleon.png");
  assert.equal(r.desaturate, false);
});

test("subagentSpriteFile: qa_orch (Alakazam) → Kadabra (pre-evolution)", () => {
  const r = subagentSpriteFile("qa_orch");
  assert.equal(r.spriteFile, "064-kadabra.png");
  assert.equal(r.desaturate, false);
});

test("subagentSpriteFile: dev_orch (Mewtwo) has no pre-evo → desaturated parent", () => {
  const r = subagentSpriteFile("dev_orch");
  assert.equal(r.spriteFile, "150-mewtwo.png");
  assert.equal(r.desaturate, true);
});

test("subagentSpriteFile: research_target (Lapras) has no pre-evo → desaturated parent", () => {
  const r = subagentSpriteFile("research_target");
  assert.equal(r.spriteFile, "131-lapras.png");
  assert.equal(r.desaturate, true);
});

test("EVOLUTION_CHAINS covers the dev/qa lines we declared", () => {
  assert.equal(EVOLUTION_CHAINS[6], 5); // Charizard → Charmeleon
  assert.equal(EVOLUTION_CHAINS[5], 4); // Charmeleon → Charmander
  assert.equal(EVOLUTION_CHAINS[65], 64); // Alakazam → Kadabra
  assert.equal(EVOLUTION_CHAINS[64], 63); // Kadabra → Abra
});
}

// ===========================================================================
// Merged from test/now-pixel-zone-derivation.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * test/now-pixel-zone-derivation.test.mts — covers deriveZoneState plus
 * the sprite-map pure helpers.
 *
 * Slice 3 of /now-pixel (#642, #645). All 12 classes are exercised in
 * both sleeping and active states.
 */






const NOW = 1779905000;

// ---------------------------------------------------------------------------
// deriveZoneState — pipeline slots
// ---------------------------------------------------------------------------

test("deriveZoneState: null payload → every class sleeping, runStatus null", () => {
  const s = deriveZoneState(null, NOW);
  assert.equal(s.runStatus, null);
  assert.equal(s.scope, "all");
  for (const cls of PIPELINE_CLASSES) {
    assert.equal(s.zones[cls], "sleeping", `expected ${cls} sleeping`);
  }
  for (const cls of SIGNAL_CLASSES) {
    assert.equal(s.zones[cls], "sleeping", `expected signal ${cls} sleeping`);
  }
});

test("deriveZoneState: status=running with all 7 pipeline slots filled → all active", () => {
  const slots = {
    dev_orch: { skill: "hydra-dev" },
    qa_orch: { skill: "hydra-qa" },
    research_orch: { skill: "hydra-research" },
    design_concept_orch: { skill: "hydra-grill" },
    dev_target: { skill: "hydra-target-build" },
    qa_target: { skill: "hydra-qa" },
    research_target: { skill: "hydra-target-research" },
  };
  const s = deriveZoneState(
    {
      status: "running",
      limits: { scope: "all" },
      turns: [{ slots_snapshot: slots, signals_snapshot: {} }],
    },
    NOW,
  );
  for (const cls of PIPELINE_CLASSES) {
    assert.equal(s.zones[cls], "active", `expected ${cls} active`);
  }
});

test("deriveZoneState: running but slot is null → that class is sleeping", () => {
  const s = deriveZoneState(
    {
      status: "running",
      turns: [
        {
          slots_snapshot: {
            dev_orch: { skill: "hydra-dev" },
            qa_orch: null,
          },
          signals_snapshot: {},
        },
      ],
    },
    NOW,
  );
  assert.equal(s.zones.dev_orch, "active");
  assert.equal(s.zones.qa_orch, "sleeping");
});

test("deriveZoneState: status=killed → snapshot ignored, all sleeping (no eternal-busy)", () => {
  const s = deriveZoneState(
    {
      status: "killed",
      turns: [
        {
          slots_snapshot: { dev_orch: { skill: "hydra-dev" } },
          signals_snapshot: { sweep_orch: NOW - 5 },
        },
      ],
    },
    NOW,
  );
  assert.equal(s.zones.dev_orch, "sleeping");
  assert.equal(s.zones.sweep_orch, "sleeping");
});

// ---------------------------------------------------------------------------
// deriveZoneState — signal cooldowns
// ---------------------------------------------------------------------------

test("deriveZoneState: signal fired within window → active", () => {
  const s = deriveZoneState(
    {
      status: "running",
      turns: [
        {
          slots_snapshot: {},
          signals_snapshot: {
            sweep_orch: NOW - 10,
            discover_target: NOW - (SIGNAL_ACTIVE_WINDOW_SEC - 1),
          },
        },
      ],
    },
    NOW,
  );
  assert.equal(s.zones.sweep_orch, "active");
  assert.equal(s.zones.discover_target, "active");
});

test("deriveZoneState: signal fired outside window → sleeping", () => {
  const s = deriveZoneState(
    {
      status: "running",
      turns: [
        {
          slots_snapshot: {},
          signals_snapshot: {
            sweep_orch: NOW - SIGNAL_ACTIVE_WINDOW_SEC - 1,
            sweep_target: NOW - 600,
          },
        },
      ],
    },
    NOW,
  );
  assert.equal(s.zones.sweep_orch, "sleeping");
  assert.equal(s.zones.sweep_target, "sleeping");
});

test("deriveZoneState: signal fired_epoch=0 (never fired) → sleeping", () => {
  const s = deriveZoneState(
    {
      status: "running",
      turns: [
        {
          slots_snapshot: {},
          signals_snapshot: {
            health: 0,
            discover_orch: 0,
            discover_target: 0,
            sweep_orch: 0,
            sweep_target: 0,
          },
        },
      ],
    },
    NOW,
  );
  for (const cls of SIGNAL_CLASSES) {
    assert.equal(s.zones[cls], "sleeping", `expected ${cls} sleeping`);
  }
});

test("deriveZoneState: propagates scope from limits", () => {
  const cases = ["all", "orch-only", "target-only"] as const;
  for (const scope of cases) {
    const s = deriveZoneState(
      { status: "running", limits: { scope }, turns: [{ slots_snapshot: {}, signals_snapshot: {} }] },
      NOW,
    );
    assert.equal(s.scope, scope);
  }
});

test("deriveZoneState: signalSeeds carries through last-fired epoch for the sprite picker", () => {
  const seeds = {
    health: NOW - 5,
    sweep_orch: NOW - 10,
    discover_orch: 0,
    sweep_target: NOW - 20,
    discover_target: NOW - 30,
  };
  const s = deriveZoneState(
    {
      status: "running",
      turns: [{ slots_snapshot: {}, signals_snapshot: seeds }],
    },
    NOW,
  );
  for (const cls of SIGNAL_CLASSES) {
    assert.equal(s.signalSeeds[cls], seeds[cls]);
  }
});

// ---------------------------------------------------------------------------
// sprite-map — pipeline / signal mapping invariants
// ---------------------------------------------------------------------------

test("sprite-map: every pipeline class maps to a known Pokemon, every signal pool is non-empty", () => {
  assert.equal(PIPELINE_CLASSES.length, 7);
  assert.equal(SIGNAL_CLASSES.length, 5);
  for (const cls of PIPELINE_CLASSES) {
    const pid = CLASS_TO_SPRITE[cls];
    assert.ok(Number.isInteger(pid) && pid > 0, `${cls} → ${pid} not a Pokedex id`);
    // classSpriteFile must produce a non-empty filename
    const f = classSpriteFile(cls, null);
    assert.match(f, /\.png$/);
  }
  for (const cls of SIGNAL_CLASSES) {
    const pool = SIGNAL_POOLS[cls];
    assert.ok(Array.isArray(pool) && pool.length > 0, `${cls} pool empty`);
  }
});

test("sprite-map: side classification covers every class once", () => {
  for (const cls of PIPELINE_CLASSES) {
    assert.ok(["orch", "target", "center"].includes(CLASS_SIDE[cls]));
  }
  for (const cls of SIGNAL_CLASSES) {
    assert.ok(["orch", "target", "center"].includes(CLASS_SIDE[cls]));
  }
});

test("pickSignalSprite: deterministic on the same seed, varies across seeds", () => {
  // Same seed → same pick.
  const a = pickSignalSprite("sweep_orch", 1779903135);
  const b = pickSignalSprite("sweep_orch", 1779903135);
  assert.equal(a, b);
  // Different seeds spread across the 3-element pool. Three consecutive
  // epochs hitting indices 0,1,2 in sweep_orch's pool of length 3.
  const ids = new Set([
    pickSignalSprite("sweep_orch", 1779903135),
    pickSignalSprite("sweep_orch", 1779903136),
    pickSignalSprite("sweep_orch", 1779903137),
  ]);
  assert.equal(ids.size, 3);
});

test("pickSignalSprite: seed=0 (never fired) returns pool[0], not a crash", () => {
  for (const cls of SIGNAL_CLASSES) {
    const pool = SIGNAL_POOLS[cls];
    assert.equal(pickSignalSprite(cls, 0), pool[0]);
  }
});
}

// ===========================================================================
// Merged from test/now-pixel-oak-town-crier.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * test/now-pixel-oak-town-crier.test.mts — covers the bubble-color
 * resolver and the closed set of class colors.
 *
 * Slice 5 of /now-pixel (#642, #647). The OakTownCrier component is a
 * thin binder over WS events + resolveBubbleColor; the visual scroll +
 * collapse mechanics are exercised in-browser. The hardest-to-rebuild
 * piece if it drifts is the source → color resolution, so we pin that.
 */





test("CLASS_BUBBLE_COLOR: every class has a non-empty CSS color", () => {
  const all = [...PIPELINE_CLASSES, ...SIGNAL_CLASSES];
  for (const cls of all) {
    const c = CLASS_BUBBLE_COLOR[cls];
    assert.ok(typeof c === "string" && c.length > 0, `missing color for ${cls}`);
    // Hex shape: #RGB or #RRGGBB, optionally with named color fallback. We
    // shipped hex strings; if that ever flips to "rgb(...)" the test
    // should be relaxed deliberately, not silently.
    assert.match(c, /^#[0-9a-fA-F]{3,8}$/);
  }
});

test("resolveBubbleColor: dev_orch is the Forge orange (spec callout)", () => {
  // The slice spec explicitly calls dev_orch the "Forge" bubble color.
  // If we ever change the palette, this is the load-bearing pin.
  assert.equal(resolveBubbleColor("dev_orch"), "#fb923c");
});

test("resolveBubbleColor: every class name maps to its own palette entry", () => {
  for (const cls of [...PIPELINE_CLASSES, ...SIGNAL_CLASSES]) {
    assert.equal(resolveBubbleColor(cls), CLASS_BUBBLE_COLOR[cls]);
  }
});

test("resolveBubbleColor: skill names map through to their class", () => {
  // Some WS events carry `subagent_type` (hydra-dev, hydra-target-build,
  // etc.) instead of the class. The resolver must still pick the right
  // color so those bubbles don't all look like the grey fallback.
  assert.equal(resolveBubbleColor("hydra-dev"), CLASS_BUBBLE_COLOR.dev_orch);
  assert.equal(
    resolveBubbleColor("hydra-target-build"),
    CLASS_BUBBLE_COLOR.dev_target,
  );
  assert.equal(resolveBubbleColor("hydra-doctor"), CLASS_BUBBLE_COLOR.health);
});

test("resolveBubbleColor: unknown source → neutral grey fallback (still renders)", () => {
  assert.equal(resolveBubbleColor("totally-made-up"), "#9ca3af");
  assert.equal(resolveBubbleColor(""), "#9ca3af");
  assert.equal(resolveBubbleColor(null), "#9ca3af");
  assert.equal(resolveBubbleColor(undefined), "#9ca3af");
});
}
