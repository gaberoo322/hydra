/**
 * Regression tests for the merge-event holdback enrolment chore (issue #4632,
 * ADR-0034 §8.1) — the closing mechanism for T2+ merges that bypass the whole
 * arm (`POST /holdback/pending`) → `holdback-merge-watch` flow entirely: an
 * operator `gh pr merge`, or a hand-shepherded PR built outside the autopilot
 * loop. Neither `holdback-merge-watch.ts` (drains the pending-enroll
 * registry) nor `cycle-merge-reconcile.ts` (scans cycle records) can see such
 * a PR — there is no registry entry and no cycle record for it at all.
 *
 * Two layers, per the CLAUDE.md authoring convention:
 *   1. Pure decision logic (no Redis): every skip/record/retry branch, driven
 *      through fully-injected deps.
 *   2. The Redis seam + an end-to-end pass against a live Redis (DB 1, skipped
 *      if unreachable) — its own top-level `describe` with its own
 *      `before`/`after`, per the "never nest under a sibling's shared-Redis
 *      teardown" rule.
 */

// Point the Redis singleton at DB 1 before any seam import (matches
// test/holdback.test.mts and the backlog.test convention).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  runHoldbackMergeEventEnrol,
  type HoldbackMergeEventEnrolDeps,
  type MergeEventCandidate,
} from "../src/scheduler/chores/holdback-merge-event-enrol.ts";
import type { EnrollResult } from "../src/holdback.ts";
import type { ClassifyResult } from "../src/tier-classifier.ts";
import type { PendingEnrollEntry } from "../src/redis/holdback-merge-watch.ts";
import {
  recordMergeEventEnrolResult,
  getMergeEventEnrolRecord,
  listMergeEventEnrolRecords,
  _resetMergeEventEnrolRecords,
  _resetEnrolledMarker,
  _resetPendingEnroll,
  wasEnrolledMarked,
  pendingEnrollAdd,
  type MergeEventEnrolRecord,
} from "../src/redis/holdback-merge-watch.ts";

// ---------------------------------------------------------------------------
// Layer 1 — pure decision logic (no Redis)
// ---------------------------------------------------------------------------

/** Build a fully-injected harness so each case only overrides what it needs. */
function makeHarness(overrides: Partial<HoldbackMergeEventEnrolDeps> = {}) {
  const recordCalls: MergeEventEnrolRecord[] = [];
  const markCalls: Array<{ prNumber: number; commitSha: string }> = [];
  const enrollCalls: any[] = [];

  const records = new Map<number, MergeEventEnrolRecord>();

  const deps: HoldbackMergeEventEnrolDeps = {
    listMergedCandidates: async () => [],
    fetchChangedFiles: async () => [],
    listPending: async () => ({ ok: true, entries: [] }),
    wasEnrolled: async () => false,
    mark: async (prNumber: number, commitSha: string) => {
      markCalls.push({ prNumber, commitSha });
      return { ok: true as const };
    },
    getRecord: async (prNumber: number) => records.get(prNumber) ?? null,
    recordResult: async (record: MergeEventEnrolRecord) => {
      recordCalls.push(record);
      records.set(record.prNumber, record);
      return { ok: true as const };
    },
    enroll: async (input: any) => {
      enrollCalls.push(input);
      return { ok: true, enrolled: true, leadingCount: 1, baseline: {} as any } satisfies EnrollResult;
    },
    classify: (files: string[]): ClassifyResult => ({ tier: 3, reason: "test default", perFile: [] }),
    ...overrides,
  };

  return { deps, recordCalls, markCalls, enrollCalls, records };
}

