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
import type { ReconcilerHealthRecord } from "../src/redis/reconciler.ts";

// ---------------------------------------------------------------------------
// In-memory fixture — a metrics store + a scripted PR-state map + a spy on the
// completed→merged re-post.
// ---------------------------------------------------------------------------

interface Fixture {
  metrics: Map<string, Record<string, string>>;
  prState: Map<number, string | null>;
  /** Records of every recordCycle re-post the chore fired. */
  reposts: Array<{
    cycleId: string;
    status: string;
    tasksMerged: number;
    prNumber: number;
    anchorType?: string;
  }>;
  // --- Self-arm backstop fixture state (issue #3078) --------------------------
  // Optional so the pre-existing #2860 case literals ({ metrics, prState, reposts })
  // keep compiling; makeDeps defaults each to an empty container.
  /** prNumbers already in the pending-enroll registry at tick start. */
  pending?: Set<number>;
  /** prNumbers already enroll-processed (the per-PR enrolled marker). */
  enrolled?: Set<number>;
  /** Every pendingEnrollAdd the self-arm branch fired. */
  arms?: Array<{ prNumber: number; cycleId: string; tier: number | null; anchorType?: string }>;
  // --- Health-record persistence spy (issue #3509) ---------------------------
  /** Every ReconcilerHealthRecord the chore persisted via setHealth. */
  healthWrites?: ReconcilerHealthRecord[];
}

function makeDeps(fx: Fixture, over: Partial<CycleMergeReconcileDeps> = {}): CycleMergeReconcileDeps {
  const pending = (fx.pending ??= new Set());
  const enrolled = (fx.enrolled ??= new Set());
  const arms = (fx.arms ??= []);
  const healthWrites = (fx.healthWrites ??= []);
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
    // Self-arm touchpoints (issue #3078): back them with the fixture Sets so the
    // decision logic runs with NO live Redis. A fresh copy of `pending` each call
    // mirrors the once-per-tick snapshot the real chore takes.
    listPending: async () => new Set(pending),
    wasEnrolled: async (prNumber) => enrolled.has(prNumber),
    armPending: async (entry) => {
      arms.push({
        prNumber: entry.prNumber,
        cycleId: entry.cycleId,
        tier: entry.tier,
        anchorType: entry.anchorType,
      });
      pending.add(entry.prNumber);
      return { ok: true };
    },
    // Health-record persistence spy (issue #3509): capture every record the chore
    // writes so a test can assert ranAt + the counter mapping, with NO live Redis.
    setHealth: async (record) => {
      healthWrites.push(record);
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
    // No anchorType on the metrics hash ⇒ forwarded as undefined so recordCycle
    // re-infers from the cycleId (issue #3122).
    assert.deepEqual(fx.reposts[0], {
      cycleId: "c1",
      status: "merged",
      tasksMerged: 1,
      prNumber: 100,
      anchorType: undefined,
    });
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

  // Issue #3122: the merged-status re-post must PRESERVE the original cycle's
  // anchorType (read back from the metrics hash), not drop it. Dropping it made
  // classifyAnchorType re-infer from a bare-UUID cycleId, fail, and default to
  // `unclassified` on ~12% of records.
  test("forwards the metrics-hash anchorType through the merged-status re-post (#3122)", async () => {
    const fx: Fixture = {
      metrics: new Map([
        ["c-typed", { status: "completed", prNumber: "300", tasksMerged: "0", anchorType: "grill" }],
      ]),
      prState: new Map([[300, "MERGED"]]),
      reposts: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.upgraded, 1);
    assert.equal(fx.reposts.length, 1);
    assert.equal(
      fx.reposts[0].anchorType,
      "grill",
      "the reap-time anchorType is preserved on re-post, not dropped to unclassified",
    );
  });

  test("trims a whitespace-padded anchorType and drops an empty one to undefined (#3122)", async () => {
    const fx: Fixture = {
      metrics: new Map([
        ["c-pad", { status: "completed", prNumber: "301", tasksMerged: "0", anchorType: "  work-queue  " }],
        ["c-empty", { status: "completed", prNumber: "302", tasksMerged: "0", anchorType: "   " }],
      ]),
      prState: new Map([[301, "MERGED"], [302, "MERGED"]]),
      reposts: [],
    };
    await runCycleMergeReconcile(makeDeps(fx));
    const padded = fx.reposts.find((b) => b.cycleId === "c-pad");
    const empty = fx.reposts.find((b) => b.cycleId === "c-empty");
    assert.equal(padded?.anchorType, "work-queue", "padded anchorType is trimmed");
    assert.equal(empty?.anchorType, undefined, "whitespace-only anchorType ⇒ undefined (re-infer)");
  });
});

