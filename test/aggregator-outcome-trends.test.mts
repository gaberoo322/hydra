/**
 * Regression tests for the outcome-trends aggregator (issue #619).
 *
 * Pure helpers (`computeDeltaPct`, `bucketPoints`) are tested directly.
 * Integration shape uses a stub `loadOutcomes` + `readCurrentValue` so
 * no Redis or config file is required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getOutcomeTrends,
  bucketPoints,
  computeDeltaPct,
} from "../src/aggregators/outcome-trends.ts";
import type { Outcome } from "../src/outcomes.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

const SAMPLE_OUTCOME: Outcome = {
  name: "orchestrator-self-improvement-share",
  kind: "terminal",
  direction: "up",
  source: "file",
  query: "/tmp/nonexistent.txt",
  baseline: 0.25,
  target: 0.5,
  noise_epsilon: 0.05,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("bucketPoints — pure helper (current-only)", () => {
  const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);

  test("returns [] when no current reading", () => {
    assert.deepEqual(bucketPoints(null, start, NOW), []);
  });

  test("returns [current] when a current reading is present", () => {
    const result = bucketPoints(
      { value: 0.4, ts: NOW.toISOString() },
      start,
      NOW,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].v, 0.4);
  });

  test("drops the current reading when it falls outside the window", () => {
    const before = new Date(start.getTime() - 60_000).toISOString();
    const result = bucketPoints({ value: 0.1, ts: before }, start, NOW);
    assert.deepEqual(result, []);
  });

  test("keeps a current reading just inside the window", () => {
    const inside = new Date(start.getTime() + 60_000).toISOString();
    const result = bucketPoints({ value: 0.2, ts: inside }, start, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].v, 0.2);
  });
});

describe("computeDeltaPct — pure helper", () => {
  test("returns null with no points", () => {
    assert.equal(computeDeltaPct([], 0.25), null);
  });

  test("returns null when baseline is 0", () => {
    assert.equal(computeDeltaPct([{ t: "2026-05-26T12:00Z", v: 0.5 }], 0), null);
  });

  test("returns positive % when latest > baseline", () => {
    const v = computeDeltaPct([{ t: "2026-05-26T12:00Z", v: 0.5 }], 0.25);
    assert.equal(v, 100); // (0.5 - 0.25) / 0.25 * 100
  });

  test("returns negative % when latest < baseline", () => {
    const v = computeDeltaPct([{ t: "2026-05-26T12:00Z", v: 0.125 }], 0.25);
    assert.equal(v, -50);
  });

  test("uses latest point only", () => {
    const v = computeDeltaPct(
      [
        { t: "2026-05-25T12:00Z", v: 0.1 },
        { t: "2026-05-26T12:00Z", v: 0.5 },
      ],
      0.25,
    );
    assert.equal(v, 100);
  });

  test("baseline-boundary: zero-delta at exactly baseline", () => {
    const v = computeDeltaPct([{ t: "2026-05-26T12:00Z", v: 0.25 }], 0.25);
    assert.equal(v, 0);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getOutcomeTrends — happy path", () => {
  test("single declared outcome with current reading produces one trend", async () => {
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [SAMPLE_OUTCOME],
      readCurrentValue: async () => ({
        value: 0.4,
        ts: NOW.toISOString(),
      }),
    });
    assert.equal(response.windowDays, 7);
    assert.equal(response.outcomes.length, 1);
    const t = response.outcomes[0];
    assert.equal(t.name, "orchestrator-self-improvement-share");
    assert.equal(t.points.length, 1);
    assert.equal(t.points[0].v, 0.4);
    assert.equal(t.baseline, 0.25);
    assert.equal(t.deltaPct !== null && t.deltaPct > 0, true);
  });

  test("multiple outcomes each get their own card", async () => {
    const second: Outcome = { ...SAMPLE_OUTCOME, name: "another-outcome" };
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [SAMPLE_OUTCOME, second],
      readCurrentValue: async () => ({
        value: 0.3,
        ts: NOW.toISOString(),
      }),
    });
    assert.equal(response.outcomes.length, 2);
    assert.deepEqual(
      response.outcomes.map((o) => o.name),
      ["orchestrator-self-improvement-share", "another-outcome"],
    );
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getOutcomeTrends — empty state", () => {
  test("no declared outcomes returns empty array", async () => {
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [],
      readCurrentValue: async () => null,
    });
    assert.deepEqual(response.outcomes, []);
  });

  test("reader returns null → trend has empty points + null delta", async () => {
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [SAMPLE_OUTCOME],
      readCurrentValue: async () => null,
    });
    assert.equal(response.outcomes.length, 1);
    assert.deepEqual(response.outcomes[0].points, []);
    assert.equal(response.outcomes[0].deltaPct, null);
  });
});

// ---------------------------------------------------------------------------
// Window boundary
// ---------------------------------------------------------------------------

describe("getOutcomeTrends — window boundary (current reading only)", () => {
  test("current reading just inside window is kept", async () => {
    const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const justInside = new Date(start.getTime() + 1_000).toISOString();
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [SAMPLE_OUTCOME],
      readCurrentValue: async () => ({ value: 0.27, ts: justInside }),
    });
    assert.equal(response.outcomes[0].points.length, 1);
    assert.equal(response.outcomes[0].points[0].v, 0.27);
  });

  test("current reading just outside window is dropped", async () => {
    const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const justOutside = new Date(start.getTime() - 1_000).toISOString();
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [SAMPLE_OUTCOME],
      readCurrentValue: async () => ({ value: 0.27, ts: justOutside }),
    });
    assert.deepEqual(response.outcomes[0].points, []);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe("getOutcomeTrends — failure isolation", () => {
  test("loader throws → returns empty outcomes, never throws", async () => {
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => {
        throw new Error("config gone");
      },
    });
    assert.deepEqual(response.outcomes, []);
  });

  test("reader throws for one outcome → placeholder card emitted", async () => {
    const response = await getOutcomeTrends(7, {
      now: NOW,
      loadOutcomes: async () => [SAMPLE_OUTCOME],
      readCurrentValue: async () => {
        throw new Error("source down");
      },
    });
    assert.equal(response.outcomes.length, 1);
    assert.deepEqual(response.outcomes[0].points, []);
    assert.equal(response.outcomes[0].deltaPct, null);
    assert.equal(response.outcomes[0].name, SAMPLE_OUTCOME.name);
  });
});
