/**
 * Autonomy Rate fan-out tests (issue #2068).
 *
 * `computeAutonomyRate(prWindow, deps)` is the multi-source fan-out extracted
 * from builder-health.ts: it reads the dispatch->PR links, views each PR via a
 * `fetchPrView` dep, classifies autonomy, and folds into the autonomy-rate +
 * time-to-merge slices. These tests exercise it with a stubbed `fetchPrView`
 * and `listPrLinksSince` — no Redis, no live `gh` process, and no full
 * scorecard fixture — covering the headline branches:
 *   - bot-merged with no intervention  => autonomous
 *   - human review present             => non-autonomous (human-review)
 * plus the unmerged / unavailable-view edge cases the contract pins.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  computeAutonomyRate,
  percentile,
  type AutonomyRateDeps,
} from "../src/aggregators/autonomy-rate.ts";
import type { GhPrView } from "../src/aggregators/autonomy-classifier.ts";

const NOW = new Date("2026-06-18T12:00:00.000Z");

function deps(overrides: Partial<AutonomyRateDeps> = {}): AutonomyRateDeps {
  return {
    now: NOW,
    listPrLinksSince: async () => [
      { prNumber: "100", openedAtMs: String(NOW.getTime() - 30 * 60_000) },
    ],
    fetchPrView: async (): Promise<GhPrView | null> => ({
      number: 100,
      mergedAt: NOW.toISOString(),
      mergedBy: { login: "github-actions[bot]", is_bot: true },
      labels: [],
      reviews: [],
      commits: [],
    }),
    ...overrides,
  };
}

describe("computeAutonomyRate — fan-out", () => {
  test("bot-merged, no intervention => autonomous (rate 1.0)", async () => {
    const { autonomy } = await computeAutonomyRate(50, deps());
    assert.equal(autonomy.total, 1);
    assert.equal(autonomy.autonomous, 1);
    assert.equal(autonomy.rate, 1);
    const d = autonomy.breakdown.find((x) => x.prNumber === 100);
    assert.equal(d?.autonomous, true);
    assert.equal(d?.reason, "autonomous");
  });

  test("human review present => non-autonomous (human-review, rate 0)", async () => {
    const { autonomy } = await computeAutonomyRate(
      50,
      deps({
        fetchPrView: async () => ({
          number: 100,
          mergedAt: NOW.toISOString(),
          mergedBy: { login: "github-actions[bot]", is_bot: true },
          labels: [],
          reviews: [{ author: { login: "gabe", is_bot: false } }],
          commits: [],
        }),
      }),
    );
    assert.equal(autonomy.total, 1);
    assert.equal(autonomy.autonomous, 0);
    assert.equal(autonomy.rate, 0);
    const d = autonomy.breakdown.find((x) => x.prNumber === 100);
    assert.equal(d?.autonomous, false);
    assert.equal(d?.reason, "human-review");
  });

  test("mixed window: one autonomous, one human-merged => rate 0.5", async () => {
    const { autonomy, timeToMerge } = await computeAutonomyRate(
      50,
      deps({
        listPrLinksSince: async () => [
          { prNumber: "100", openedAtMs: String(NOW.getTime() - 30 * 60_000) },
          { prNumber: "101", openedAtMs: String(NOW.getTime() - 90 * 60_000) },
        ],
        fetchPrView: async (pr: number) =>
          pr === 100
            ? {
                number: 100,
                mergedAt: NOW.toISOString(),
                mergedBy: { login: "github-actions[bot]", is_bot: true },
                labels: [],
                reviews: [],
                commits: [],
              }
            : {
                number: 101,
                mergedAt: NOW.toISOString(),
                mergedBy: { login: "gabe", is_bot: false },
                labels: [],
                reviews: [],
                commits: [],
              },
      }),
    );
    assert.equal(autonomy.total, 2);
    assert.equal(autonomy.autonomous, 1);
    assert.equal(autonomy.rate, 0.5);
    // latencies 30m + 90m => median 60.
    assert.equal(timeToMerge.samples, 2);
    assert.equal(timeToMerge.medianMinutes, 60);
    assert.equal(timeToMerge.window, 50);
  });

  test("unmerged PRs are excluded from the denominator", async () => {
    const { autonomy, timeToMerge } = await computeAutonomyRate(
      50,
      deps({
        fetchPrView: async () => ({
          number: 100,
          mergedAt: null, // still open
          mergedBy: null,
          labels: [],
          reviews: [],
          commits: [],
        }),
      }),
    );
    assert.equal(autonomy.total, 0);
    assert.equal(autonomy.rate, 0);
    assert.equal(timeToMerge.samples, 0);
    assert.equal(timeToMerge.medianMinutes, null);
  });

  test("an unavailable PR view counts as non-autonomous-unknown", async () => {
    const { autonomy } = await computeAutonomyRate(
      50,
      deps({ fetchPrView: async () => null }),
    );
    const d = autonomy.breakdown.find((x) => x.prNumber === 100);
    assert.equal(d?.autonomous, false);
    assert.equal(d?.reason, "pr-view-unavailable");
  });

  test("non-integer / non-positive PR numbers are skipped", async () => {
    const { autonomy } = await computeAutonomyRate(
      50,
      deps({
        listPrLinksSince: async () => [
          { prNumber: "0", openedAtMs: String(NOW.getTime()) },
          { prNumber: "abc", openedAtMs: String(NOW.getTime()) },
          { prNumber: "-5", openedAtMs: String(NOW.getTime()) },
        ],
      }),
    );
    assert.equal(autonomy.total, 0);
    assert.equal(autonomy.breakdown.length, 0);
  });

  test("prWindow caps the newest links and is echoed on both slices", async () => {
    const { autonomy, timeToMerge } = await computeAutonomyRate(
      1,
      deps({
        listPrLinksSince: async () => [
          { prNumber: "100", openedAtMs: String(NOW.getTime() - 30 * 60_000) },
          { prNumber: "101", openedAtMs: String(NOW.getTime() - 90 * 60_000) },
        ],
        fetchPrView: async (pr: number) => ({
          number: pr,
          mergedAt: NOW.toISOString(),
          mergedBy: { login: "github-actions[bot]", is_bot: true },
          labels: [],
          reviews: [],
          commits: [],
        }),
      }),
    );
    // Only the first (newest) link is processed.
    assert.equal(autonomy.total, 1);
    assert.equal(autonomy.window, 1);
    assert.equal(timeToMerge.window, 1);
  });
});

describe("percentile — pure helper (re-exported from autonomy-rate)", () => {
  test("returns 0 for empty input", () => {
    assert.equal(percentile([], 50), 0);
  });

  test("returns the single value", () => {
    assert.equal(percentile([42], 90), 42);
  });

  test("linear-interpolates between samples", () => {
    assert.equal(percentile([40, 10, 30, 20], 50), 25);
  });

  test("filters non-finite values", () => {
    assert.equal(percentile([10, NaN, 20, Infinity], 50), 15);
  });
});
