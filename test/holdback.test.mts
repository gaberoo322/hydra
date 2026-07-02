/**
 * Regression tests for the Outcome Holdback producer (issue #786, ADR-0004
 * step 4) — the post-merge regression-check mechanism that finally feeds
 * digest.ts's previously-orphaned holdback.* consumer.
 *
 * Two layers:
 *   1. Pure decision logic (no Redis): regression detection direction/epsilon
 *      semantics, leading-only filtering, no-data handling.
 *   2. The producer (enroll → check) end-to-end against a live Redis (DB 1,
 *      skipped if unreachable) with a fake event bus that captures the
 *      holdback.* events the digest consumer reads.
 *
 * Bug class this guards against:
 *   - The producer emitting event names the digest consumer does NOT read
 *     (leaving the consumer orphaned — the exact no-op #786 fixes).
 *   - Reverting on a FAVORABLE move, or on a move within noise_epsilon.
 *   - Reverting on adapter no-data (null) — must be no-data, never a revert.
 *   - Watching terminal outcomes (only leading outcomes may drive a revert).
 *   - Ignoring the per-day revert cap.
 */

// Point the Redis singleton at DB 1 before any seam import (matches backlog.test).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";

import {
  isOutcomeRegressed,
  detectRegressions,
  snapshotLeadingOutcomes,
  decideHoldback,
} from "../src/outcome-regression.ts";
import {
  enrollHoldback,
  checkHoldback,
  reportRevertFailed,
  type HoldbackEventBus,
} from "../src/holdback.ts";
import type { HoldbackBaseline } from "../src/redis/holdback.ts";
import {
  listRevertedMerges,
  removeRevertedMerge,
  attributionRevertedKey,
} from "../src/redis/attribution.ts";
import {
  loadBaseline,
  getRevertCount,
  _resetRevertCount,
  holdbackBaselineKey,
  utcDateKey,
  isEnrolledTier,
  windowCyclesForTier,
  HOLDBACK_WINDOW_CYCLES,
  HOLDBACK_WINDOW_CYCLES_T3,
  HOLDBACK_WINDOW_CYCLES_T4,
  pendingEnrollAdd,
  pendingEnrollList,
  pendingEnrollRemove,
  _resetPendingEnroll,
  wasEnrolledMarked,
  markEnrolled,
  _resetEnrolledMarker,
  setMergeWatchHealth,
  getMergeWatchHealth,
} from "../src/redis/holdback.ts";
import {
  runHoldbackMergeWatch,
  type MergeStatus,
  type HoldbackMergeWatchDeps,
} from "../src/scheduler/chores/holdback-merge-watch.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-holdback-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/** Write an outcomes.yaml fixture + the file-source value files it references. */
async function outcomesFixture(yaml: string): Promise<string> {
  const path = join(tmpDir, `outcomes-${Math.random().toString(36).slice(2)}.yaml`);
  await writeFile(path, yaml);
  return path;
}

async function valueFile(name: string, value: number): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, String(value));
  return path;
}

/** Fake event bus capturing every published event. */
function captureBus(): { bus: HoldbackEventBus; events: Array<{ type: string; payload: any }> } {
  const events: Array<{ type: string; payload: any }> = [];
  const bus: HoldbackEventBus = {
    async publish(_stream, event) {
      events.push({ type: event.type, payload: event.payload });
      return "0-0";
    },
  };
  return { bus, events };
}

// ---------------------------------------------------------------------------
// Layer 1 — pure decision logic (no Redis)
// ---------------------------------------------------------------------------

describe("isOutcomeRegressed — direction + epsilon semantics", () => {
  test("up outcome: drop beyond epsilon is a regression", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.3, "up", 0.05), true);
  });
  test("up outcome: drop within epsilon is NOT a regression", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.47, "up", 0.05), false);
  });
  test("up outcome: rise (favorable) is NOT a regression", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.9, "up", 0.05), false);
  });
  test("down outcome: rise beyond epsilon is a regression", () => {
    assert.equal(isOutcomeRegressed(10, 20, "down", 1), true);
  });
  test("down outcome: drop (favorable) is NOT a regression", () => {
    assert.equal(isOutcomeRegressed(10, 2, "down", 1), false);
  });
  test("exactly epsilon is NOT a regression (must EXCEED)", () => {
    assert.equal(isOutcomeRegressed(0.5, 0.45, "up", 0.05), false);
  });
  test("null on either side is no-data, never a regression", () => {
    assert.equal(isOutcomeRegressed(null, 0.1, "up", 0), false);
    assert.equal(isOutcomeRegressed(0.5, null, "up", 0), false);
  });
});

describe("detectRegressions — matches by name, skips no-data", () => {
  test("returns only the regressed leading outcomes", () => {
    const baseline = [
      { name: "a", direction: "up" as const, noiseEpsilon: 0.01, value: 0.5 },
      { name: "b", direction: "down" as const, noiseEpsilon: 0.01, value: 1.0 },
      { name: "c", direction: "up" as const, noiseEpsilon: 0.01, value: 0.5 },
    ];
    const current = [
      { name: "a", value: 0.2 }, // regressed (up, dropped)
      { name: "b", value: 0.5 }, // favorable (down, dropped)
      { name: "c", value: null }, // no-data
    ];
    const out = detectRegressions(baseline, current);
    assert.deepEqual(out.map((r) => r.name), ["a"]);
    assert.equal(out[0].baseline, 0.5);
    assert.equal(out[0].current, 0.2);
  });
  test("missing-from-current is skipped (no-data)", () => {
    const baseline = [{ name: "a", direction: "up" as const, noiseEpsilon: 0, value: 0.5 }];
    assert.deepEqual(detectRegressions(baseline, []), []);
  });
});

