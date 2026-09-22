/**
 * test/recommendation-materiality.test.mts — covers the recs-engine
 * materiality-gate leaf in isolation (issue #4575; leaf extracted by #3099).
 *
 * This file imports ONLY from `../src/autopilot/recommendation-materiality.ts`
 * (plus node:test / node:assert), never from `recommendation-engine.ts`, so it
 * loads neither the Anthropic Request Adapter, the Redis seam, nor the prompt
 * builder. It is the standalone test surface that justifies the leaf staying a
 * separate file (the SETTLED note in the engine's module docblock, #4575).
 * Mirrors the test/recommendation-cap.test.mts leaf-test precedent.
 *
 * (test/recommendation-engine.test.mts keeps its own shouldFire / signature
 * cases as engine re-export regression coverage — deliberately duplicated.)
 *
 * Invariants pinned here:
 *   - shouldFire ordering: cap > interval > no-change > proceed, including cap
 *     winning when interval and no-change would also skip
 *   - cap boundary is >= (spend == cap → "cap")
 *   - interval boundary: since == MIN_CALL_INTERVAL_SECONDS proceeds,
 *     since == MIN_CALL_INTERVAL_SECONDS - 1 skips with "interval"
 *   - last_call_epoch null bypasses the interval check
 *   - last_signature null proceeds (first call)
 *   - computeMaterialChangeSignature is deterministic, changes on dispatches /
 *     autopilot_running / slot_status_summary / a new permission wait, and only
 *     the first 5 permission_waits contribute
 *   - summariseSlotStatus is key-order independent, renders a missing status
 *     as "?", and returns "" for an empty snapshot
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_CALL_INTERVAL_SECONDS,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  shouldFire,
} from "../src/autopilot/recommendation-materiality.ts";

const NOW = 1_800_000_000;

function fireInput(overrides: Partial<Parameters<typeof shouldFire>[0]> = {}): Parameters<typeof shouldFire>[0] {
  return {
    now_epoch: NOW,
    last_call_epoch: NOW - 3600,
    current_signature: "sig-new",
    last_signature: "sig-old",
    daily_spend_usd: 0,
    daily_cap_usd: 1,
    ...overrides,
  };
}

type SigInput = Parameters<typeof computeMaterialChangeSignature>[0];

function sigInput(overrides: Partial<SigInput> = {}): SigInput {
  return {
    dispatches: 3,
    permission_waits: [{ slot: "dev", ts_epoch: 100 }],
    slot_status_summary: "dev:running,qa:idle",
    autopilot_running: true,
    ...overrides,
  };
}

// --- shouldFire -------------------------------------------------------------

test("materiality: shouldFire proceeds when every gate passes", () => {
  assert.deepEqual(shouldFire(fireInput()), { proceed: true });
});

test("materiality: cap wins even when interval and no-change would also skip", () => {
  const decision = shouldFire(
    fireInput({
      last_call_epoch: NOW - 1,
      current_signature: "same",
      last_signature: "same",
      daily_spend_usd: 5,
      daily_cap_usd: 1,
    }),
  );
  assert.deepEqual(decision, { proceed: false, skip_reason: "cap" });
});

test("materiality: interval beats no-change when both would skip", () => {
  const decision = shouldFire(
    fireInput({ last_call_epoch: NOW - 1, current_signature: "same", last_signature: "same" }),
  );
  assert.deepEqual(decision, { proceed: false, skip_reason: "interval" });
});

test("materiality: no-change skips when signature matches and interval elapsed", () => {
  const decision = shouldFire(fireInput({ current_signature: "same", last_signature: "same" }));
  assert.deepEqual(decision, { proceed: false, skip_reason: "no-change" });
});

test("materiality: cap boundary is >= (spend == cap skips with cap)", () => {
  assert.deepEqual(shouldFire(fireInput({ daily_spend_usd: 1, daily_cap_usd: 1 })), {
    proceed: false,
    skip_reason: "cap",
  });
  assert.deepEqual(shouldFire(fireInput({ daily_spend_usd: 0.999999, daily_cap_usd: 1 })), {
    proceed: true,
  });
});

test("materiality: interval boundary — since == MIN proceeds, since == MIN-1 skips", () => {
  assert.equal(MIN_CALL_INTERVAL_SECONDS, 30);
  assert.deepEqual(shouldFire(fireInput({ last_call_epoch: NOW - MIN_CALL_INTERVAL_SECONDS })), {
    proceed: true,
  });
  assert.deepEqual(shouldFire(fireInput({ last_call_epoch: NOW - (MIN_CALL_INTERVAL_SECONDS - 1) })), {
    proceed: false,
    skip_reason: "interval",
  });
});

test("materiality: null last_call_epoch bypasses the interval check", () => {
  assert.deepEqual(shouldFire(fireInput({ last_call_epoch: null })), { proceed: true });
  // Still subject to no-change when the signature matches.
  assert.deepEqual(
    shouldFire(fireInput({ last_call_epoch: null, current_signature: "s", last_signature: "s" })),
    { proceed: false, skip_reason: "no-change" },
  );
});

test("materiality: null last_signature proceeds (first call)", () => {
  assert.deepEqual(
    shouldFire(fireInput({ last_call_epoch: null, last_signature: null, current_signature: "" })),
    { proceed: true },
  );
});

// --- computeMaterialChangeSignature ----------------------------------------

test("materiality: signature is deterministic for identical input", () => {
  assert.equal(computeMaterialChangeSignature(sigInput()), computeMaterialChangeSignature(sigInput()));
});

test("materiality: signature changes on dispatches, running flag, slot summary and new permission wait", () => {
  const base = computeMaterialChangeSignature(sigInput());
  assert.notEqual(computeMaterialChangeSignature(sigInput({ dispatches: 4 })), base);
  assert.notEqual(computeMaterialChangeSignature(sigInput({ autopilot_running: false })), base);
  assert.notEqual(computeMaterialChangeSignature(sigInput({ slot_status_summary: "dev:done,qa:idle" })), base);
  assert.notEqual(
    computeMaterialChangeSignature(
      sigInput({ permission_waits: [{ slot: "dev", ts_epoch: 100 }, { slot: "qa", ts_epoch: 200 }] }),
    ),
    base,
  );
});

test("materiality: only the first 5 permission waits contribute to the signature", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ slot: `s${i}`, ts_epoch: 100 + i }));
  const six = [...five, { slot: "s5", ts_epoch: 999 }];
  assert.equal(
    computeMaterialChangeSignature(sigInput({ permission_waits: six })),
    computeMaterialChangeSignature(sigInput({ permission_waits: five })),
  );
  // A change inside the first five DOES change the signature.
  const fiveAltered = [...five.slice(0, 4), { slot: "s4", ts_epoch: 555 }];
  assert.notEqual(
    computeMaterialChangeSignature(sigInput({ permission_waits: fiveAltered })),
    computeMaterialChangeSignature(sigInput({ permission_waits: five })),
  );
});

// --- summariseSlotStatus ----------------------------------------------------

test("materiality: summariseSlotStatus is key-order independent", () => {
  const a = summariseSlotStatus({ qa: { status: "idle" }, dev: { status: "running" } });
  const b = summariseSlotStatus({ dev: { status: "running" }, qa: { status: "idle" } });
  assert.equal(a, b);
  assert.equal(a, "dev:running,qa:idle");
});

test("materiality: summariseSlotStatus renders a missing status as '?'", () => {
  const snapshot = { dev: {} } as unknown as Parameters<typeof summariseSlotStatus>[0];
  assert.equal(summariseSlotStatus(snapshot), "dev:?");
});

test("materiality: summariseSlotStatus returns '' for an empty snapshot", () => {
  assert.equal(summariseSlotStatus({}), "");
});
