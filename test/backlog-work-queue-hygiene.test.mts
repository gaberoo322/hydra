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
import { type MergedRef } from "../src/backlog/target-pr-feed.ts";

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
      // No merged blobs by default → the shipped-subject gate (#2482) is a no-op
      // for the merged-work / closed-issue cases; subject-coverage is exercised
      // by its own top-level describe below.
      fetchMergedRefs: async (): Promise<MergedRef[]> => [],
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

// ---------------------------------------------------------------------------
// Terminal-marker reap (issue #2187): the COMPLETED:/CLOSED: GC moved here from
// the Candidate Feed so the feed stays a pure read path. The feed still
// SUPPRESSES terminal markers on every poll; this reconciler removes the stale
// Redis entry on its hourly tick (cause "terminal-marker").
// ---------------------------------------------------------------------------

describe("reconcileWorkQueue — terminal-marker reap (#2187)", () => {
  const completedRaw = JSON.stringify({ reference: "COMPLETED: issue-1700 shipped", queuedAt: isoAgo(0) });
  const closedMarkerRaw = JSON.stringify({ reference: "closed: item-99 done", queuedAt: isoAgo(0) });
  const liveRaw = JSON.stringify({ reference: "live anchor (#1700)", queuedAt: isoAgo(0) });

  function makeDeps(over: any = {}) {
    const removed: string[] = [];
    const deps = {
      getWorkQueueItems: async () => [completedRaw, liveRaw],
      removeWorkQueueItem: async (raw: string) => { removed.push(raw); return 1; },
      loadMergedAnchorRefs: async () => new Set<string>(),
      // Live (#1700) is open → kept; no terminal-marker entry needs a gh call.
      getIssueState: async () => "open" as const,
      fetchMergedRefs: async (): Promise<MergedRef[]> => [],
      ...over,
    };
    return { deps, removed };
  }

  test("a COMPLETED:-prefixed entry is reaped with cause terminal-marker", async () => {
    const { deps, removed } = makeDeps();
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, [completedRaw]);
    assert.deepEqual(result.details.map((d) => d.cause), ["terminal-marker"]);
  });

  test("a CLOSED:-prefixed entry is reaped too (case-insensitive)", async () => {
    const { deps, removed } = makeDeps({
      getWorkQueueItems: async () => [closedMarkerRaw],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, [closedMarkerRaw]);
    assert.deepEqual(result.details.map((d) => d.cause), ["terminal-marker"]);
  });

  test("terminal-marker check needs no gh lookup (checked before issue-state)", async () => {
    let ghCalls = 0;
    const { deps } = makeDeps({
      getWorkQueueItems: async () => [completedRaw],
      getIssueState: async () => { ghCalls++; return "open" as const; },
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 1);
    assert.equal(ghCalls, 0, "a terminal marker is reaped without an issue-state lookup");
  });
});

// ---------------------------------------------------------------------------
// Shipped-subject reap (issue #2482): an entry whose TITLE is covered by a
// recently-merged PR/commit subject is shipped-under-a-renamed-title work the
// #882 token scan misses. Reuses the #2110 asymmetric-containment matcher
// (`subjectCoveredBy`) against the merged-blob feed. CRITICAL polarity: removal
// requires a POSITIVE coverage hit against a CONCRETE merged blob — absence of
// a token is NEVER evidence of shipped (the #2031 / #2110 92%-FP class). These
// deps are pure injectables (no Redis seam), so this needs no special suite
// lifecycle.
// ---------------------------------------------------------------------------

describe("reconcileWorkQueue — shipped-subject reap (#2482)", () => {
  // A live entry whose title is fully covered by a merged PR subject below.
  const shippedRaw = JSON.stringify({
    reference: "reconcile work-queue head against shipped anchors",
    queuedAt: isoAgo(0),
  });
  // A live entry whose title shares too few words with any merged blob.
  const unrelatedRaw = JSON.stringify({
    reference: "forecast directional execution graduated capital lever",
    queuedAt: isoAgo(0),
  });

  // Merged PR blob carrying all of shippedRaw's significant words (renamed
  // title — no #NNN / item-NNN token, so the #882 scan would miss it).
  const mergedBlob: MergedRef = {
    ref: "pr-2483",
    blob: "feat(hygiene): reconcile the work queue head and drop already-shipped anchors that resurfaced",
  };

  function makeDeps(over: any = {}) {
    const removed: string[] = [];
    const deps = {
      getWorkQueueItems: async () => [shippedRaw, unrelatedRaw],
      removeWorkQueueItem: async (raw: string) => { removed.push(raw); return 1; },
      loadMergedAnchorRefs: async () => new Set<string>(),
      // No orch issue refs in either title → no gh lookup needed.
      getIssueState: async () => "open" as const,
      fetchMergedRefs: async (): Promise<MergedRef[]> => [mergedBlob],
      ...over,
    };
    return { deps, removed };
  }

  test("removes an entry whose title is subject-covered by a merged blob; keeps the unrelated one", async () => {
    const { deps, removed } = makeDeps();
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.scanned, 2);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, [shippedRaw]);
    assert.deepEqual(result.details.map((d) => d.cause), ["shipped-subject"]);
  });

  test("an empty merged-blob feed yields ZERO subject removals (positive-evidence only)", async () => {
    const { deps, removed } = makeDeps({
      fetchMergedRefs: async (): Promise<MergedRef[]> => [],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 0);
    assert.deepEqual(removed, []);
  });

  test("a failing merged-blob feed degrades to no subject removals (never throws)", async () => {
    const { deps, removed } = makeDeps({
      fetchMergedRefs: async (): Promise<MergedRef[]> => { throw new Error("gh down"); },
    });
    await assert.doesNotReject(async () => {
      const result = await reconcileWorkQueue(deps);
      assert.equal(result.removed, 0);
      assert.deepEqual(removed, []);
    });
  });

  test("a short/generic title (<4 significant words) never subject-matches", async () => {
    const shortRaw = JSON.stringify({ reference: "fix tests", queuedAt: isoAgo(0) });
    const { deps, removed } = makeDeps({
      getWorkQueueItems: async () => [shortRaw],
      // A blob that literally contains "fix" and "tests" — but the 4-word guard
      // means a 2-word title can never reach the 0.70 threshold.
      fetchMergedRefs: async (): Promise<MergedRef[]> => [
        { ref: "pr-1", blob: "fix flaky tests across the suite to keep things green" },
      ],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 0, "short titles cannot spuriously reconcile live work");
    assert.deepEqual(removed, []);
  });

  test("an earlier cause (terminal-marker) wins — subject gate only fires when no other cause did", async () => {
    // A terminal marker whose words also appear in the merged blob: the cause
    // must report terminal-marker, not shipped-subject (checked-first ordering).
    const completedRaw = JSON.stringify({
      reference: "COMPLETED: reconcile work-queue head against shipped anchors",
      queuedAt: isoAgo(0),
    });
    const { deps, removed } = makeDeps({
      getWorkQueueItems: async () => [completedRaw],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, [completedRaw]);
    assert.deepEqual(result.details.map((d) => d.cause), ["terminal-marker"]);
  });

  test("the merged-blob feed is fetched ONCE per run, not per entry", async () => {
    let feedCalls = 0;
    const { deps } = makeDeps({
      getWorkQueueItems: async () => [shippedRaw, unrelatedRaw, shippedRaw],
      fetchMergedRefs: async (): Promise<MergedRef[]> => { feedCalls++; return [mergedBlob]; },
    });
    await reconcileWorkQueue(deps);
    assert.equal(feedCalls, 1, "subject matching is pure in-memory after a single fetch");
  });
});