describe("decideHoldback — pure regression decision (no bus, no Redis)", () => {
  // A baseline helper: every field the pure decision reads, no I/O. The
  // window is 1 cycle and cycleDurationMs defaults to 1h, so enrolledAt = now
  // is "still watching" and enrolledAt = now - 2h is "window elapsed".
  function baseline(leading: HoldbackBaseline["leading"], enrolledAtMs: number): HoldbackBaseline {
    return {
      commitSha: "puresha01",
      prNumber: 7,
      tier: 2,
      enrolledAt: enrolledAtMs,
      windowCycles: 1,
      leading,
    };
  }
  const upMetric = [{ name: "m", direction: "up" as const, noiseEpsilon: 0.01, value: 0.5 }];

  test("regression below cap → revert (carries prNumber + regressedOutcomes)", () => {
    const nowMs = 1_000_000_000_000;
    const d = decideHoldback({
      baseline: baseline(upMetric, nowMs),
      current: [{ name: "m", value: 0.2 }], // regressed (up, dropped beyond epsilon)
      revertCount: 0,
      nowMs,
    });
    assert.equal(d.decision, "revert");
    assert.equal((d as any).commitSha, "puresha01");
    assert.equal((d as any).prNumber, 7);
    assert.deepEqual((d as any).regressedOutcomes, ["m"]);
  });

  test("regression at-or-past the per-day cap → cap-reached (no prNumber)", () => {
    const nowMs = 1_000_000_000_000;
    const d = decideHoldback({
      baseline: baseline(upMetric, nowMs),
      current: [{ name: "m", value: 0.2 }],
      revertCount: 3, // HOLDBACK_MAX_REVERTS_PER_DAY default
      nowMs,
    });
    assert.equal(d.decision, "cap-reached");
    assert.deepEqual((d as any).regressedOutcomes, ["m"]);
    assert.equal((d as any).prNumber, undefined, "cap-reached omits prNumber");
  });

  test("no regression, window still open → watching", () => {
    const nowMs = 1_000_000_000_000;
    const d = decideHoldback({
      baseline: baseline(upMetric, nowMs), // enrolled at now → 0 elapsed < 1h window
      current: [{ name: "m", value: 0.5 }], // unchanged
      revertCount: 0,
      nowMs,
    });
    assert.equal(d.decision, "watching");
    assert.equal((d as any).commitSha, "puresha01");
  });

  test("no regression, window elapsed → passed", () => {
    const nowMs = 1_000_000_000_000;
    const d = decideHoldback({
      baseline: baseline(upMetric, nowMs - 2 * 60 * 60 * 1000), // enrolled 2h ago > 1h window
      current: [{ name: "m", value: 0.5 }],
      revertCount: 0,
      nowMs,
    });
    assert.equal(d.decision, "passed");
    assert.equal((d as any).commitSha, "puresha01");
  });

  test("favorable move is not a regression → watching (window open)", () => {
    const nowMs = 1_000_000_000_000;
    const d = decideHoldback({
      baseline: baseline(upMetric, nowMs),
      current: [{ name: "m", value: 0.9 }], // up metric rose → favorable
      revertCount: 0,
      nowMs,
    });
    assert.equal(d.decision, "watching");
  });

  test("nowMs defaults to Date.now when omitted (regression still decides revert)", () => {
    const d = decideHoldback({
      baseline: baseline(upMetric, Date.now()),
      current: [{ name: "m", value: 0.2 }],
      revertCount: 0,
    });
    assert.equal(d.decision, "revert");
  });
});

describe("snapshotLeadingOutcomes — leading only, null on no-data", () => {
  test("excludes terminal outcomes and reads leading file values", async () => {
    await valueFile("lead.txt", 0.42);
    const yaml = `outcomes:
  - name: lead-metric
    kind: leading
    direction: up
    source: file
    query: ${join(tmpDir, "lead.txt")}
    baseline: 0
    target: 1
    noise_epsilon: 0.01
  - name: term-metric
    kind: terminal
    direction: up
    source: file
    query: ${join(tmpDir, "lead.txt")}
    baseline: 0
    target: 1
`;
    const path = await outcomesFixture(yaml);
    const snap = await snapshotLeadingOutcomes(path);
    assert.equal(snap.length, 1, "terminal outcome must be excluded");
    assert.equal(snap[0].name, "lead-metric");
    assert.equal(snap[0].value, 0.42);
  });
  test("unreachable adapter surfaces as null, not a thrown error", async () => {
    const yaml = `outcomes:
  - name: missing-file
    kind: leading
    direction: up
    source: file
    query: ${join(tmpDir, "does-not-exist.txt")}
    baseline: 0
    target: 1
`;
    const path = await outcomesFixture(yaml);
    const snap = await snapshotLeadingOutcomes(path);
    assert.equal(snap.length, 1);
    assert.equal(snap[0].value, null);
  });
});

