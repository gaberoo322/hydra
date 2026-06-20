/**
 * Property-based tests for the backlog lane state machine's PURE logic
 * (issue #2203 — first fast-check integration).
 *
 * Where the example-based suites (test/backlog.test.mts,
 * test/backlog-atomic-transition.test.mts) pin a handful of illustrative lane
 * moves against a live Redis, these tests describe the *invariants* of the two
 * pure, Redis-free helpers that every lane transition routes through —
 * `applyLaneTransition` and `sortByQueuePriority` (src/backlog/internal.ts) —
 * and let fast-check hammer thousands of generated inputs at each invariant,
 * shrinking any failure to a minimal counter-example.
 *
 * Deliberately scoped to the PURE functions: they take a plain item object and
 * return synchronously with no I/O, so this suite needs NO Redis connection and
 * cannot flake on the shared-DB teardown timing that bites the Redis-backed
 * backlog suites in worktree CI. fast-check is a devDependency only (never
 * imported by src/) and runs under the same node:test runner as every other
 * suite — see CLAUDE.md / issue #2203 for the no-runtime-dependency rationale.
 *
 * A failing property prints `{ counterexample, seed, path }`; pin a seed with
 * `fc.assert(prop, { seed: N })` to replay a specific failure deterministically.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  LANES,
  applyLaneTransition,
  sortByQueuePriority,
} from "../src/backlog/internal.ts";

// An arbitrary that yields one of the six canonical lanes.
const laneArb = fc.constantFrom(...LANES);

// A minimal backlog-item arbitrary carrying only the fields the pure helpers
// read or write. Pre-seeds the claim fields with arbitrary values so we can
// assert the transition OVERWRITES them correctly regardless of prior state.
// Typed `any` (matching src/backlog/lanes.ts, where items are `any`) because
// applyLaneTransition writes dynamic fields (movedAt) the static record shape
// doesn't declare.
const itemArb: fc.Arbitrary<any> = fc.record({
  id: fc.integer({ min: 1, max: 100000 }),
  title: fc.string(),
  lane: fc.option(laneArb, { nil: undefined }),
  claimedAt: fc.option(fc.string(), { nil: null }),
  claimedBy: fc.option(fc.string(), { nil: null }),
});

describe("applyLaneTransition — pure transition invariants (property)", () => {
  test("always sets item.lane to the target lane", () => {
    fc.assert(
      fc.property(itemArb, laneArb, (item, target) => {
        applyLaneTransition(item, target, {}, 1_700_000_000_000);
        return item.lane === target;
      }),
    );
  });

  test("always stamps a valid ISO movedAt equal to the passed clock", () => {
    fc.assert(
      fc.property(
        itemArb,
        laneArb,
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (item, target, now) => {
          const { movedAt } = applyLaneTransition(item, target, {}, now);
          // movedAt is returned, written onto the item, and round-trips to `now`.
          return (
            movedAt === item.movedAt &&
            new Date(movedAt).getTime() === now &&
            movedAt === new Date(now).toISOString()
          );
        },
      ),
    );
  });

  test("entering inProgress sets claimedAt=movedAt and records the claimant", () => {
    fc.assert(
      fc.property(
        itemArb,
        fc.option(fc.string(), { nil: null }),
        (item, claimedBy) => {
          applyLaneTransition(item, "inProgress", { claimedBy }, 1_700_000_000_000);
          // claimedAt mirrors movedAt; claimedBy is the supplied value (or, when
          // null, falls back to any pre-existing claim — never undefined).
          const claimOk = claimedBy != null
            ? item.claimedBy === claimedBy
            : item.claimedBy === (item.claimedBy ?? null);
          return item.claimedAt === item.movedAt && claimOk;
        },
      ),
    );
  });

  test("leaving inProgress (any non-inProgress target) clears both claim fields", () => {
    const nonInProgress = fc.constantFrom(...LANES.filter((l) => l !== "inProgress"));
    fc.assert(
      fc.property(
        itemArb,
        nonInProgress,
        fc.option(fc.string(), { nil: null }),
        (item, target, claimedBy) => {
          // Force a prior claim, then transition away from inProgress.
          item.lane = "inProgress";
          item.claimedAt = "2026-01-01T00:00:00.000Z";
          item.claimedBy = claimedBy ?? "prior-claimant";
          applyLaneTransition(item, target, {}, 1_700_000_000_000);
          return item.claimedAt === null && item.claimedBy === null;
        },
      ),
    );
  });

  test("is idempotent on lane: transitioning to the same lane twice is a fixpoint", () => {
    fc.assert(
      fc.property(itemArb, laneArb, (item, target) => {
        applyLaneTransition(item, target, {}, 1_700_000_000_000);
        const firstLane = item.lane;
        applyLaneTransition(item, target, {}, 1_700_000_000_000);
        return item.lane === firstLane && item.lane === target;
      }),
    );
  });
});

describe("sortByQueuePriority — total-order invariants (property)", () => {
  // Items as the queue sorter sees them: a numeric priority plus a meta bag
  // carrying the score / addedAt tiebreakers.
  const queueItemArb = fc.record({
    id: fc.integer({ min: 1, max: 100000 }),
    priority: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
    meta: fc.record({
      score: fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
      addedAt: fc.option(fc.string(), { nil: undefined }),
    }),
  });

  // The effective priority order key the sorter uses: 0/unset sorts LAST (99),
  // every positive priority sorts by its own value ascending.
  const orderKey = (p?: number) => (!p ? 99 : p);

  test("returns a permutation of the input (no items lost or duplicated)", () => {
    fc.assert(
      fc.property(fc.array(queueItemArb), (items) => {
        const ids = items.map((i) => i.id).sort();
        const out = sortByQueuePriority([...items]);
        const outIds = out.map((i) => i.id).sort();
        return (
          out.length === items.length &&
          JSON.stringify(ids) === JSON.stringify(outIds)
        );
      }),
    );
  });

  test("priority order is non-decreasing across the whole result", () => {
    fc.assert(
      fc.property(fc.array(queueItemArb), (items) => {
        const out = sortByQueuePriority([...items]);
        for (let i = 1; i < out.length; i++) {
          if (orderKey(out[i - 1].priority) > orderKey(out[i].priority)) return false;
        }
        return true;
      }),
    );
  });

  test("within an equal priority, higher score never sorts after lower score", () => {
    fc.assert(
      fc.property(fc.array(queueItemArb), (items) => {
        const out = sortByQueuePriority([...items]);
        for (let i = 1; i < out.length; i++) {
          const prev = out[i - 1];
          const cur = out[i];
          if (orderKey(prev.priority) !== orderKey(cur.priority)) continue;
          const sPrev = prev.meta?.score ?? 0;
          const sCur = cur.meta?.score ?? 0;
          // Descending score within a priority band: prev's score must be >= cur's.
          if (sPrev < sCur) return false;
        }
        return true;
      }),
    );
  });

  test("is idempotent: sorting an already-sorted array is a fixpoint by id order", () => {
    fc.assert(
      fc.property(fc.array(queueItemArb), (items) => {
        const once = sortByQueuePriority([...items]);
        const twice = sortByQueuePriority([...once]);
        return (
          JSON.stringify(once.map((i) => i.id)) ===
          JSON.stringify(twice.map((i) => i.id))
        );
      }),
    );
  });

  test("sorts in place and returns the same array reference it was given", () => {
    fc.assert(
      fc.property(fc.array(queueItemArb), (items) => {
        const input = [...items];
        const out = sortByQueuePriority(input);
        return out === input;
      }),
    );
  });
});

// A single example-based sanity check that the suite's pure functions are
// wired (so a future refactor that breaks the import surfaces here, not just in
// the generative properties).
describe("backlog-lanes-property — import sanity", () => {
  test("LANES has the six canonical lanes in order", () => {
    assert.deepEqual(LANES, [
      "triage",
      "backlog",
      "queued",
      "blocked",
      "inProgress",
      "done",
    ]);
  });
});
