/**
 * test/recommendation-prompt.test.mts — covers the recs-engine PROMPT-GRAMMAR
 * leaf (issue #2867: re-extracted from recommendation-engine.ts).
 *
 * This is the focused home for the prompt-grammar concern the #2867
 * architecture-scan re-extracted: `buildPrompt`, `parseLlmResponse`, and the
 * `PROMPT_SIZE_BUDGET_BYTES` budget. It imports DIRECTLY from the leaf
 * (`src/autopilot/recommendation-prompt.ts`) — the whole point of the extraction
 * is that a promptfoo scorer can import `buildPrompt` without the engine's
 * Redis/Anthropic transitive deps loading, so this test proves the leaf is
 * importable on its own.
 *
 * The engine's onTurnEnd hot path, materiality gate, and daily-cap ledger stay
 * covered in test/recommendation-engine.test.mts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROMPT_SIZE_BUDGET_BYTES,
  MAX_RECS_PER_CALL,
  buildPrompt,
  parseLlmResponse,
  type TurnEndPayload,
} from "../src/autopilot/recommendation-prompt.ts";

function makeTurnEnd(overrides: Partial<TurnEndPayload> = {}): TurnEndPayload {
  return {
    event: "turn_end",
    run_id: "run-A",
    turn_n: 1,
    dispatches: 0,
    skipped: 0,
    idle: 0,
    tokens_after: 0,
    ts_epoch: 1_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPrompt — prompt-size budget
// ---------------------------------------------------------------------------

test("buildPrompt stays under the 4KB prompt-size budget for a saturated input", () => {
  const prompt = buildPrompt({
    recent_turns: Array.from({ length: 3 }, (_, i) => ({
      turn_n: i + 1,
      dispatches: 5,
      skipped: 2,
      idle: 0,
      ts_epoch: 1_000_000 + i,
    })),
    slot_snapshot: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `dev_orch_slot_${i}`,
        { status: "dispatched", since_epoch: 1_000_000 },
      ]),
    ),
    signals_snapshot: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `signal_${i}`,
        `pretty long value with random padding to test the clip ${"x".repeat(50)}`,
      ]),
    ),
    recent_permission_waits: Array.from({ length: 5 }, (_, i) => ({
      slot: `dev_target_${i}`,
      tool: "Bash",
      ts_epoch: 1_000_000 + i * 10,
    })),
    daily_spend_usd: 0.42,
    turn_end: makeTurnEnd({ dispatches: 5, skipped: 2 }),
  });
  const size = Buffer.byteLength(prompt, "utf8");
  assert.ok(
    size <= PROMPT_SIZE_BUDGET_BYTES,
    `prompt was ${size} bytes, budget is ${PROMPT_SIZE_BUDGET_BYTES}`,
  );
});

test("buildPrompt is far under budget for a minimal input", () => {
  const prompt = buildPrompt({
    recent_turns: [],
    slot_snapshot: {},
    signals_snapshot: {},
    recent_permission_waits: [],
    daily_spend_usd: 0,
    turn_end: makeTurnEnd(),
  });
  assert.ok(Buffer.byteLength(prompt, "utf8") < 1024);
});

// ---------------------------------------------------------------------------
// buildPrompt — grammar shape (a richer suite the leaf now invites, #2867)
// ---------------------------------------------------------------------------

test("buildPrompt names Oak and includes the triggering turn header + spend line", () => {
  const prompt = buildPrompt({
    recent_turns: [],
    slot_snapshot: {},
    signals_snapshot: {},
    recent_permission_waits: [],
    daily_spend_usd: 0.5,
    turn_end: makeTurnEnd({ turn_n: 7, run_id: "run-Z", dispatches: 3, skipped: 1, idle: 0, tokens_after: 4200 }),
  });
  assert.ok(prompt.includes("You are Oak"), "prompt names the Oak persona");
  assert.ok(prompt.includes("# Turn 7 (run run-Z)"), "prompt carries the triggering turn header");
  assert.ok(
    prompt.includes("dispatches=3 skipped=1 idle=0 tokens=4200 daily_spend_usd=0.5000"),
    "prompt renders the turn counters + 4-dp spend line",
  );
});

test("buildPrompt clips recent turns to 3, slots + signals to 12, permission-waits to 5", () => {
  const prompt = buildPrompt({
    recent_turns: Array.from({ length: 10 }, (_, i) => ({
      turn_n: i,
      dispatches: 0,
      skipped: 0,
      idle: 0,
      ts_epoch: 1_000_000 + i,
    })),
    slot_snapshot: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`slot_${i}`, { status: "idle" }]),
    ),
    signals_snapshot: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`sig_${i}`, `v${i}`]),
    ),
    recent_permission_waits: Array.from({ length: 20 }, (_, i) => ({
      slot: `s_${i}`,
      ts_epoch: 1_000_000 + i,
    })),
    daily_spend_usd: 0,
    turn_end: makeTurnEnd(),
  });
  // Recent turns clipped to 3 (turns 0,1,2 render; turn_n=3+ do not).
  assert.ok(prompt.includes("turn_n=0"));
  assert.ok(prompt.includes("turn_n=2"));
  assert.ok(!prompt.includes("turn_n=3"));
  // Slots clipped to 12.
  assert.ok(prompt.includes("slot_11:"));
  assert.ok(!prompt.includes("slot_12:"));
  // Signals clipped to 12.
  assert.ok(prompt.includes("sig_11="));
  assert.ok(!prompt.includes("sig_12="));
  // Permission-waits clipped to 5.
  assert.ok(prompt.includes("s_4 at"));
  assert.ok(!prompt.includes("s_5 at"));
});

test("buildPrompt clips an over-long signal value to 80 chars with an ellipsis", () => {
  const long = "y".repeat(200);
  const prompt = buildPrompt({
    recent_turns: [],
    slot_snapshot: {},
    signals_snapshot: { big: long },
    recent_permission_waits: [],
    daily_spend_usd: 0,
    turn_end: makeTurnEnd(),
  });
  assert.ok(prompt.includes(`- big=${"y".repeat(77)}...`), "value clipped to 77 chars + ellipsis");
  assert.ok(!prompt.includes("y".repeat(81)), "no un-clipped 81-char run survives");
});

// ---------------------------------------------------------------------------
// parseLlmResponse — extraction, clipping, defensive rejection
// ---------------------------------------------------------------------------

test("MAX_RECS_PER_CALL is the exported hard ceiling of 3", () => {
  assert.equal(MAX_RECS_PER_CALL, 3);
});

test("parseLlmResponse extracts valid recommendations and clips to 3", () => {
  const recs = parseLlmResponse({
    rawJsonText: JSON.stringify({
      recommendations: [
        { severity: "info", message: "first" },
        { severity: "warn", message: "second" },
        { severity: "critical", message: "third" },
        { severity: "info", message: "fourth — should be dropped" },
      ],
    }),
    runId: "run-A",
    evidenceId: "turn:1",
    nowIso: "2026-05-28T00:00:00Z",
    turnN: 1,
  });
  assert.equal(recs.length, 3);
  assert.equal(recs[0].id, "run-A:1:0");
  assert.equal(recs[0].run_id, "run-A");
  assert.equal(recs[0].evidence_id, "turn:1");
  assert.equal(recs[0].severity, "info");
  assert.equal(recs[2].severity, "critical");
});

test("parseLlmResponse rejects malformed json and unknown severities", () => {
  assert.deepEqual(
    parseLlmResponse({
      rawJsonText: "not json{",
      runId: "x",
      evidenceId: "y",
      nowIso: "",
      turnN: 0,
    }),
    [],
  );
  const recs = parseLlmResponse({
    rawJsonText: JSON.stringify({
      recommendations: [
        { severity: "panic", message: "drop" },
        { severity: "info", message: "" },
        { severity: "info", message: "keep" },
      ],
    }),
    runId: "x",
    evidenceId: "y",
    nowIso: "2026-05-28T00:00:00Z",
    turnN: 0,
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].message, "keep");
});

test("parseLlmResponse returns empty on a non-object payload or missing array", () => {
  assert.deepEqual(
    parseLlmResponse({ rawJsonText: "42", runId: "x", evidenceId: "y", nowIso: "", turnN: 0 }),
    [],
  );
  assert.deepEqual(
    parseLlmResponse({
      rawJsonText: JSON.stringify({ recommendations: "not-an-array" }),
      runId: "x",
      evidenceId: "y",
      nowIso: "",
      turnN: 0,
    }),
    [],
  );
});

test("parseLlmResponse clips an over-long message to 200 chars", () => {
  const recs = parseLlmResponse({
    rawJsonText: JSON.stringify({
      recommendations: [{ severity: "info", message: "m".repeat(500) }],
    }),
    runId: "r",
    evidenceId: "e",
    nowIso: "2026-05-28T00:00:00Z",
    turnN: 3,
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].message.length, 200);
});