// ---------------------------------------------------------------------------
// Layer 1b — carry-up enrollment predicate + tier-aware window (#741, no Redis)
// ---------------------------------------------------------------------------

describe("isEnrolledTier — carry-up applies to T2/T3/T4 only (#741)", () => {
  test("T1 (prompt-shaped) is exempt", () => {
    assert.equal(isEnrolledTier(1), false);
  });
  test("T2, T3, T4 all enroll", () => {
    assert.equal(isEnrolledTier(2), true);
    assert.equal(isEnrolledTier(3), true);
    assert.equal(isEnrolledTier(4), true);
  });
  test("null / undefined / unknown tier does not enroll (no signal)", () => {
    assert.equal(isEnrolledTier(null), false);
    assert.equal(isEnrolledTier(undefined), false);
    assert.equal(isEnrolledTier(0), false);
    assert.equal(isEnrolledTier(5), false);
  });
});

describe("windowCyclesForTier — tier-aware + monotonic (#741)", () => {
  test("T2 is the floor (HOLDBACK_WINDOW_CYCLES)", () => {
    assert.equal(windowCyclesForTier(2), HOLDBACK_WINDOW_CYCLES);
  });
  test("T3 watches at least as long as T2", () => {
    const w3 = windowCyclesForTier(3);
    assert.equal(w3, Math.max(HOLDBACK_WINDOW_CYCLES_T3, HOLDBACK_WINDOW_CYCLES));
    assert.ok(w3 >= windowCyclesForTier(2), "window(T3) >= window(T2)");
  });
  test("T4 watches at least as long as T3", () => {
    const w4 = windowCyclesForTier(4);
    assert.ok(w4 >= windowCyclesForTier(3), "window(T4) >= window(T3)");
  });
  test("monotonic across the whole ladder", () => {
    const w2 = windowCyclesForTier(2);
    const w3 = windowCyclesForTier(3);
    const w4 = windowCyclesForTier(4);
    assert.ok(w2 <= w3 && w3 <= w4, "window(T2) <= window(T3) <= window(T4)");
  });
  test("T1 / null / unknown fall back to the T2 floor", () => {
    assert.equal(windowCyclesForTier(1), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(null), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(undefined), HOLDBACK_WINDOW_CYCLES);
  });
  test("default windows are sane and ascending (5/7/10)", (t) => {
    // Only meaningful when no operator env override is in play — skip cleanly
    // if the test environment has tuned the windows.
    const overridden =
      process.env.HYDRA_HOLDBACK_WINDOW_CYCLES != null ||
      process.env.HYDRA_HOLDBACK_WINDOW_CYCLES_T3 != null ||
      process.env.HYDRA_HOLDBACK_WINDOW_CYCLES_T4 != null;
    if (overridden) {
      t.skip("holdback window env override set — default-value assertion N/A");
      return;
    }
    assert.equal(windowCyclesForTier(2), 5);
    assert.equal(windowCyclesForTier(3), 7);
    assert.equal(windowCyclesForTier(4), 10);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — producer end-to-end (live Redis DB 1, skip if unreachable)
// ---------------------------------------------------------------------------

describe("Outcome Holdback producer (enroll → check)", () => {
  let redis: any;
  let redisUp = false;

  before(async () => {
    try {
      // Use the single-string-arg ioredis overload (`new Redis(url)`) — the
      // pattern the rest of the suite uses. The `(url-string, options)` form
      // makes TS drop the `(path, options)` overload and fall through to
      // `(port: number, options)`, raising TS2345 (issue #750 ratchet). ioredis
      // connects on construction; `ping()` (guarded by the catch) surfaces an
      // unreachable Redis so the live-DB tests skip cleanly.
      redis = new Redis(process.env.REDIS_URL!);
      await redis.ping();
      redisUp = true;
    } catch {
      redisUp = false;
    }
  });

  after(async () => {
    if (redis) {
      // Hard-clean the attribution reverted-merge registry so a mid-test
      // failure can't leak an entry into sibling live-Redis suites.
      try { await redis.del(attributionRevertedKey()); } catch { /* intentional: best-effort cleanup */ }
      try { await redis.quit(); } catch { /* intentional: best-effort close */ }
    }
  });

  function guard(t: any): boolean {
    if (!redisUp) {
      t.skip("Redis unavailable at localhost:6379/1");
      return false;
    }
    return true;
  }

  async function leadingYaml(file: string, value: number, eps = 0.01): Promise<string> {
    await valueFile(file, value);
    return outcomesFixture(`outcomes:
  - name: lead-metric
    kind: leading
    direction: up
    source: file
    query: ${join(tmpDir, file)}
    baseline: 0
    target: 1
    noise_epsilon: ${eps}
`);
  }

  test("enroll snapshots baseline; skips when no leading data", async (t) => {
    if (!guard(t)) return;
    // No leading outcomes at all → not enrolled.
    const emptyPath = await outcomesFixture("outcomes:\n");
    const r1 = await enrollHoldback({ commitSha: "deadbee1", outcomesFile: emptyPath });
    assert.equal(r1.ok, true);
    assert.equal((r1 as any).enrolled, false);

    // Leading outcome with data + an enrolled tier → enrolled + baseline persisted.
    const path = await leadingYaml("e1.txt", 0.5);
    const r2 = await enrollHoldback({ commitSha: "deadbee2", prNumber: 7, tier: 2, outcomesFile: path });
    assert.equal(r2.ok, true);
    assert.equal((r2 as any).enrolled, true);
    const loaded = await loadBaseline("deadbee2");
    assert.equal(loaded.ok, true);
    assert.equal((loaded as any).baseline.leading[0].value, 0.5);
    await redis.del(holdbackBaselineKey("deadbee2"));
  });

  test("T1 merge is NOT enrolled even with leading data (carry-up exemption #741)", async (t) => {
    if (!guard(t)) return;
    const path = await leadingYaml("t1.txt", 0.5);
    const r = await enrollHoldback({ commitSha: "t1sha001", tier: 1, outcomesFile: path });
    assert.equal(r.ok, true);
    assert.equal((r as any).enrolled, false, "T1 must never enroll");
    assert.match((r as any).reason, /exempt/i);
    // No baseline persisted.
    const loaded = await loadBaseline("t1sha001");
    assert.equal((loaded as any).baseline, null);
  });

  test("unknown tier (null) is NOT enrolled (no signal #741)", async (t) => {
    if (!guard(t)) return;
    const path = await leadingYaml("tnull.txt", 0.5);
    const r = await enrollHoldback({ commitSha: "tnullsha", tier: null, outcomesFile: path });
    assert.equal(r.ok, true);
    assert.equal((r as any).enrolled, false, "unknown tier must not enroll");
    const loaded = await loadBaseline("tnullsha");
    assert.equal((loaded as any).baseline, null);
  });

  test("T3 / T4 enroll with the tier-aware window persisted (#741)", async (t) => {
    if (!guard(t)) return;
    const path3 = await leadingYaml("t3.txt", 0.5);
    const r3 = await enrollHoldback({ commitSha: "t3sha001", tier: 3, outcomesFile: path3 });
    assert.equal((r3 as any).enrolled, true, "T3 must enroll");
    const b3 = await loadBaseline("t3sha001");
    assert.equal((b3 as any).baseline.tier, 3);
    assert.equal((b3 as any).baseline.windowCycles, windowCyclesForTier(3));
    await redis.del(holdbackBaselineKey("t3sha001"));

    const path4 = await leadingYaml("t4.txt", 0.5);
    const r4 = await enrollHoldback({ commitSha: "t4sha001", tier: 4, outcomesFile: path4 });
    assert.equal((r4 as any).enrolled, true, "T4 must enroll");
    const b4 = await loadBaseline("t4sha001");
    assert.equal((b4 as any).baseline.windowCycles, windowCyclesForTier(4));
    // Deeper tier watches at least as long.
    assert.ok(
      (b4 as any).baseline.windowCycles >= (b3 as any).baseline.windowCycles,
      "T4 window >= T3 window",
    );
    await redis.del(holdbackBaselineKey("t4sha001"));
  });

  test("explicit windowCycles override beats the tier-aware default", async (t) => {
    if (!guard(t)) return;
    const path = await leadingYaml("ovr.txt", 0.5);
    const r = await enrollHoldback({ commitSha: "ovrsha01", tier: 2, windowCycles: 42, outcomesFile: path });
    assert.equal((r as any).enrolled, true);
    const loaded = await loadBaseline("ovrsha01");
    assert.equal((loaded as any).baseline.windowCycles, 42, "explicit override wins");
    await redis.del(holdbackBaselineKey("ovrsha01"));
  });

  test("regression past epsilon emits holdback.reverted with required payload", async (t) => {
    if (!guard(t)) return;
    const enrollPath = await leadingYaml("rev.txt", 0.5);
    const sha = "revsha01";
    await enrollHoldback({ commitSha: sha, prNumber: 42, tier: 2, outcomesFile: enrollPath });

    // Drop the value below baseline by more than epsilon, then check.
    await writeFile(join(tmpDir, "rev.txt"), "0.2");
    const day = utcDateKey();
    await _resetRevertCount(day);
    const { bus, events } = captureBus();
    const res = await checkHoldback(bus, { commitSha: sha, outcomesFile: enrollPath });
    assert.equal(res.ok, true);
    assert.equal((res as any).result.decision, "revert");

    const reverted = events.find((e) => e.type === "holdback.reverted");
    assert.ok(reverted, "must emit holdback.reverted (the name digest.ts reads)");
    assert.equal(reverted!.payload.commitSha, sha);
    assert.deepEqual(reverted!.payload.regressedOutcomes, ["lead-metric"]);

    // Baseline cleared on revert; revert counter incremented.
    const loaded = await loadBaseline(sha);
    assert.equal((loaded as any).baseline, null);
    assert.equal(await getRevertCount(day), 1);

    // AC3 end-to-end: the Holdback revert path (the sole revert authority)
    // registers the reverted merge on the attribution reverted-merge registry
    // so the recorder chore (#2632) later voids this PR's ledger rows. Before
    // this remediation markMergeReverted was never called, so a Holdback revert
    // left phantom credit in the ledger (the #2642 QA-FAIL blocker).
    const reg = await listRevertedMerges();
    assert.equal(reg.ok, true);
    const entry = (reg as any).reverts.find(
      (rv: any) => rv.commitSha === sha || rv.prNumber === 42,
    );
    assert.ok(entry, "Holdback revert must register the merge for attribution void (AC3)");
    assert.equal(entry.commitSha, sha);
    assert.equal(entry.prNumber, 42);
    assert.equal(typeof entry.revertedAt, "number");

    // Cleanup the registry entry so sibling live-Redis suites start clean.
    await removeRevertedMerge({ commitSha: sha, prNumber: 42 });
    await _resetRevertCount(day);
  });

  test("favorable move within window does not revert (watching)", async (t) => {
    if (!guard(t)) return;
    const enrollPath = await leadingYaml("fav.txt", 0.5);
    const sha = "favsha01";
    await enrollHoldback({ commitSha: sha, tier: 2, outcomesFile: enrollPath });
    await writeFile(join(tmpDir, "fav.txt"), "0.9"); // favorable rise
    const { bus, events } = captureBus();
    const res = await checkHoldback(bus, { commitSha: sha, outcomesFile: enrollPath });
    assert.equal((res as any).result.decision, "watching");
    assert.equal(events.length, 0, "no event on a clean check");
    await redis.del(holdbackBaselineKey(sha));
  });

  test("per-day cap suppresses revert and emits holdback.cap-reached", async (t) => {
    if (!guard(t)) return;
    const day = utcDateKey();
    await _resetRevertCount(day);
    // Pre-load the cap counter to the limit (default 3).
    await redis.set(`hydra:holdback:reverts:${day}`, "3");

    const enrollPath = await leadingYaml("cap.txt", 0.5);
    const sha = "capsha01";
    await enrollHoldback({ commitSha: sha, tier: 2, outcomesFile: enrollPath });
    await writeFile(join(tmpDir, "cap.txt"), "0.1"); // regress

    const { bus, events } = captureBus();
    const res = await checkHoldback(bus, { commitSha: sha, outcomesFile: enrollPath });
    assert.equal((res as any).result.decision, "cap-reached");
    assert.ok(events.find((e) => e.type === "holdback.cap-reached"), "must emit cap-reached");
    assert.ok(!events.find((e) => e.type === "holdback.reverted"), "must NOT revert past cap");
    await redis.del(holdbackBaselineKey(sha));
    await _resetRevertCount(day);
  });

  test("check with no enrollment is a no-op", async (t) => {
    if (!guard(t)) return;
    const { bus, events } = captureBus();
    const res = await checkHoldback(bus, { commitSha: "neverenrolled99" });
    assert.equal((res as any).result.decision, "no-enrollment");
    assert.equal(events.length, 0);
  });

  test("reportRevertFailed emits holdback.revert_failed", async (t) => {
    if (!guard(t)) return;
    const { bus, events } = captureBus();
    await reportRevertFailed(bus, "failsha01", "git push rejected");
    const ev = events.find((e) => e.type === "holdback.revert_failed");
    assert.ok(ev, "must emit holdback.revert_failed (the name digest.ts reads)");
    assert.equal(ev!.payload.commitSha, "failsha01");
  });
});

// ---------------------------------------------------------------------------
// Pending-enroll registry (issue #2622)
//
// NEW top-level describe with its OWN before/after lifecycle — do NOT nest
// inside "Outcome Holdback producer": a describe's after() disconnects its
// Redis before sibling top-level suites run, so nesting here would flake this
// suite against a torn-down connection (CLAUDE.md nested-teardown pitfall).
// Per-case isolation via beforeEach (fresh key each case), not before.
// ---------------------------------------------------------------------------

describe("Outcome Holdback pending-enroll registry (#2622)", () => {
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
      try { await redis.quit(); } catch { /* intentional: best-effort close */ }
    }
  });

  // Fresh registry per case so sibling cases can't leak entries into each other.
  beforeEach(async () => {
    if (redisUp) await _resetPendingEnroll();
  });

  function guard(t: any): boolean {
    if (!redisUp) {
      t.skip("Redis unavailable at localhost:6379/1");
      return false;
    }
    return true;
  }

  test("add + list roundtrips the entry with tier and cycleId", async (t) => {
    if (!guard(t)) return;
    const add = await pendingEnrollAdd({ prNumber: 101, tier: 3, cycleId: "cyc-a", registeredAt: 111 });
    assert.equal(add.ok, true);

    const listed = await pendingEnrollList();
    assert.equal(listed.ok, true);
    const entries = (listed as any).entries;
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { prNumber: 101, tier: 3, cycleId: "cyc-a", registeredAt: 111 });
  });

  test("duplicate add for same prNumber is idempotent (updated in place)", async (t) => {
    if (!guard(t)) return;
    await pendingEnrollAdd({ prNumber: 202, tier: 2, cycleId: "first", registeredAt: 1 });
    await pendingEnrollAdd({ prNumber: 202, tier: 4, cycleId: "second", registeredAt: 2 });

    const listed = await pendingEnrollList();
    const entries = (listed as any).entries;
    assert.equal(entries.length, 1, "same prNumber must not append a duplicate");
    assert.equal(entries[0].tier, 4, "fields must be overwritten in place");
    assert.equal(entries[0].cycleId, "second");
    assert.equal(entries[0].registeredAt, 2);
  });

  test("list returns all entries sorted by prNumber; tier may be null", async (t) => {
    if (!guard(t)) return;
    await pendingEnrollAdd({ prNumber: 303, tier: null, cycleId: "c3", registeredAt: 30 });
    await pendingEnrollAdd({ prNumber: 111, tier: 2, cycleId: "c1", registeredAt: 10 });

    const listed = await pendingEnrollList();
    const entries = (listed as any).entries;
    assert.deepEqual(entries.map((e: any) => e.prNumber), [111, 303]);
    assert.equal(entries[1].tier, null);
  });

  test("remove drops the entry", async (t) => {
    if (!guard(t)) return;
    await pendingEnrollAdd({ prNumber: 404, tier: 3, cycleId: "c4", registeredAt: 40 });
    await pendingEnrollRemove(404);

    const listed = await pendingEnrollList();
    assert.deepEqual((listed as any).entries, []);
  });

  test("list on an empty registry returns []", async (t) => {
    if (!guard(t)) return;
    const listed = await pendingEnrollList();
    assert.equal(listed.ok, true);
    assert.deepEqual((listed as any).entries, []);
  });

  test("add rejects a non-positive prNumber without touching the store", async (t) => {
    if (!guard(t)) return;
    const bad = await pendingEnrollAdd({ prNumber: 0, tier: 2, cycleId: "c0", registeredAt: 1 });
    assert.equal(bad.ok, false);
    const listed = await pendingEnrollList();
    assert.deepEqual((listed as any).entries, []);
  });
});

