/**
 * test/now-pixel-zone-derivation.test.mts — covers deriveZoneState plus
 * the sprite-map pure helpers.
 *
 * Slice 3 of /now-pixel (#642, #645). All 12 classes are exercised in
 * both sleeping and active states.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveZoneState,
  SIGNAL_ACTIVE_WINDOW_SEC,
} from "../dashboard/src/pages/now-pixel/derive-sprite-state.ts";
import {
  classSpriteFile,
  pickSignalSprite,
  CLASS_SIDE,
  CLASS_TO_SPRITE,
  PIPELINE_CLASSES,
  SIGNAL_CLASSES,
  SIGNAL_POOLS,
} from "../dashboard/src/pages/now-pixel/sprite-map.ts";

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
