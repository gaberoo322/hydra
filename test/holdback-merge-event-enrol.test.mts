/**
 * Regression tests for the merge-event holdback enrolment chore (issue #4632,
 * ADR-0034 §8/§9, guidance-epic 13/19; design-concept `issue-4632`).
 *
 * Two layers, matching the `test/holdback.test.mts` convention:
 *   1. Pure decision logic (no Redis) for `runMergeEventEnrol`
 *      (`src/scheduler/chores/holdback-merge-event-enrol.ts`) — every dep
 *      (`listMergedPrs`, `fetchPrFiles`, `listPending`, `loadBaseline`,
 *      `enroll`, `getEnrolState`, `recordEnrolState`, `setHealth`, `now`) is
 *      faked, with `getEnrolState`/`recordEnrolState` backed by a shared
 *      in-memory `Map` so the attempt ladder can be driven across multiple
 *      simulated ticks without a live Redis.
 *   2. `GET /api/holdback/enrolments` + the `POST /holdback/enroll` INV-11
 *      enrol-state side effect, against a live Redis (skipped if unreachable)
 *      — its own top-level `describe` with its own before/after server +
 *      Redis lifecycle (CLAUDE.md nested-teardown pitfall), per-case
 *      `beforeEach` cleanup (CLAUDE.md per-case-isolation pitfall).
 *
 * Bug class this guards against (design-concept invariants):
 *   - AC1: an operator-merged T2+ PR with no registry entry gets enrolled.
 *   - AC2: a failed enrolment is recorded and queryable (`state=failed`).
 *   - A registered PR / a SHA with a terminal enrol-state row / a SHA with an
 *     existing baseline must NEVER be re-enrolled (INV-2, INV-12).
 *   - A merge outside the 48h lookback is ignored.
 *   - A whole-listing failure is chore health, never a thrown error.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Redis from "ioredis";
import type { AddressInfo } from "node:net";

import {
  runMergeEventEnrol,
  MERGE_EVENT_LOOKBACK_MS,
  MERGE_EVENT_CONFIRM_LIMIT,
  MERGE_EVENT_MAX_ATTEMPTS,
  type HoldbackMergeEventEnrolDeps,
  type MergedPrCandidate,
} from "../src/scheduler/chores/holdback-merge-event-enrol.ts";
import {
  type HoldbackEnrolState,
  type EnrolStateWriteResult,
  recordEnrolState,
  getEnrolState,
  listEnrolStates,
  setMergeEventHealth,
  _resetEnrolState,
  _resetMergeEventHealth,
} from "../src/redis/holdback-merge-watch.ts";
import { createHoldbackRouter } from "../src/api/holdback.ts";
import type { HoldbackEventBus } from "../src/holdback.ts";

// ---------------------------------------------------------------------------
// Layer 1 — pure decision logic (no Redis)
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
const RECENT_MERGE_ISO = "2026-09-20T00:00:00.000Z"; // 12h before NOW_MS — inside the 48h lookback
const STALE_MERGE_ISO = "2026-09-10T00:00:00.000Z"; // well outside the 48h lookback

function candidate(number: number, sha: string, mergedAt = RECENT_MERGE_ISO): MergedPrCandidate {
  return { number, mergeCommitSha: sha, mergedAt };
}

/**
 * Build a fully-faked `HoldbackMergeEventEnrolDeps` bundle backed by a shared
 * in-memory `Map<commitSha, HoldbackEnrolState>` for `getEnrolState`/
 * `recordEnrolState` — so calling `runMergeEventEnrol` multiple times against
 * the SAME harness simulates multiple housekeeping ticks against the same
 * durable state, exactly like the real Redis-backed accessors would.
 */