// ---------------------------------------------------------------------------
// Merge-completion watcher chore (#2623) — pure decision logic.
//
// All external touchpoints are injected as in-memory fakes, so this suite runs
// WITHOUT gh or a live Redis. It exercises the acceptance criteria directly:
// landed→enroll+enrich (AC1), still-open→left (AC2), idempotent across ticks
// (AC3), T1/unknown dropped without enrolling (AC4), never-throws on failure
// (AC5). The observability read/write (AC6) is covered by the live-Redis suite
// below. No Redis connection ⇒ no teardown ⇒ no shared-connection flake.
// ---------------------------------------------------------------------------

/** Build a fake dep harness around an in-memory pending registry + marker set. */
function makeWatchHarness(
  pending: Array<{ prNumber: number; tier: number | null; cycleId: string; registeredAt: number }>,
  merge: Record<number, MergeStatus | null>,
) {
  const registry = new Map(pending.map((e) => [e.prNumber, e]));
  const marked = new Set<number>();
  const enrollCalls: Array<{ commitSha: string; prNumber?: number | null; tier?: number | null }> = [];
  const cycleCalls: Array<{ cycleId: string; prNumber: number; filesChanged?: number }> = [];
  const removeCalls: number[] = [];
  const healthWrites: any[] = [];

  const deps: HoldbackMergeWatchDeps = {
    listPending: async () => ({ ok: true as const, entries: [...registry.values()].sort((a, b) => a.prNumber - b.prNumber) }),
    removePending: async (prNumber: number) => { removeCalls.push(prNumber); registry.delete(prNumber); },
    wasEnrolled: async (prNumber: number) => marked.has(prNumber),
    mark: async (prNumber: number) => { marked.add(prNumber); return { ok: true as const }; },
    fetchMergeStatus: async (prNumber: number) => merge[prNumber] ?? null,
    enroll: async (input: any) => {
      enrollCalls.push(input);
      // Mirror the real server-side carry-up: T2/T3/T4 enroll, T1/null do not.
      if (input.tier == null || !(input.tier >= 2 && input.tier <= 4)) {
        return { ok: true as const, enrolled: false as const, reason: "exempt" };
      }
      return { ok: true as const, enrolled: true as const, leadingCount: 1, baseline: {} as any };
    },
    recordCycleRecord: async (body: any) => {
      cycleCalls.push(body);
      return { ok: true as const, cycleId: body.cycleId, status: "completed", bucketed: null, deduped: true, enriched: true };
    },
    setHealth: async (rec: any) => { healthWrites.push(rec); },
  };

  return { deps, registry, marked, enrollCalls, cycleCalls, removeCalls, healthWrites };
}