// ---------------------------------------------------------------------------
// Self-arm backstop (#3078): a confirmed-merged PR absent from the pending-enroll
// registry AND not yet enrolled-marked is armed via pendingEnrollAdd, so the
// merge-watch chore enrolls it next tick — recovering a dropped `POST
// /api/holdback/pending` arm with no new event surface. Idempotent (skips a PR
// already registered or already enrolled), never-throws, never tier-filters.
// New top-level suite (own lifecycle, pure per-case fixtures) per the CLAUDE.md
// shared-Redis-teardown authoring rule.
// ---------------------------------------------------------------------------
describe("cycle-merge-reconcile — pending-enroll self-arm backstop (#3078)", () => {
  test("arms a merged, unregistered, un-enrolled PR into the pending-enroll registry", async () => {
    const fx: Fixture = {
      metrics: new Map([["c1", { status: "completed", prNumber: "100", tasksMerged: "0" }]]),
      prState: new Map([[100, "MERGED"]]),
      reposts: [],
      pending: new Set(),
      enrolled: new Set(),
      arms: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.selfArmed, 1, "the dropped-arm PR is self-armed");
    assert.equal(r.selfArmSkipped, 0);
    assert.equal(r.selfArmFailed, 0);
    assert.equal(fx.arms!.length, 1);
    assert.deepEqual(fx.arms![0], {
      prNumber: 100,
      cycleId: "c1",
      tier: null, // tier unknown from the metrics hash; enrollHoldback resolves it server-side
      anchorType: "work-queue",
    });
    // The metrics upgrade still fires alongside the arm (both are merge-coupled).
    assert.equal(r.upgraded, 1);
  });

  test("does NOT arm a PR already present in the pending-enroll registry (idempotent)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c2", { status: "completed", prNumber: "200", tasksMerged: "0" }]]),
      prState: new Map([[200, "MERGED"]]),
      reposts: [],
      pending: new Set([200]),
      enrolled: new Set(),
      arms: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.selfArmed, 0, "already in the registry ⇒ no re-arm");
    assert.equal(r.selfArmSkipped, 1);
    assert.equal(fx.arms!.length, 0);
    assert.equal(r.upgraded, 1, "the metrics upgrade still runs");
  });

  test("does NOT arm a PR already enrolled-marked (idempotent against re-observation)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c3", { status: "completed", prNumber: "300", tasksMerged: "0" }]]),
      prState: new Map([[300, "MERGED"]]),
      reposts: [],
      pending: new Set(),
      enrolled: new Set([300]),
      arms: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.selfArmed, 0, "already enrolled ⇒ no re-arm");
    assert.equal(r.selfArmSkipped, 1);
    assert.equal(fx.arms!.length, 0);
  });

  test("does NOT arm a still-OPEN PR (self-arm only on confirmed merge)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-open", { status: "completed", prNumber: "400", tasksMerged: "0" }]]),
      prState: new Map([[400, "OPEN"]]),
      reposts: [],
      pending: new Set(),
      enrolled: new Set(),
      arms: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.notMerged, 1);
    assert.equal(r.selfArmed, 0, "an un-merged PR is never armed");
    assert.equal(fx.arms!.length, 0);
  });

  test("a pendingEnrollAdd failure is counted and never aborts the metrics upgrade", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-armfail", { status: "completed", prNumber: "500", tasksMerged: "0" }]]),
      prState: new Map([[500, "MERGED"]]),
      reposts: [],
      pending: new Set(),
      enrolled: new Set(),
      arms: [],
    };
    const r = await runCycleMergeReconcile(
      makeDeps(fx, {
        armPending: async () => ({ ok: false, error: "redis down" }),
      }),
    );
    assert.equal(r.selfArmFailed, 1);
    assert.equal(r.selfArmed, 0);
    // The completed→merged upgrade still fires — arming is decoupled from it.
    assert.equal(r.upgraded, 1);
    assert.equal(fx.reposts.length, 1);
  });

  test("a pending-enroll LIST failure disables self-arm for the tick (never arms blind)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c-listfail", { status: "completed", prNumber: "600", tasksMerged: "0" }]]),
      prState: new Map([[600, "MERGED"]]),
      reposts: [],
      pending: new Set(),
      enrolled: new Set(),
      arms: [],
    };
    const r = await runCycleMergeReconcile(
      makeDeps(fx, {
        listPending: async () => {
          throw new Error("registry read failed");
        },
      }),
    );
    assert.equal(r.selfArmed, 0, "no blind arming when the registry read failed");
    assert.equal(r.selfArmSkipped, 0);
    assert.equal(r.selfArmFailed, 0);
    assert.equal(fx.arms!.length, 0);
    // The metrics upgrade path is unaffected by a self-arm-only failure.
    assert.equal(r.upgraded, 1);
  });

  test("arms each of several distinct merged unregistered PRs exactly once", async () => {
    const metrics = new Map<string, Record<string, string>>();
    const prState = new Map<number, string | null>();
    for (let i = 0; i < 3; i++) {
      metrics.set(`c-${i}`, { status: "completed", prNumber: String(700 + i), tasksMerged: "0" });
      prState.set(700 + i, "MERGED");
    }
    const fx: Fixture = { metrics, prState, reposts: [], pending: new Set(), enrolled: new Set(), arms: [] };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.selfArmed, 3);
    assert.deepEqual(
      fx.arms!.map((a) => a.prNumber).sort((a, b) => a - b),
      [700, 701, 702],
    );
  });
});

