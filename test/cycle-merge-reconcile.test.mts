/**
 * Cycle-record merged-status reconciliation backstop chore (issue #2860).
 *
 * The SECOND layer of the merged-status enrichment path: a periodic sweep that
 * scans recent `status=completed` cycle records carrying a prNumber, confirms
 * the PR merged via `gh pr view`, and re-posts through recordCycle to perform the
 * `completed→merged` upgrade. Self-heals cycles the primary holdback-merge-watch
 * path missed (PRs never armed into the pending-enroll registry).
 *
 * These tests inject all touchpoints (recent-id list, metrics getter, gh state
 * fetch, recordCycle) so the decision logic runs with NO live Redis / gh. Pure
 * per-case fixtures — no shared connection, so this is a self-contained top-level
 * suite (per the shared-Redis-teardown authoring rule in CLAUDE.md).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runCycleMergeReconcile,
  type CycleMergeReconcileDeps,
} from "../src/scheduler/chores/cycle-merge-reconcile.ts";

// ---------------------------------------------------------------------------
// In-memory fixture — a metrics store + a scripted PR-state map + a spy on the
// completed→merged re-post.
// ---------------------------------------------------------------------------

interface Fixture {
  metrics: Map<string, Record<string, string>>;
  prState: Map<number, string | null>;
  /** Records of every recordCycle re-post the chore fired. */
  reposts: Array<{ cycleId: string; status: string; tasksMerged: number; prNumber: number }>;
}

function makeDeps(fx: Fixture, over: Partial<CycleMergeReconcileDeps> = {}): CycleMergeReconcileDeps {
  return {
    listRecent: async (count) => Array.from(fx.metrics.keys()).slice(0, count),
    getMetrics: async (cycleId) => ({ ...(fx.metrics.get(cycleId) ?? {}) }),
    fetchPrState: async (prNumber) =>
      fx.prState.has(prNumber) ? fx.prState.get(prNumber)! : null,
    recordCycleRecord: async (body) => {
      fx.reposts.push({ ...body });
      // Simulate the recordCycle upgrade: flip the stored metric so a re-scan
      // no longer treats it as a candidate (idempotency at the fixture level).
      const m = fx.metrics.get(body.cycleId);
      if (m) {
        m.status = "merged";
        m.tasksMerged = String(body.tasksMerged);
      }
      return { ok: true, cycleId: body.cycleId, status: "merged", bucketed: null, deduped: true, enriched: true } as any;
    },
    ...over,
  };
}

describe("cycle-merge-reconcile — completed→merged backstop (#2860)", () => {
  test("upgrades a completed cycle whose PR merged", async () => {
    const fx: Fixture = {
      metrics: new Map([["c1", { status: "completed", prNumber: "100", tasksMerged: "0" }]]),
      prState: new Map([[100, "MERGED"]]),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.candidates, 1);
    assert.equal(r.upgraded, 1);
    assert.equal(r.notMerged, 0);
    assert.equal(fx.reposts.length, 1);
    assert.deepEqual(fx.reposts[0], { cycleId: "c1", status: "merged", tasksMerged: 1, prNumber: 100 });
  });

  test("leaves a completed cycle whose PR is still OPEN (not a merged miss)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-open", { status: "completed", prNumber: "5", tasksMerged: "0" }]]),
      prState: new Map([[5, "OPEN"]]),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.candidates, 1);
    assert.equal(r.upgraded, 0);
    assert.equal(r.notMerged, 1);
    assert.equal(fx.reposts.length, 0);
  });

  test("leaves a completed cycle whose PR was CLOSED unmerged", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-closed", { status: "completed", prNumber: "6", tasksMerged: "0" }]]),
      prState: new Map([[6, "CLOSED"]]),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.notMerged, 1);
    assert.equal(r.upgraded, 0);
  });

  test("skips a record with no prNumber (nothing to confirm against)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-nopr", { status: "completed", tasksMerged: "0" }]]),
      prState: new Map(),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.scanned, 1);
    assert.equal(r.candidates, 0, "no PR ⇒ not a candidate");
    assert.equal(r.upgraded, 0);
  });

  test("skips a record that is not status=completed (merged/failed are terminal)", async () => {
    const fx: Fixture = {
      metrics: new Map([
        ["c-already-merged", { status: "merged", prNumber: "7", tasksMerged: "1" }],
        ["c-failed", { status: "failed", prNumber: "8", tasksMerged: "0" }],
      ]),
      prState: new Map([[7, "MERGED"], [8, "MERGED"]]),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.candidates, 0, "neither completed ⇒ no candidates");
    assert.equal(r.upgraded, 0);
    assert.equal(fx.reposts.length, 0);
  });

  test("skips a completed record that already shows tasksMerged>0 (defensive)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-dup", { status: "completed", prNumber: "9", tasksMerged: "1" }]]),
      prState: new Map([[9, "MERGED"]]),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.candidates, 0);
    assert.equal(fx.reposts.length, 0);
  });

  test("a gh state-fetch failure leaves the record for the next tick (never throws)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-fetchfail", { status: "completed", prNumber: "11", tasksMerged: "0" }]]),
      prState: new Map([[11, null]]), // null ⇒ fetch failure
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.candidates, 1);
    assert.equal(r.fetchFailed, 1);
    assert.equal(r.upgraded, 0);
    assert.equal(fx.reposts.length, 0);
  });

  test("an upgrade re-post that returns non-ok is counted and does not throw", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-upfail", { status: "completed", prNumber: "12", tasksMerged: "0" }]]),
      prState: new Map([[12, "MERGED"]]),
      reposts: [],
    };
    const deps = makeDeps(fx, {
      recordCycleRecord: async () =>
        ({ ok: false, code: "redis", detail: "boom" }) as any,
    });
    const r = await runCycleMergeReconcile(deps);
    assert.equal(r.candidates, 1);
    assert.equal(r.upgradeFailed, 1);
    assert.equal(r.upgraded, 0);
  });

  test("bounds the gh confirmations per tick to confirmLimit", async () => {
    const metrics = new Map<string, Record<string, string>>();
    const prState = new Map<number, string | null>();
    for (let i = 0; i < 10; i++) {
      metrics.set(`c-${i}`, { status: "completed", prNumber: String(200 + i), tasksMerged: "0" });
      prState.set(200 + i, "MERGED");
    }
    const fx: Fixture = { metrics, prState, reposts: [] };
    const r = await runCycleMergeReconcile(makeDeps(fx, { confirmLimit: 3 }));
    // Confirmations (upgraded+notMerged+fetchFailed) are capped at confirmLimit.
    assert.equal(r.upgraded, 3, "stopped confirming after the per-tick budget");
    assert.ok(r.upgraded + r.notMerged + r.fetchFailed <= 3);
  });

  test("an empty / all-merged window is a silent no-op", async () => {
    const fx: Fixture = { metrics: new Map(), prState: new Map(), reposts: [] };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.scanned, 0);
    assert.equal(r.candidates, 0);
    assert.equal(r.upgraded, 0);
  });

  test("a listRecent failure returns an empty summary and never throws", async () => {
    const fx: Fixture = { metrics: new Map(), prState: new Map(), reposts: [] };
    const r = await runCycleMergeReconcile(
      makeDeps(fx, {
        listRecent: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.equal(r.scanned, 0);
    assert.equal(r.upgraded, 0);
  });
});
