/**
 * test/now-pixel-stat-derivation.test.mts — pins HP / EXP / Cooldown
 * derivations + the evolution-chain lookup for slice 6 of /now-pixel
 * (#642, #648).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveHp,
  deriveExp,
  deriveCooldown,
} from "../dashboard/src/pages/now-pixel/derive-sprite-state.ts";
import {
  subagentSpriteFile,
  EVOLUTION_CHAINS,
  SIGNAL_COOLDOWNS,
} from "../dashboard/src/pages/now-pixel/sprite-map.ts";

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
