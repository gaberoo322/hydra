/**
 * Regression tests for Work-Queue Hygiene (issue #1690 / #1844).
 *
 * `src/backlog/work-queue-hygiene.ts` owns the resolved-state reaper that the
 * hourly `work-queue-hygiene` housekeeping chore and `POST /api/queue/reconcile`
 * both drive. It was extracted from `src/anchor-candidates.ts` (issue #1844) —
 * an orthogonal concern with its own call-site profile. `reconcileWorkQueue`'s
 * injectable `deps` are the test surface; these tests pin the fail-open removal
 * rules (merged-work + all-closed-issue) and the never-throw degradation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  harvestOrchIssueRefs,
  reconcileWorkQueue,
} from "../src/backlog/work-queue-hygiene.ts";

const NOW = Date.UTC(2026, 4, 31, 12, 0, 0);
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

describe("harvestOrchIssueRefs — pure ref harvesting (#1690)", () => {
  test("harvests #NNN and issue-NNN from reference + reason; dedupes", () => {
    const refs = harvestOrchIssueRefs({
      reference: "fix the feed (#1683) per issue-1683",
      reason: "filed from retro, see #1690",
    });
    assert.deepEqual(refs.sort(), ["1683", "1690"]);
  });

  test("context is excluded; bare numbers and item-NNN never match", () => {
    assert.deepEqual(
      harvestOrchIssueRefs({
        reference: "betting-prod-api-status-500-db-migration-drift item-322",
        reason: "no refs here either",
      }),
      [],
      "status-500 / item-322 / bare numbers are not orch issue refs",
    );
    // `context` is not part of the harvest surface at all.
    assert.deepEqual(
      harvestOrchIssueRefs({ reference: "slug-anchor", reason: "r" } as any),
      [],
    );
  });

  test("non-string fields degrade to no refs", () => {
    assert.deepEqual(harvestOrchIssueRefs({ reference: 42 as any, reason: null as any }), []);
  });
});

describe("reconcileWorkQueue — resolved-state reaper (#1690)", () => {
  const closedRaw = JSON.stringify({
    reference: "betting-prod-api-status-500-db-migration-drift (#1683)",
    queuedAt: isoAgo(0),
  });
  const openRaw = JSON.stringify({ reference: "live anchor (#1700)", queuedAt: isoAgo(0) });
  const mergedRaw = JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) });
  const noRefRaw = JSON.stringify({ reference: "slug-with-no-refs", queuedAt: isoAgo(0) });

  function makeReconcileDeps(over: any = {}) {
    const removed: string[] = [];
    const deps = {
      getWorkQueueItems: async () => [closedRaw, openRaw, mergedRaw, noRefRaw],
      removeWorkQueueItem: async (raw: string) => { removed.push(raw); return 1; },
      loadMergedAnchorRefs: async () => new Set<string>(["item-322"]),
      getIssueState: async (n: string) => (n === "1683" ? "closed" as const : "open" as const),
      ...over,
    };
    return { deps, removed };
  }

  test("removes closed-issue and merged entries; keeps open and ref-less entries", async () => {
    const { deps, removed } = makeReconcileDeps();
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.scanned, 4);
    assert.equal(result.removed, 2);
    assert.deepEqual(removed.sort(), [closedRaw, mergedRaw].sort());
    assert.deepEqual(
      result.details.map((d) => d.cause).sort(),
      ["closed-issue", "merged-work"],
    );
  });

  test("an undeterminable issue state keeps the entry (fail open)", async () => {
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => [closedRaw],
      getIssueState: async () => null,
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 0);
    assert.deepEqual(removed, []);
  });

  test("an entry referencing one closed and one open issue is kept", async () => {
    const mixedRaw = JSON.stringify({ reference: "epic slice (#1683, #1700)", queuedAt: isoAgo(0) });
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => [mixedRaw],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 0);
    assert.deepEqual(removed, []);
  });

  test("duplicate raws are reaped once and counted by LREM total", async () => {
    let lremCalls = 0;
    const { deps } = makeReconcileDeps({
      getWorkQueueItems: async () => [closedRaw, closedRaw],
      removeWorkQueueItem: async () => { lremCalls++; return lremCalls === 1 ? 2 : 0; },
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 2, "LREM count 0 removed both duplicates in one call");
    assert.equal(result.details.length, 1, "second encounter LREMs 0 and is not re-reported");
  });

  test("issue-state lookups are cached per run (one gh call per distinct issue)", async () => {
    const lookups: string[] = [];
    const a = JSON.stringify({ reference: "slice A (#1683)", queuedAt: isoAgo(0) });
    const b = JSON.stringify({ reference: "slice B (#1683)", queuedAt: isoAgo(0) });
    const { deps } = makeReconcileDeps({
      getWorkQueueItems: async () => [a, b],
      getIssueState: async (n: string) => { lookups.push(n); return "closed" as const; },
    });
    const result = await reconcileWorkQueue(deps);
    assert.deepEqual(lookups, ["1683"], "second entry reuses the cached state");
    assert.equal(result.removed, 2);
  });

  test("a failing queue read degrades to a no-op result (never throws)", async () => {
    const { deps } = makeReconcileDeps({
      getWorkQueueItems: async () => { throw new Error("redis down"); },
    });
    await assert.doesNotReject(async () => {
      const result = await reconcileWorkQueue(deps);
      assert.deepEqual(result, { scanned: 0, removed: 0, details: [] });
    });
  });

  test("a failing merged-refs reader still allows the closed-issue path", async () => {
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => [closedRaw],
      loadMergedAnchorRefs: async () => { throw new Error("gh unreachable"); },
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, [closedRaw]);
  });

  test("corrupt JSON entries are kept (cleanWorkQueue's concern)", async () => {
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => ["not-json{{{", closedRaw],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.scanned, 2);
    assert.deepEqual(removed, [closedRaw]);
  });
});