function makeMergeEventHarness(opts: {
  merged?: MergedPrCandidate[];
  files?: Record<number, string[] | null>;
  pendingPrNumbers?: number[];
  baselines?: Record<string, { tier: number | null } | undefined>;
  enroll?: HoldbackMergeEventEnrolDeps["enroll"];
} = {}) {
  const store = new Map<string, HoldbackEnrolState>();
  const healthWrites: any[] = [];
  const enrollCalls: any[] = [];
  const fetchFilesCalls: number[] = [];

  const deps: HoldbackMergeEventEnrolDeps = {
    listMergedPrs: async () => opts.merged ?? [],
    fetchPrFiles: async (n: number) => {
      fetchFilesCalls.push(n);
      if (!opts.files) return [];
      return Object.prototype.hasOwnProperty.call(opts.files, n) ? opts.files[n] : [];
    },
    listPending: async () => ({
      ok: true as const,
      entries: (opts.pendingPrNumbers ?? []).map((n) => ({
        prNumber: n,
        tier: null,
        cycleId: `cyc-${n}`,
        registeredAt: 1,
      })),
    }),
    loadBaseline: async (sha: string) => {
      const b = opts.baselines?.[sha];
      if (!b) return { ok: true as const, baseline: null };
      return { ok: true as const, baseline: { ...b, commitSha: sha, enrolledAt: 1, windowCycles: 5, leading: [] } as any };
    },
    enroll:
      opts.enroll ??
      (async (input: { commitSha: string; prNumber: number; tier: number }) => {
        enrollCalls.push(input);
        if (input.tier < 2) {
          return {
            ok: true as const,
            enrolled: false as const,
            reason: `tier T${input.tier} is exempt from Outcome Holdback (only T2/T3/T4 enroll)`,
          };
        }
        return { ok: true as const, enrolled: true as const, leadingCount: 1, baseline: {} as any };
      }),
    getEnrolState: async (sha: string) => ({ ok: true as const, state: store.get(sha) ?? null }),
    recordEnrolState: async (record: HoldbackEnrolState): Promise<EnrolStateWriteResult> => {
      store.set(record.commitSha, record);
      return { ok: true };
    },
    setHealth: async (rec: any) => {
      healthWrites.push(rec);
    },
    now: () => NOW_MS,
  };

  return { deps, store, healthWrites, enrollCalls, fetchFilesCalls };
}

