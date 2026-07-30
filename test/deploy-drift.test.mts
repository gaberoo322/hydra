/**
 * Tests for the deployed-build drift check pure logic (issue #2663).
 *
 * Covers:
 *   - shortSha normalisation (whitespace, case, `v`-free hex, junk -> null).
 *   - shasMatch prefix comparison (full vs abbreviated forms).
 *   - classifyDrift branches:
 *       * in-sync (equal SHAs)
 *       * settling (drift inside the grace window — a deploy is mid-flight)
 *       * drift (sustained past the grace window — LOUD / critical)
 *       * unknown (deployed unavailable / origin unresolved / both)
 *   - dirty-tree probable-cause note surfacing on drift.
 *   - alert message shape.
 *
 * The driver script `scripts/deploy-drift-check.ts` is exercised ONLY on its
 * alert-emit path (the `--alert` suite at the bottom): that path was re-routed
 * through the typed `pushAlert` seam in #3743, so it no longer depends on
 * subprocess/docker I/O and is safe to drive against Redis. The rest of the
 * driver — subprocess (git) + network (fetch) I/O — stays untested: every one
 * of those paths fails closed to `null`, and the classifier turns `null` into
 * the `unknown` verdict, so an integration test would only re-prove the unit
 * branches above.
 */
import test, { describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  shortSha,
  shasMatch,
  classifyDrift,
  buildDriftAlertMessage,
  DEFAULT_DRIFT_GRACE_SECONDS,
} from "../scripts/deploy-drift-logic.ts";
import { emitAlert } from "../scripts/deploy-drift-check.ts";
import { readAllAlerts, clearAlerts } from "../src/redis/alerts.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

// The driver's `emitAlert` routes through the `pushAlert` seam, which lazily
// opens an ioredis connection. The test runner injects an isolated DB via
// REDIS_URL; fall back to localhost DB 1 (same pattern as
// scout-alert-listener.test.mts).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const SHA_A_FULL = "228b6e5000000000000000000000000000000000";
const SHA_B_FULL = "b586b13000000000000000000000000000000000";

describe("shortSha", () => {
  test("normalises a full 40-char SHA to 12 chars, lowercased", () => {
    assert.equal(shortSha(SHA_A_FULL.toUpperCase()), "228b6e500000");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(shortSha("  228b6e5\n"), "228b6e5");
  });

  test("accepts a 7-char abbreviated SHA", () => {
    assert.equal(shortSha("228b6e5"), "228b6e5");
  });

  test("returns null for null / empty / non-hex junk", () => {
    assert.equal(shortSha(null), null);
    assert.equal(shortSha(undefined), null);
    assert.equal(shortSha(""), null);
    assert.equal(shortSha("not-a-sha"), null);
    assert.equal(shortSha("12345"), null); // too short (< 7)
    assert.equal(shortSha("ghijklm"), null); // non-hex
  });
});

describe("shasMatch", () => {
  test("matches full vs abbreviated of the same commit (prefix compare)", () => {
    assert.equal(shasMatch(shortSha(SHA_A_FULL)!, "228b6e5"), true);
  });

  test("does not match different commits", () => {
    assert.equal(shasMatch(shortSha(SHA_A_FULL)!, shortSha(SHA_B_FULL)!), false);
  });

  test("empty operands never match", () => {
    assert.equal(shasMatch("", "228b6e5"), false);
  });
});

describe("classifyDrift — in-sync", () => {
  test("equal SHAs -> in-sync / info", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_A_FULL);
    assert.equal(r.verdict, "in-sync");
    assert.equal(r.severity, "info");
    assert.equal(r.driftAgeSeconds, 0);
    assert.match(r.message, /in sync/);
  });

  test("full deployed vs abbreviated remote of same commit -> in-sync", () => {
    const r = classifyDrift(SHA_A_FULL, "228b6e5");
    assert.equal(r.verdict, "in-sync");
  });
});

describe("classifyDrift — settling (drift within grace)", () => {
  test("drift younger than the grace window is settling / info, not LOUD", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 60,
      graceSeconds: 900,
    });
    assert.equal(r.verdict, "settling");
    assert.equal(r.severity, "info");
    assert.equal(r.driftAgeSeconds, 60);
    assert.match(r.message, /mid-flight/);
  });

  test("uses the default grace window when none is given", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: DEFAULT_DRIFT_GRACE_SECONDS - 1,
    });
    assert.equal(r.verdict, "settling");
  });
});