describe("holdback-merge-event-enrol — decision logic (no Redis)", () => {
  test("AC: an operator-merged T2 PR is enrolled without a registry entry", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9001, mergeCommitSha: "sha9001" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["dashboard/src/App.tsx"],
      classify: () => ({ tier: 2, reason: "dashboard change", perFile: [] }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.enrolled, 1);
    assert.equal(res.failed, 0);
    assert.deepEqual(h.enrollCalls, [{ commitSha: "sha9001", prNumber: 9001, tier: 2 }]);
    assert.deepEqual(h.markCalls, [{ prNumber: 9001, commitSha: "sha9001" }]);
    assert.equal(h.recordCalls.length, 1);
    assert.equal(h.recordCalls[0].status, "enrolled");
    assert.equal(h.recordCalls[0].prNumber, 9001);
    assert.equal(h.recordCalls[0].tier, 2);
  });

  test("skips a candidate already in the pending-enroll registry — the normal watcher owns it", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9002, mergeCommitSha: "sha9002" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      listPending: async () => ({
        ok: true,
        entries: [{ prNumber: 9002, tier: 2, cycleId: "cyc", registeredAt: 1 } as PendingEnrollEntry],
      }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.skippedRegistered, 1);
    assert.equal(h.enrollCalls.length, 0);
    assert.equal(h.recordCalls.length, 0);
  });

  test("skips a candidate the shared marker already shows processed", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9003, mergeCommitSha: "sha9003" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      wasEnrolled: async () => true,
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.skippedRegistered, 1);
    assert.equal(h.enrollCalls.length, 0);
  });

  test("skips a candidate that already has a recorded outcome — a prior FAILURE is never auto-retried", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9004, mergeCommitSha: "sha9004" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      getRecord: async () => ({
        prNumber: 9004,
        commitSha: "sha9004",
        tier: 3,
        status: "failed",
        error: "boom",
        recordedAt: 1,
      }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.skippedAlreadyRecorded, 1);
    assert.equal(h.enrollCalls.length, 0, "no automatic re-attempt of a recorded failure");
  });

  test("classifies the tier from the PR's OWN changed files, never a self-asserted body line — a T1 merge records nothing", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9005, mergeCommitSha: "sha9005" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["config/agents/foo.md"],
      classify: () => ({ tier: 1, reason: "prompt-shaped", perFile: [] }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.skippedNotEligibleTier, 1);
    assert.equal(h.enrollCalls.length, 0);
    assert.equal(h.recordCalls.length, 0, "an exempt-tier merge is uninteresting, not a recordable outcome");
  });

  test("AC: a failed enrolment is recorded (queryable via the record store)", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9006, mergeCommitSha: "sha9006" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["src/foo.ts"],
      classify: () => ({ tier: 3, reason: "operator-review change", perFile: [] }),
      enroll: async () => ({ ok: false, error: "redis unreachable" }) satisfies EnrollResult,
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.failed, 1);
    assert.equal(res.enrolled, 0);
    assert.equal(h.markCalls.length, 0, "a failed enrol never marks the PR processed — it stays eligible for retry");
    assert.equal(h.recordCalls.length, 1);
    assert.equal(h.recordCalls[0].status, "failed");
    assert.equal(h.recordCalls[0].error, "redis unreachable");
  });

  test("a changed-files fetch failure is retried next tick — nothing recorded", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9007, mergeCommitSha: "sha9007" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => null,
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.fetchFailed, 1);
    assert.equal(h.enrollCalls.length, 0);
    assert.equal(h.recordCalls.length, 0);
  });

  test("a marker-write failure after a successful enrol leaves the PR WHOLLY unrecorded (retried next tick, never misreported as failed)", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9008, mergeCommitSha: "sha9008" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["src/foo.ts"],
      classify: () => ({ tier: 3, reason: "operator-review change", perFile: [] }),
      mark: async () => ({ ok: false, error: "redis blip" }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.retried, 1);
    assert.equal(res.enrolled, 0);
    assert.equal(res.failed, 0, "a bookkeeping-only failure is never misreported as an enrol failure");
    assert.equal(h.recordCalls.length, 0, "nothing is recorded — the next tick retries the whole attempt");
  });

  test("listMergedCandidates failure returns an all-zero result — never throws", async () => {
    const h = makeHarness({ listMergedCandidates: async () => null });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.scanned, 0);
    assert.equal(res.enrolled, 0);
    assert.equal(res.failed, 0);
  });

  test("a pendingEnrollList failure disables the registry-membership skip but never blocks the pass", async () => {
    const candidate: MergeEventCandidate = { prNumber: 9009, mergeCommitSha: "sha9009" };
    const h = makeHarness({
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["src/foo.ts"],
      classify: () => ({ tier: 3, reason: "operator-review change", perFile: [] }),
      listPending: async () => ({ ok: false, error: "redis down" }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.enrolled, 1, "the shared marker check still guards correctness; the pass proceeds");
  });

  test("an unexpected throw from one candidate never aborts the remaining candidates", async () => {
    const a: MergeEventCandidate = { prNumber: 9010, mergeCommitSha: "shaA" };
    const b: MergeEventCandidate = { prNumber: 9011, mergeCommitSha: "shaB" };
    const h = makeHarness({
      listMergedCandidates: async () => [a, b],
      fetchChangedFiles: async (prNumber: number) => {
        if (prNumber === 9010) throw new Error("boom");
        return ["src/foo.ts"];
      },
      classify: () => ({ tier: 3, reason: "operator-review change", perFile: [] }),
    });

    const res = await runHoldbackMergeEventEnrol(h.deps);

    assert.equal(res.scanned, 2);
    assert.equal(res.retried, 1, "the throwing candidate is counted retried, not fatal");
    assert.equal(res.enrolled, 1, "the second candidate still processes");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Redis seam + end-to-end (own top-level describe, own lifecycle)
// ---------------------------------------------------------------------------

describe("holdback-merge-event-enrol — Redis seam + end-to-end (#4632)", () => {
  let redis: any;
  let redisUp = false;

  before(async () => {
    try {
      redis = new Redis(process.env.REDIS_URL!);
      await redis.ping();
      redisUp = true;
    } catch {
      redisUp = false;
    }
  });

  after(async () => {
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* intentional: best-effort close */
      }
    }
  });

  beforeEach(async () => {
    if (redisUp) {
      await _resetMergeEventEnrolRecords();
      await _resetEnrolledMarker();
      await _resetPendingEnroll();
    }
  });

  function guard(t: any): boolean {
    if (!redisUp) {
      t.skip("Redis unavailable at localhost:6379/1");
      return false;
    }
    return true;
  }

  test("recordMergeEventEnrolResult -> getMergeEventEnrolRecord roundtrips per PR", async (t) => {
    if (!guard(t)) return;
    assert.equal(await getMergeEventEnrolRecord(8001), null, "no record before the first write");
    const w = await recordMergeEventEnrolResult({
      prNumber: 8001,
      commitSha: "sha8001",
      tier: 2,
      status: "enrolled",
      recordedAt: 1000,
    });
    assert.equal(w.ok, true);
    const got = await getMergeEventEnrolRecord(8001);
    assert.equal(got?.status, "enrolled");
    assert.equal(got?.commitSha, "sha8001");
  });

  // AC: "a failed enrolment is recorded and queryable" — the concrete Redis
  // check: a failed outcome is discoverable through the LIST surface the
  // `GET /api/holdback/merge-event-enrol` route serves.
  test("AC: a failed enrolment is queryable via listMergeEventEnrolRecords", async (t) => {
    if (!guard(t)) return;
    await recordMergeEventEnrolResult({
      prNumber: 8002,
      commitSha: "sha8002",
      tier: 3,
      status: "failed",
      error: "outcomes.yaml unreadable",
      recordedAt: 2000,
    });

    const listed = await listMergeEventEnrolRecords();
    assert.equal(listed.ok, true);
    const failedEntry = (listed as any).records.find((r: MergeEventEnrolRecord) => r.prNumber === 8002);
    assert.ok(failedEntry, "the failed record is present in the list");
    assert.equal(failedEntry?.status, "failed");
    assert.equal(failedEntry?.error, "outcomes.yaml unreadable");
  });

  test("listMergeEventEnrolRecords orders newest-first", async (t) => {
    if (!guard(t)) return;
    await recordMergeEventEnrolResult({
      prNumber: 8003,
      commitSha: "shaA",
      tier: 2,
      status: "enrolled",
      recordedAt: 1000,
    });
    await recordMergeEventEnrolResult({
      prNumber: 8004,
      commitSha: "shaB",
      tier: 2,
      status: "enrolled",
      recordedAt: 5000,
    });

    const listed = await listMergeEventEnrolRecords();
    assert.equal(listed.ok, true);
    const nums = (listed as any).records.map((r: MergeEventEnrolRecord) => r.prNumber);
    assert.ok(nums.indexOf(8004) < nums.indexOf(8003), "the newer record sorts first");
  });

  test("end-to-end against live Redis: an unregistered T2 merge is enrolled, and a second pass is a no-op", async (t) => {
    if (!guard(t)) return;
    const candidate: MergeEventCandidate = { prNumber: 8005, mergeCommitSha: "sha8005" };
    const enrollCalls: any[] = [];
    const deps: HoldbackMergeEventEnrolDeps = {
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["dashboard/src/App.tsx"],
      classify: () => ({ tier: 2, reason: "dashboard change", perFile: [] }),
      enroll: async (input: any) => {
        enrollCalls.push(input);
        return { ok: true, enrolled: true, leadingCount: 1, baseline: {} as any };
      },
      // Real Redis accessors for listPending/wasEnrolled/mark/getRecord/recordResult (defaults).
    };

    const res1 = await runHoldbackMergeEventEnrol(deps);
    assert.equal(res1.enrolled, 1);
    assert.equal(await wasEnrolledMarked(8005), true);
    const rec = await getMergeEventEnrolRecord(8005);
    assert.equal(rec?.status, "enrolled");

    const res2 = await runHoldbackMergeEventEnrol(deps);
    assert.equal(res2.enrolled, 0, "the second pass finds the shared marker already set");
    assert.equal(res2.skippedRegistered, 1);
    assert.equal(enrollCalls.length, 1, "enroll fired exactly once across two ticks");
  });

  test("a candidate still present in the pending-enroll registry is left to the normal watcher", async (t) => {
    if (!guard(t)) return;
    await pendingEnrollAdd({ prNumber: 8006, tier: 2, cycleId: "cyc-8006", registeredAt: 1 });
    const candidate: MergeEventCandidate = { prNumber: 8006, mergeCommitSha: "sha8006" };
    const deps: HoldbackMergeEventEnrolDeps = {
      listMergedCandidates: async () => [candidate],
      fetchChangedFiles: async () => ["dashboard/src/App.tsx"],
      classify: () => ({ tier: 2, reason: "dashboard change", perFile: [] }),
    };

    const res = await runHoldbackMergeEventEnrol(deps);
    assert.equal(res.skippedRegistered, 1);
    assert.equal(await getMergeEventEnrolRecord(8006), null, "this chore never touches a still-pending PR");
  });
});