describe("Merge-event holdback enrolment chore (#4632) — decision logic (no Redis)", () => {
  test("constants match the design-concept invariants (48h lookback, 10/tick, 3 attempts)", () => {
    assert.equal(MERGE_EVENT_LOOKBACK_MS, 48 * 60 * 60 * 1000);
    assert.equal(MERGE_EVENT_CONFIRM_LIMIT, 10);
    assert.equal(MERGE_EVENT_MAX_ATTEMPTS, 3);
  });

  test("AC1: an operator-merged T3 PR with no registry entry is enrolled, source 'merge-event'", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(101, "sha101")],
      files: { 101: ["src/holdback.ts"] },
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.scanned, 1);
    assert.equal(res.candidates, 1);
    assert.equal(res.enrolled, 1);
    assert.equal(res.skippedRegistered, 0);
    assert.equal(res.skippedKnown, 0);
    assert.equal(h.enrollCalls, h.enrollCalls); // sanity: array exists
    assert.equal(h.enrollCalls.length, 1);
    assert.equal(h.enrollCalls[0].commitSha, "sha101");
    const stored = h.store.get("sha101");
    assert.equal(stored?.state, "enrolled");
    assert.equal(stored?.source, "merge-event");
    assert.equal(stored?.attempts, 0);
  });

  test("a PR already in the pending-enroll registry is skipped (merge-watch owns it)", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(102, "sha102")],
      files: { 102: ["src/x.ts"] },
      pendingPrNumbers: [102],
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.skippedRegistered, 1);
    assert.equal(res.enrolled, 0);
    assert.equal(h.enrollCalls.length, 0, "never even classified — the registry check happens first");
    assert.equal(h.store.size, 0);
  });

  test("a T1-classified merge records 'exempt', no baseline call needed", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(103, "sha103")],
      files: { 103: ["config/agents/foo.md"] },
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.exempt, 1);
    assert.equal(res.enrolled, 0);
    const stored = h.store.get("sha103");
    assert.equal(stored?.state, "exempt");
    assert.match(stored?.reason ?? "", /exempt/i);
  });

  test("a SHA that already has a terminal enrol-state row is skipped (not re-classified)", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(104, "sha104")],
      files: { 104: ["src/x.ts"] },
    });
    h.store.set("sha104", {
      commitSha: "sha104",
      prNumber: 104,
      tier: 3,
      source: "manual",
      state: "enrolled",
      attempts: 0,
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.skippedKnown, 1);
    assert.equal(res.enrolled, 0);
    assert.equal(h.enrollCalls.length, 0, "never re-classified — the dedup check short-circuits first");
  });

  test("a SHA in 'retrying' state IS retried, not skipped", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(105, "sha105")],
      files: { 105: ["src/x.ts"] },
    });
    h.store.set("sha105", {
      commitSha: "sha105",
      prNumber: 105,
      tier: 3,
      source: "merge-event",
      state: "retrying",
      reason: "prior failure",
      attempts: 1,
      firstSeenAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.skippedKnown, 0);
    assert.equal(res.enrolled, 1);
    assert.equal(h.enrollCalls.length, 1, "retrying rows ARE re-attempted");
    const stored = h.store.get("sha105");
    assert.equal(stored?.state, "enrolled");
    assert.equal(stored?.attempts, 0, "a success resets the attempt counter");
    assert.equal(stored?.firstSeenAt, "2026-09-19T00:00:00.000Z", "firstSeenAt carries forward from the prior row");
  });

  test("INV-2c / INV-12: a SHA with an existing holdback baseline is backfilled as 'enrolled' WITHOUT calling enroll again", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(106, "sha106")],
      files: { 106: ["src/x.ts"] },
      baselines: { sha106: { tier: 3 } },
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.skippedKnown, 1);
    assert.equal(res.enrolled, 0, "not counted as a fresh enrolment — it's a backfill");
    assert.equal(h.enrollCalls.length, 0, "never re-enrols an already-baselined SHA (INV-12)");
    const stored = h.store.get("sha106");
    assert.equal(stored?.state, "enrolled");
    assert.equal(stored?.source, "backfill");
    assert.equal(stored?.tier, 3);
  });

  test("a merge older than the 48h lookback is ignored entirely", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(107, "sha107", STALE_MERGE_ISO)],
      files: { 107: ["src/x.ts"] },
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.scanned, 1);
    assert.equal(res.candidates, 0, "filtered out before the candidate count");
    assert.equal(h.enrollCalls.length, 0);
    assert.equal(h.store.size, 0);
  });

  test("AC2: enroll ok:false retries then reaches 'failed' at the 3rd attempt, across three ticks", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(108, "sha108")],
      files: { 108: ["src/x.ts"] },
      enroll: async () => ({ ok: false as const, error: "transient boom" }),
    });

    const r1 = await runMergeEventEnrol(h.deps);
    assert.equal(r1.retrying, 1);
    assert.equal(h.store.get("sha108")?.state, "retrying");
    assert.equal(h.store.get("sha108")?.attempts, 1);
    const firstSeenAt = h.store.get("sha108")?.firstSeenAt;

    const r2 = await runMergeEventEnrol(h.deps);
    assert.equal(r2.retrying, 1);
    assert.equal(h.store.get("sha108")?.attempts, 2);
    assert.equal(h.store.get("sha108")?.firstSeenAt, firstSeenAt, "firstSeenAt never moves across retries");

    const r3 = await runMergeEventEnrol(h.deps);
    assert.equal(r3.failed, 1);
    assert.equal(h.store.get("sha108")?.state, "failed");
    assert.equal(h.store.get("sha108")?.attempts, 3);
  });

  test("a files-fetch failure (fetchPrFiles → null) is ALSO an attempt failure, never a guessed tier", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(109, "sha109")],
      files: { 109: null },
    });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.retrying, 1);
    assert.equal(h.enrollCalls.length, 0, "never guesses a tier and calls enroll without the files");
    const stored = h.store.get("sha109");
    assert.equal(stored?.state, "retrying");
    assert.equal(stored?.reason, "files fetch failed");
  });

  test("new candidates beyond the per-tick classification limit are deferred, not dropped", async () => {
    const merged = Array.from({ length: MERGE_EVENT_CONFIRM_LIMIT + 3 }, (_, i) => candidate(200 + i, `sha20${i}`));
    const files: Record<number, string[]> = {};
    for (const c of merged) files[c.number] = ["src/x.ts"];
    const h = makeMergeEventHarness({ merged, files });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.candidates, MERGE_EVENT_CONFIRM_LIMIT + 3);
    assert.equal(res.enrolled, MERGE_EVENT_CONFIRM_LIMIT);
    assert.equal(res.deferred, 3);
    assert.equal(h.enrollCalls.length, MERGE_EVENT_CONFIRM_LIMIT);
  });

  test("a whole-listing failure (listMergedPrs → null) persists chore health with listError and never throws", async () => {
    const h = makeMergeEventHarness();
    h.deps.listMergedPrs = async () => null;

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.scanned, 0);
    assert.equal(res.candidates, 0);
    assert.equal(h.healthWrites.length, 1);
    assert.equal(h.healthWrites[0].listError, "listMergedPrs failed");
  });

  test("a pendingEnrollList failure degrades to an empty skip-set rather than throwing", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(110, "sha110")],
      files: { 110: ["src/x.ts"] },
    });
    h.deps.listPending = async () => ({ ok: false as const, error: "redis down" });

    const res = await runMergeEventEnrol(h.deps);

    assert.equal(res.enrolled, 1, "proceeds to classify/enrol rather than treating the listing failure as a skip");
  });

  test("health snapshot after a normal run carries the full count breakdown", async () => {
    const h = makeMergeEventHarness({
      merged: [candidate(111, "sha111"), candidate(112, "sha112")],
      files: { 111: ["src/x.ts"], 112: ["config/agents/x.md"] },
    });

    await runMergeEventEnrol(h.deps);

    assert.equal(h.healthWrites.length, 1);
    const rec = h.healthWrites[0];
    assert.equal(rec.scanned, 2);
    assert.equal(rec.candidates, 2);
    assert.equal(rec.enrolled, 1);
    assert.equal(rec.exempt, 1);
    assert.equal(typeof rec.ranAt, "string");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — GET /api/holdback/enrolments + POST /holdback/enroll INV-11,
// against a live Redis (skipped if unreachable). Own top-level describe with
// its own before/after server + Redis lifecycle (CLAUDE.md nested-teardown
// pitfall); per-case beforeEach cleanup (CLAUDE.md per-case-isolation
// pitfall) — every case seeds/writes enrol-state rows a sibling case must not
// see.
// ---------------------------------------------------------------------------

describe("GET /api/holdback/enrolments + POST /holdback/enroll enrol-state side effect (#4632, Redis)", () => {
  let redis: any;
  let redisUp = false;
  let server: any;
  let baseUrl: string;

  before(async () => {
    try {
      redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
      await redis.ping();
      redisUp = true;
    } catch {
      redisUp = false;
      return;
    }
    const bus: HoldbackEventBus = { async publish() { return "0-0"; } };
    const app = express();
    app.use(express.json());
    app.use(createHoldbackRouter(bus));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (redis) {
      try { await redis.quit(); } catch { /* intentional: best-effort close */ }
    }
  });

  beforeEach(async () => {
    if (redisUp) {
      await _resetEnrolState();
      await _resetMergeEventHealth();
    }
  });

  function guard(t: any): boolean {
    if (!redisUp) {
      t.skip("Redis unavailable at localhost:6379/1");
      return false;
    }
    return true;
  }

  test("recordEnrolState → getEnrolState roundtrips, and listEnrolStates lists newest-mergedAt-first", async (t) => {
    if (!guard(t)) return;

    const older: HoldbackEnrolState = {
      commitSha: "sha-older",
      prNumber: 301,
      tier: 3,
      source: "merge-event",
      state: "enrolled",
      attempts: 0,
      mergedAt: "2026-09-01T00:00:00.000Z",
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const newer: HoldbackEnrolState = {
      ...older,
      commitSha: "sha-newer",
      prNumber: 302,
      mergedAt: "2026-09-15T00:00:00.000Z",
      firstSeenAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    await recordEnrolState(older);
    await recordEnrolState(newer);

    const got = await getEnrolState("sha-older");
    assert.equal(got.ok, true);
    assert.equal((got as any).state?.prNumber, 301);

    const listed = await listEnrolStates({});
    assert.equal(listed.ok, true);
    if (listed.ok) {
      const shas = listed.states.map((s) => s.commitSha);
      assert.deepEqual(shas, ["sha-newer", "sha-older"], "newest mergedAt first");
    }
  });

  test("listEnrolStates filters by state", async (t) => {
    if (!guard(t)) return;

    await recordEnrolState({
      commitSha: "sha-failed",
      prNumber: 401,
      tier: 3,
      source: "merge-event",
      state: "failed",
      reason: "boom",
      attempts: 3,
      mergedAt: "2026-09-10T00:00:00.000Z",
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    });
    await recordEnrolState({
      commitSha: "sha-enrolled",
      prNumber: 402,
      tier: 3,
      source: "merge-event",
      state: "enrolled",
      attempts: 0,
      mergedAt: "2026-09-11T00:00:00.000Z",
      firstSeenAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    });

    const failedOnly = await listEnrolStates({ state: "failed" });
    assert.equal(failedOnly.ok, true);
    if (failedOnly.ok) {
      assert.deepEqual(failedOnly.states.map((s) => s.commitSha), ["sha-failed"]);
    }
  });

  test("AC2: GET /holdback/enrolments?state=failed returns the failed-state breakage signal over HTTP", async (t) => {
    if (!guard(t)) return;

    await recordEnrolState({
      commitSha: "sha-http-failed",
      prNumber: 501,
      tier: 3,
      source: "merge-event",
      state: "failed",
      reason: "exhausted attempts",
      attempts: 3,
      mergedAt: "2026-09-12T00:00:00.000Z",
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
    await setMergeEventHealth({
      ranAt: "2026-09-12T00:00:00.000Z",
      scanned: 5,
      candidates: 1,
      enrolled: 0,
      exempt: 0,
      noSignal: 0,
      retrying: 0,
      failed: 1,
      skippedRegistered: 0,
      skippedKnown: 4,
      deferred: 0,
    });

    const res = await fetch(`${baseUrl}/holdback/enrolments?state=failed`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enrolments.length, 1);
    assert.equal(body.enrolments[0].commitSha, "sha-http-failed");
    assert.equal(body.enrolments[0].state, "failed");
    assert.equal(body.scanned, 5);
    assert.equal(body.scan.failed, 1);
    assert.equal(typeof body.generatedAt, "string");
  });

  test("GET /holdback/enrolments with a bad query returns 400 schema-validation-failed", async (t) => {
    if (!guard(t)) return;

    const res = await fetch(`${baseUrl}/holdback/enrolments?state=bogus`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "schema-validation-failed");
  });

  test("GET /holdback/enrolments degrades to an empty envelope (never a 500) when nothing has ever run", async (t) => {
    if (!guard(t)) return;

    const res = await fetch(`${baseUrl}/holdback/enrolments`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.enrolments, []);
    assert.equal(body.scanned, 0);
    assert.equal(body.scan, null);
  });

  // INV-11: POST /holdback/enroll's enrol-state side effect. `enrollHoldback`'s
  // tier check short-circuits BEFORE any outcomes.yaml read, so `tier: 1` is a
  // deterministic `enrolled:false` (T1 exempt) regardless of the real
  // production outcomes.yaml content — the one enroll outcome this suite can
  // assert on over real HTTP without depending on that file's live values.
  test("INV-11: POST /holdback/enroll with tier:1 upserts an 'exempt' enrol-state row on success", async (t) => {
    if (!guard(t)) return;

    const res = await fetch(`${baseUrl}/holdback/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitSha: "sha-manual-t1", prNumber: 601, tier: 1 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enrolled, false);

    const state = await getEnrolState("sha-manual-t1");
    assert.equal(state.ok, true);
    if (state.ok) {
      assert.equal(state.state?.state, "exempt");
      assert.equal(state.state?.source, "manual");
      assert.equal(state.state?.prNumber, 601);
    }
  });

  // The route's `POST /holdback/enroll` ok:false branch (record an attempt
  // failure ONLY when a row already exists) delegates entirely to
  // `recordEnrolAttemptFailure` (`src/holdback.ts`) — the SAME coordinator the
  // merge-event-enrol chore and `holdback-merge-watch.ts` use. `enrollHoldback`
  // has no deterministic way to fail over real HTTP without either breaking
  // Redis or mutating the real `config/direction/outcomes.yaml`, so the
  // ladder itself is covered here directly against the coordinator (real
  // Redis), and the chore-level "decision logic" suite above covers the same
  // ladder end-to-end via `runMergeEventEnrol`'s own injected accessors.
  test("recordEnrolOutcome / recordEnrolAttemptFailure (the shared coordinator both the chore and this route call): ladder + reset semantics against real Redis", async (t) => {
    if (!guard(t)) return;
    const { recordEnrolOutcome, recordEnrolAttemptFailure } = await import("../src/holdback.ts");

    const commitSha = "sha-coordinator-701";
    const s1 = await recordEnrolAttemptFailure({ commitSha, prNumber: 701, tier: 3, source: "manual", reason: "e1" });
    assert.equal(s1, "retrying");
    let stored = await getEnrolState(commitSha);
    assert.equal(stored.ok, true);
    if (stored.ok) {
      assert.equal(stored.state?.attempts, 1);
      assert.equal(stored.state?.state, "retrying");
    }
    const firstSeenAt = stored.ok ? stored.state?.firstSeenAt : undefined;

    const s2 = await recordEnrolAttemptFailure({ commitSha, prNumber: 701, tier: 3, source: "manual", reason: "e2" });
    assert.equal(s2, "retrying");
    const s3 = await recordEnrolAttemptFailure({ commitSha, prNumber: 701, tier: 3, source: "manual", reason: "e3" });
    assert.equal(s3, "failed");
    stored = await getEnrolState(commitSha);
    if (stored.ok) {
      assert.equal(stored.state?.attempts, 3);
      assert.equal(stored.state?.state, "failed");
      assert.equal(stored.state?.firstSeenAt, firstSeenAt, "firstSeenAt never moves across the ladder");
    }

    // A later success clears the retry streak — attempts resets to 0.
    await recordEnrolOutcome({ commitSha, prNumber: 701, tier: 3, source: "manual", state: "enrolled" });
    stored = await getEnrolState(commitSha);
    if (stored.ok) {
      assert.equal(stored.state?.state, "enrolled");
      assert.equal(stored.state?.attempts, 0, "a success resets the attempt counter");
      assert.equal(stored.state?.firstSeenAt, firstSeenAt, "firstSeenAt still carries forward");
    }
  });
});