describe("Merge-completion watcher chore (#2623) — decision logic (no Redis)", () => {
  test("AC1: a landed T3 PR enrolls with the merge SHA + tier and enriches the cycle record", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 501, tier: 3, cycleId: "cyc-501", registeredAt: 1 }],
      { 501: { state: "MERGED", mergeCommitSha: "abc1234def", changedFiles: 7 } },
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.landed, 1);
    assert.deepEqual(h.enrollCalls, [{ commitSha: "abc1234def", prNumber: 501, tier: 3 }]);
    assert.deepEqual(h.cycleCalls, [{ cycleId: "cyc-501", prNumber: 501, filesChanged: 7 }]);
    assert.deepEqual(h.removeCalls, [501], "landed entry is dropped from the registry");
    assert.equal(h.registry.has(501), false);
  });

  test("AC2: a still-open PR (no merge commit) is left in the registry and NOT enrolled", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 502, tier: 3, cycleId: "cyc-502", registeredAt: 1 }],
      { 502: { state: "OPEN", mergeCommitSha: null, changedFiles: null } },
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.stillOpen, 1);
    assert.equal(res.landed, 0);
    assert.deepEqual(h.enrollCalls, []);
    assert.deepEqual(h.removeCalls, []);
    assert.equal(h.registry.has(502), true, "still-open entry survives for a later tick");
  });

  test("AC3: enroll + enrichment fire at most once per PR across repeated ticks", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 503, tier: 2, cycleId: "cyc-503", registeredAt: 1 }],
      { 503: { state: "MERGED", mergeCommitSha: "deadbeef99", changedFiles: 2 } },
    );

    await runHoldbackMergeWatch(h.deps);
    // Re-add the SAME entry (simulate a prior tick's pendingEnrollRemove having
    // failed, so the entry is re-observed on the next tick) and run again.
    h.registry.set(503, { prNumber: 503, tier: 2, cycleId: "cyc-503", registeredAt: 1 });
    await runHoldbackMergeWatch(h.deps);

    assert.equal(h.enrollCalls.length, 1, "enroll fires exactly once (marker short-circuits the re-fire)");
    assert.equal(h.cycleCalls.length, 1, "cycle-record enrichment fires exactly once");
    assert.equal(h.registry.has(503), false, "the re-observed stale entry is still dropped");
  });

  test("AC4: a landed T1 PR is dropped from the registry WITHOUT a baseline being enrolled", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 504, tier: 1, cycleId: "cyc-504", registeredAt: 1 }],
      { 504: { state: "MERGED", mergeCommitSha: "f00dcafe11", changedFiles: 1 } },
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.droppedExempt, 1, "T1 landing is a drop, not a landed enrollment");
    assert.equal(res.landed, 0);
    // enroll IS called (the server-side exemption lives inside enrollHoldback),
    // but it returns enrolled:false — no baseline persisted for a T1 merge.
    assert.equal(h.enrollCalls.length, 1);
    assert.deepEqual(h.removeCalls, [504]);
    assert.equal(h.registry.has(504), false);
  });

  test("AC4: an unknown-tier (null) landed PR is likewise dropped without enrolling", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 505, tier: null, cycleId: "cyc-505", registeredAt: 1 }],
      { 505: { state: "MERGED", mergeCommitSha: "aaaabbbbcc", changedFiles: 0 } },
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.droppedExempt, 1);
    assert.equal(res.landed, 0);
    assert.deepEqual(h.removeCalls, [505]);
  });

  test("AC5: a gh/API fetch failure leaves the entry in the registry to retry next tick (never throws)", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 506, tier: 3, cycleId: "cyc-506", registeredAt: 1 }],
      { 506: null }, // fetchMergeStatus returns null → treated as transient failure
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.retried, 1);
    assert.equal(res.landed, 0);
    assert.deepEqual(h.enrollCalls, [], "no enroll on a fetch failure");
    assert.equal(h.registry.has(506), true, "the entry survives for the next tick");
  });

  test("AC5: an entry whose enroll returns a hard error is left to retry, not dropped", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 507, tier: 3, cycleId: "cyc-507", registeredAt: 1 }],
      { 507: { state: "MERGED", mergeCommitSha: "111222333c", changedFiles: 4 } },
    );
    // Override enroll to fail hard.
    h.deps.enroll = async () => ({ ok: false as const, error: "boom" });

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.retried, 1);
    assert.equal(res.landed, 0);
    assert.deepEqual(h.removeCalls, [], "entry is NOT dropped when enroll fails");
    assert.deepEqual(h.cycleCalls, [], "enrichment is not attempted after an enroll failure");
    assert.equal(h.registry.has(507), true);
  });

  test("AC5: a throwing dep for one PR does not abort processing of the others", async () => {
    const h = makeWatchHarness(
      [
        { prNumber: 508, tier: 3, cycleId: "cyc-508", registeredAt: 1 },
        { prNumber: 509, tier: 3, cycleId: "cyc-509", registeredAt: 2 },
      ],
      {
        508: { state: "MERGED", mergeCommitSha: "aaa", changedFiles: 1 },
        509: { state: "MERGED", mergeCommitSha: "bbbbbbb", changedFiles: 3 },
      },
    );
    const realFetch = h.deps.fetchMergeStatus!;
    h.deps.fetchMergeStatus = async (pr: number) => {
      if (pr === 508) throw new Error("kaboom");
      return realFetch(pr);
    };

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.retried, 1, "508 throws → retried");
    assert.equal(res.landed, 1, "509 still lands despite 508 throwing");
    assert.deepEqual(h.removeCalls, [509]);
  });

  test("a landed enrolled-tier PR with no changedFiles still enrolls (filesChanged omitted)", async () => {
    const h = makeWatchHarness(
      [{ prNumber: 510, tier: 4, cycleId: "cyc-510", registeredAt: 1 }],
      { 510: { state: "MERGED", mergeCommitSha: "c0ffee1234", changedFiles: null } },
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.landed, 1);
    assert.deepEqual(h.cycleCalls, [{ cycleId: "cyc-510", prNumber: 510 }], "no filesChanged key when the view didn't report one");
  });

  test("summary counts + a health snapshot are produced every run", async () => {
    const h = makeWatchHarness(
      [
        { prNumber: 520, tier: 3, cycleId: "c520", registeredAt: 1 }, // lands
        { prNumber: 521, tier: 3, cycleId: "c521", registeredAt: 2 }, // still open
        { prNumber: 522, tier: 1, cycleId: "c522", registeredAt: 3 }, // dropped exempt
      ],
      {
        520: { state: "MERGED", mergeCommitSha: "s520", changedFiles: 2 },
        521: { state: "OPEN", mergeCommitSha: null, changedFiles: null },
        522: { state: "MERGED", mergeCommitSha: "s522", changedFiles: 1 },
      },
    );

    const res = await runHoldbackMergeWatch(h.deps);

    assert.equal(res.pendingDepth, 3);
    assert.equal(res.landed, 1);
    assert.equal(res.stillOpen, 1);
    assert.equal(res.droppedExempt, 1);
    assert.equal(h.healthWrites.length, 1);
    assert.equal(h.healthWrites[0].pendingDepth, 3);
    assert.equal(h.healthWrites[0].landed, 1);
    assert.equal(typeof h.healthWrites[0].ranAt, "string");
  });
});