// ---------------------------------------------------------------------------
// Health-record persistence (#3509): after every run the chore must persist a
// ReconcilerHealthRecord via setReconcilerHealth so `GET /api/scheduler/status`
// reports a fresh `reconciler.ranAt` instead of a stale (32h+) timestamp. The
// record's counters map the run result onto the (pre-existing) health shape.
// New top-level suite (own lifecycle, pure per-case fixtures) per the CLAUDE.md
// shared-Redis-teardown authoring rule.
// ---------------------------------------------------------------------------
describe("cycle-merge-reconcile — health-record persistence (#3509)", () => {
  test("persists a health record with a fresh ranAt after a run that upgraded a cycle", async () => {
    const before = Date.now();
    const fx: Fixture = {
      metrics: new Map([["c1", { status: "completed", prNumber: "100", tasksMerged: "0" }]]),
      prState: new Map([[100, "MERGED"]]),
      reposts: [],
      healthWrites: [],
    };
    await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(fx.healthWrites!.length, 1, "exactly one health record persisted per run");
    const rec = fx.healthWrites![0];
    // ranAt is a fresh ISO timestamp at/after the run started.
    const ranAtMs = Date.parse(rec.ranAt);
    assert.ok(!Number.isNaN(ranAtMs), "ranAt is a parseable ISO timestamp");
    assert.ok(ranAtMs >= before && ranAtMs <= Date.now(), "ranAt is within the run window");
    // Counters map the run result onto the health shape.
    assert.equal(rec.metrics.scanned, 1);
    assert.equal(rec.metrics.referencesFound, 1);
    assert.equal(rec.metrics.itemsReconciled, 1, "one upgraded → itemsReconciled=1");
    assert.equal(rec.feed.prs.examined, 1);
    assert.equal(rec.feed.commits.examined, 0, "no commit feed on this reconciler");
    assert.ok(rec.metrics.durationMs >= 0, "durationMs is non-negative");
  });

  test("persists a health record even on an empty (no-op) window — so ranAt never goes stale", async () => {
    const fx: Fixture = { metrics: new Map(), prState: new Map(), reposts: [], healthWrites: [] };
    await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(fx.healthWrites!.length, 1, "a no-op run still stamps ranAt");
    const rec = fx.healthWrites![0];
    assert.ok(!Number.isNaN(Date.parse(rec.ranAt)));
    assert.equal(rec.metrics.scanned, 0);
    assert.equal(rec.metrics.itemsReconciled, 0);
  });

  test("maps self-arm and retryable-failure counters onto the health record", async () => {
    const fx: Fixture = {
      metrics: new Map([
        ["c-armed", { status: "completed", prNumber: "800", tasksMerged: "0" }],
        ["c-fetchfail", { status: "completed", prNumber: "801", tasksMerged: "0" }],
      ]),
      prState: new Map([[800, "MERGED"], [801, null]]), // 801 fetch fails
      reposts: [],
      pending: new Set(),
      enrolled: new Set(),
      arms: [],
      healthWrites: [],
    };
    const r = await runCycleMergeReconcile(makeDeps(fx));
    assert.equal(r.selfArmed, 1);
    assert.equal(r.fetchFailed, 1);
    const rec = fx.healthWrites![0];
    assert.equal(rec.metrics.itemsEscalated, 1, "selfArmed → itemsEscalated");
    // movesFailed aggregates the retryable failures (fetch + upgrade + self-arm).
    assert.equal(rec.metrics.movesFailed, 1, "the fetch failure counts as a retryable move failure");
  });

  test("a setHealth write failure is swallowed and never aborts the run (best-effort)", async () => {
    const fx: Fixture = {
      metrics: new Map([["c1", { status: "completed", prNumber: "100", tasksMerged: "0" }]]),
      prState: new Map([[100, "MERGED"]]),
      reposts: [],
      healthWrites: [],
    };
    // The chore must still return its work summary even when the health write throws.
    const r = await runCycleMergeReconcile(
      makeDeps(fx, {
        setHealth: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.equal(r.upgraded, 1, "the run's work completed despite the health-write failure");
    assert.equal(fx.reposts.length, 1);
  });
});
