/**
 * Regression tests for the /hydra-review pickup-set phone-notify hook
 * (issue #745) — the edge-trigger logic in `checkReviewPickupNotify`.
 *
 * Invariants under test (the issue's acceptance criteria):
 *   - empty -> non-empty fires EXACTLY ONE notification
 *   - no repeat while the set stays non-empty
 *   - re-arms after the set drains to empty
 *   - payload carries count + first item title and link
 *
 * The armed-state is modelled by an in-memory flag (standing in for the Redis
 * `hydra:review:pickup-armed` key) so the edge logic is exercised without a
 * live Redis. The pickup-set fetch is stubbed per-call.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkReviewPickupNotify } from "../src/scheduler/heartbeat.ts";
import { formatMessage } from "../src/notify.ts";

interface PublishedEvent {
  stream: string;
  type: string;
  payload: any;
}

function makeFakeBus(captured: PublishedEvent[]) {
  return {
    async publish(stream: string, event: any) {
      captured.push({ stream, type: event.type, payload: event.payload });
      return "fake-id";
    },
  };
}

/** In-memory stand-in for the Redis armed-state flag. */
function makeArmedState(initial = false) {
  let notified = initial;
  return {
    getNotified: async () => notified,
    setNotified: async () => {
      notified = true;
    },
    clearNotified: async () => {
      notified = false;
    },
    peek: () => notified,
  };
}

function pickupItems(...numbers: number[]) {
  return numbers.map((n) => ({
    number: n,
    title: `Issue ${n}`,
    url: `https://x/${n}`,
    source: "ready-for-human" as const,
    sources: ["ready-for-human" as const],
  }));
}

describe("checkReviewPickupNotify — edge trigger", () => {
  test("empty -> non-empty fires exactly one notification with count + first item", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const armed = makeArmedState(false);

    const result = await checkReviewPickupNotify(bus, {
      getPickupSet: async () => pickupItems(42, 43),
      getNotified: armed.getNotified,
      setNotified: armed.setNotified,
      clearNotified: armed.clearNotified,
    });

    assert.equal(result.fired, true);
    assert.equal(result.count, 2);
    assert.equal(result.transitioned, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, "review:pickup_ready");
    assert.equal(captured[0].payload.count, 2);
    assert.equal(captured[0].payload.firstTitle, "Issue 42");
    assert.equal(captured[0].payload.firstUrl, "https://x/42");
    // Armed-spent after firing.
    assert.equal(armed.peek(), true);
  });

  test("no repeat while the set stays non-empty (already armed-spent)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const armed = makeArmedState(true); // a prior notification already fired

    const result = await checkReviewPickupNotify(bus, {
      getPickupSet: async () => pickupItems(42),
      getNotified: armed.getNotified,
      setNotified: armed.setNotified,
      clearNotified: armed.clearNotified,
    });

    assert.equal(result.fired, false);
    assert.equal(result.transitioned, false);
    assert.equal(captured.length, 0);
  });

  test("re-arms when the set drains to empty (no notification on the empty edge)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const armed = makeArmedState(true); // was non-empty, now draining

    const result = await checkReviewPickupNotify(bus, {
      getPickupSet: async () => [],
      getNotified: armed.getNotified,
      setNotified: armed.setNotified,
      clearNotified: armed.clearNotified,
    });

    assert.equal(result.fired, false);
    assert.equal(result.transitioned, true);
    assert.equal(captured.length, 0);
    // Flag cleared => next non-empty transition will fire again.
    assert.equal(armed.peek(), false);
  });

  test("empty + already re-armed is a no-op (no transition, no fire)", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const armed = makeArmedState(false);

    const result = await checkReviewPickupNotify(bus, {
      getPickupSet: async () => [],
      getNotified: armed.getNotified,
      setNotified: armed.setNotified,
      clearNotified: armed.clearNotified,
    });

    assert.equal(result.fired, false);
    assert.equal(result.transitioned, false);
    assert.equal(captured.length, 0);
  });

  test("full lifecycle: fire once, suppress, re-arm, fire again", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const armed = makeArmedState(false);
    const deps = {
      getNotified: armed.getNotified,
      setNotified: armed.setNotified,
      clearNotified: armed.clearNotified,
    };

    // 1. empty -> non-empty: fires
    await checkReviewPickupNotify(bus, { ...deps, getPickupSet: async () => pickupItems(1) });
    // 2. still non-empty: suppressed
    await checkReviewPickupNotify(bus, { ...deps, getPickupSet: async () => pickupItems(1, 2) });
    // 3. drains to empty: re-arms
    await checkReviewPickupNotify(bus, { ...deps, getPickupSet: async () => [] });
    // 4. non-empty again: fires
    await checkReviewPickupNotify(bus, { ...deps, getPickupSet: async () => pickupItems(3) });

    assert.equal(captured.length, 2);
    assert.deepEqual(captured.map((e) => e.payload.firstNumber), [1, 3]);
  });
});

describe("formatMessage — review:pickup_ready rendering", () => {
  test("renders count, the run command, and the first item with link", () => {
    const msg = formatMessage({
      type: "review:pickup_ready",
      payload: { count: 3, firstTitle: "Decide tier for PR #710", firstUrl: "https://x/710", firstNumber: 710 },
    });
    assert.ok(msg.includes("3 items"));
    assert.ok(msg.includes("/hydra-review"));
    assert.ok(msg.includes("Decide tier for PR #710"));
    assert.ok(msg.includes("https://x/710"));
  });

  test("singular wording for a single item", () => {
    const msg = formatMessage({
      type: "review:pickup_ready",
      payload: { count: 1, firstTitle: "Only one", firstUrl: "https://x/1", firstNumber: 1 },
    });
    assert.ok(msg.includes("1 item need"));
    assert.ok(!msg.includes("1 items"));
  });
});