describe("classifyDrift — drift (sustained past grace) is LOUD", () => {
  test("drift older than the grace window -> drift / critical", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 1800,
      graceSeconds: 900,
    });
    assert.equal(r.verdict, "drift");
    assert.equal(r.severity, "critical");
    assert.equal(r.driftAgeSeconds, 1800);
    assert.match(r.message, /STALE/);
    assert.match(r.message, /deploy\.sh/);
  });

  test("exactly at the grace boundary counts as sustained (>=)", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 900,
      graceSeconds: 900,
    });
    assert.equal(r.verdict, "drift");
  });

  test("surfaces a dirty-tree probable cause when detected", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 1800,
      graceSeconds: 900,
      dirtyTreePaths: ["docker/ov.conf"],
    });
    assert.equal(r.verdict, "drift");
    assert.ok(r.note, "expected a probable-cause note");
    assert.match(r.note!, /docker\/ov\.conf/);
    assert.match(r.note!, /dirty-tree guard/);
  });

  test("no cause note when the tree is clean", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 1800,
      graceSeconds: 900,
      dirtyTreePaths: [],
    });
    assert.equal(r.note, undefined);
  });
});

describe("classifyDrift — unknown (fail-safe, never alarming)", () => {
  test("deployed SHA unavailable (API unreachable) -> unknown / info", () => {
    const r = classifyDrift(null, SHA_B_FULL);
    assert.equal(r.verdict, "unknown");
    assert.equal(r.severity, "info");
    assert.equal(r.deployedSha, "?");
    assert.match(r.message, /health unreachable|unavailable/);
  });

  test("origin/master unresolved (detached origin) -> unknown / info", () => {
    const r = classifyDrift(SHA_A_FULL, null);
    assert.equal(r.verdict, "unknown");
    assert.equal(r.remoteSha, "?");
    assert.match(r.message, /origin\/master/);
  });

  test("both unresolved -> unknown", () => {
    const r = classifyDrift(null, null);
    assert.equal(r.verdict, "unknown");
    assert.equal(r.deployedSha, "?");
    assert.equal(r.remoteSha, "?");
  });

  test("garbage SHAs degrade to unknown, never throw", () => {
    const r = classifyDrift("not-a-sha", "also-junk");
    assert.equal(r.verdict, "unknown");
  });
});

describe("buildDriftAlertMessage", () => {
  test("produces a short operator-readable line", () => {
    const r = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 1800,
      graceSeconds: 900,
    });
    const msg = buildDriftAlertMessage(r);
    assert.match(msg, /stale code/);
    assert.match(msg, /228b6e5/);
    assert.match(msg, /b586b13/);
  });
});

// ===========================================================================
// Driver --alert emit (issue #3743). The `emitAlert` path must push a REAL,
// parseable alert through the `pushAlert` seam — never the empty string the
// prior `input`-on-async-execFile shell-out silently LPUSHed (which dropped
// the payload AND 500'd GET /api/alerts). This suite is a NEW top-level
// describe with its own Redis lifecycle (per the CLAUDE.md shared-Redis
// teardown pitfall): beforeEach clears `hydra:alerts`; after closes the
// singleton connection `pushAlert` opened.
// ===========================================================================

describe("scripts/deploy-drift-check.ts — emitAlert (issue #3743, Redis-backed)", () => {
  beforeEach(async () => {
    await clearAlerts();
  });

  after(() => {
    // Release the singleton ioredis connection pushAlert opened so the test
    // process exits cleanly (mirrors scout-alert-listener.test.mts teardown).
    closeRedisConnections();
  });

  test("pushes a real, parseable alert that round-trips the drift payload", async () => {
    const report = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 1800,
      graceSeconds: 900,
    });
    assert.equal(report.verdict, "drift", "precondition: sustained drift");

    await emitAlert(report);

    const all = await readAllAlerts();
    assert.equal(all.length, 1, "expected exactly one alert pushed");
    // The stored element must PARSE — the old shell-out silently LPUSHed "".
    const parsed = JSON.parse(all[0]);
    assert.equal(parsed.type, "deploy-drift");
    assert.equal(parsed.severity, "critical");
    assert.equal(parsed.dismissed, false);
    // Round-trip the payload fields — NOT just that the command exited 0 (an
    // exit-code-only assertion is exactly what let the bug ship; issue #3743).
    assert.equal(parsed.payload.deployedSha, report.deployedSha);
    assert.equal(parsed.payload.remoteSha, report.remoteSha);
    assert.equal(parsed.payload.driftAgeSeconds, report.driftAgeSeconds);
    assert.match(parsed.message, /stale code/);
    assert.match(parsed.message, /228b6e500000/);
    assert.match(parsed.message, /b586b1300000/);
  });

  test("never writes an empty string to hydra:alerts", async () => {
    const report = classifyDrift(SHA_A_FULL, SHA_B_FULL, {
      driftAgeSeconds: 1800,
      graceSeconds: 900,
    });
    await emitAlert(report);

    const all = await readAllAlerts();
    assert.equal(all.length, 1);
    for (const raw of all) {
      assert.ok(raw.length > 0, "no empty-string element may be stored");
      // Every entry must parse — GET /api/alerts and the scout reader
      // JSON.parse each one; an empty/corrupt element 500s the route.
      JSON.parse(raw);
    }
  });
});