// ---------------------------------------------------------------------------
// Merge-completion watcher (#2623) — Redis-backed marker + health accessors.
//
// NEW top-level describe with its OWN before/after lifecycle (CLAUDE.md
// nested-teardown pitfall). Per-case isolation via beforeEach. Covers AC6 (the
// health snapshot is readable from Redis) + the per-PR enrolled marker seam.
// ---------------------------------------------------------------------------

describe("Merge-completion watcher (#2623) — marker + health (Redis)", () => {
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
      try { await redis.quit(); } catch { /* intentional: best-effort close */ }
    }
  });

  beforeEach(async () => {
    if (redisUp) {
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

  test("markEnrolled → wasEnrolledMarked roundtrips per PR", async (t) => {
    if (!guard(t)) return;
    assert.equal(await wasEnrolledMarked(701), false, "unmarked PR reads false");
    const m = await markEnrolled(701, "sha701abc");
    assert.equal(m.ok, true);
    assert.equal(await wasEnrolledMarked(701), true, "marked PR reads true");
    assert.equal(await wasEnrolledMarked(702), false, "a different PR stays false");
  });

  test("setMergeWatchHealth → getMergeWatchHealth roundtrips the snapshot (AC6)", async (t) => {
    if (!guard(t)) return;
    assert.equal(await getMergeWatchHealth(), null, "no record before the first write");
    await setMergeWatchHealth({
      ranAt: "2026-07-01T00:00:00.000Z",
      pendingDepth: 5,
      landed: 2,
      droppedExempt: 1,
      stillOpen: 2,
    });
    const got = await getMergeWatchHealth();
    assert.equal(got?.pendingDepth, 5);
    assert.equal(got?.landed, 2);
    assert.equal(got?.ranAt, "2026-07-01T00:00:00.000Z");
  });

  test("end-to-end against live Redis: the per-PR marker makes the run idempotent", async (t) => {
    if (!guard(t)) return;
    // Seed a landed T3 PR into the REAL pending registry, then run the watcher
    // twice with a fake gh + fake enroll/cycle but the REAL Redis marker/registry
    // accessors. The second run must be a no-op.
    await pendingEnrollAdd({ prNumber: 710, tier: 3, cycleId: "cyc-710", registeredAt: 1 });

    const enrollCalls: any[] = [];
    const cycleCalls: any[] = [];
    const deps: HoldbackMergeWatchDeps = {
      fetchMergeStatus: async () => ({ state: "MERGED", mergeCommitSha: "sha710xyz", changedFiles: 3 }),
      enroll: async (input: any) => { enrollCalls.push(input); return { ok: true as const, enrolled: true as const, leadingCount: 1, baseline: {} as any }; },
      recordCycleRecord: async (body: any) => { cycleCalls.push(body); return { ok: true as const, cycleId: body.cycleId, status: "completed", bucketed: null, deduped: true, enriched: true }; },
      // Real Redis accessors for listPending/removePending/wasEnrolled/mark/setHealth (defaults).
    };

    await runHoldbackMergeWatch(deps);
    // Re-add the same entry (simulate the remove being lost) and re-run.
    await pendingEnrollAdd({ prNumber: 710, tier: 3, cycleId: "cyc-710", registeredAt: 1 });
    await runHoldbackMergeWatch(deps);

    assert.equal(enrollCalls.length, 1, "enroll fired exactly once across two ticks");
    assert.equal(cycleCalls.length, 1, "enrichment fired exactly once across two ticks");
    assert.equal(await wasEnrolledMarked(710), true);
    const listed = await pendingEnrollList();
    assert.deepEqual((listed as any).entries, [], "the re-observed entry is dropped again");
  });
});
