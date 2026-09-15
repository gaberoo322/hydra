/**
 * test/now-console-status-verdict-state.test.mts — the /now hero's composite
 * status verdict (issue #891, now-console-4, parent #887; carried verbatim
 * from test/now-console-state.test.mts when #4382 split the module into
 * concern-scoped leaves).
 *
 * The dashboard ships no JSX test runner and deliberately will not adopt one
 * (issue #3706), so the verdict derivation lives in the pure
 * dashboard/src/pages/now-console/status-verdict-state.ts leaf and is pinned
 * here in the orchestrator suite — the same pattern as
 * now-pixel-oak-tab-state.test.mts.
 *
 * Covers:
 *   - composite verdict resolution (RUNNING / IDLE / STUCK / CRASHED) and its
 *     precedence rules
 *   - stuck-signal ranking
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT_RUNNING,
  VERDICT_IDLE,
  VERDICT_STUCK,
  VERDICT_CRASHED,
  VERDICT_PAUSED,
  rankStuckSignals,
  resolveVerdict,
} from "../dashboard/src/pages/now-console/status-verdict-state.ts";

// ---------------------------------------------------------------------------
// Verdict resolution
// ---------------------------------------------------------------------------

test("resolveVerdict → CRASHED outranks everything when lifecycle crashed", () => {
  const r = resolveVerdict({
    lifecycle: { state: "crashed", termReason: "oom" },
    signals: [{ type: "unproductive-loop", severity: "critical", summary: "loop" }],
  });
  assert.equal(r.verdict, VERDICT_CRASHED);
  assert.match(r.fact, /oom/);
});

test("resolveVerdict → STUCK when a warn/critical signal exists even if running", () => {
  const r = resolveVerdict({
    lifecycle: { state: "running", runId: "abc123" },
    signals: [
      {
        type: "unproductive-loop",
        severity: "warn",
        summary: "19 dispatches, 0 merges",
      },
    ],
  });
  assert.equal(r.verdict, VERDICT_STUCK);
  assert.equal(r.fact, "19 dispatches, 0 merges");
  assert.ok(r.signal);
  assert.equal(r.signal?.type, "unproductive-loop");
});

test("resolveVerdict → info-only signals do NOT force STUCK", () => {
  const r = resolveVerdict({
    lifecycle: { state: "running", runId: "deadbeef00" },
    signals: [{ type: "idle-streak", severity: "info", summary: "fyi" }],
  });
  assert.equal(r.verdict, VERDICT_RUNNING);
  assert.match(r.fact, /deadbeef/);
});

test("resolveVerdict → RUNNING when running and no actionable signal", () => {
  const r = resolveVerdict({ lifecycle: { state: "running", runId: "1234567890" }, signals: [] });
  assert.equal(r.verdict, VERDICT_RUNNING);
  assert.match(r.fact, /1234567/);
});

test("resolveVerdict → IDLE surfaces the pace-gate block reason", () => {
  const r = resolveVerdict({
    lifecycle: { state: "idle", runId: null },
    signals: [],
    idle: { isEligible: false, blockedBy: "running" },
  });
  assert.equal(r.verdict, VERDICT_IDLE);
  assert.match(r.fact, /pace gate blocked by: running/);
});

test("resolveVerdict → IDLE for a clean ended state without diagnostics", () => {
  const r = resolveVerdict({ lifecycle: { state: "ended" }, signals: [] });
  assert.equal(r.verdict, VERDICT_IDLE);
  assert.match(r.fact, /ended cleanly/);
});

test("resolveVerdict tolerates empty/missing input", () => {
  const r = resolveVerdict({});
  assert.equal(r.verdict, VERDICT_IDLE);
});

// ---------------------------------------------------------------------------
// PAUSED verdict (issue #989) — operator pause outranks EVERYTHING.
// ---------------------------------------------------------------------------

test("resolveVerdict → PAUSED outranks a live RUNNING session (draining copy)", () => {
  const r = resolveVerdict({
    lifecycle: { state: "running", runId: "abc12345" },
    signals: [],
    paused: { paused: true, since: 1 },
  });
  assert.equal(r.verdict, VERDICT_PAUSED);
  // While a run is still live, the fact reads "draining…".
  assert.match(r.fact, /draining/i);
});

test("resolveVerdict → PAUSED settles to a quiet fact when no live run", () => {
  const r = resolveVerdict({
    lifecycle: { state: "idle" },
    signals: [],
    paused: { paused: true },
  });
  assert.equal(r.verdict, VERDICT_PAUSED);
  assert.doesNotMatch(r.fact, /draining/i);
  assert.match(r.fact, /PAUSED/);
});

test("resolveVerdict → PAUSED outranks CRASHED and STUCK", () => {
  const crashed = resolveVerdict({
    lifecycle: { state: "crashed", termReason: "oom" },
    paused: { paused: true },
  });
  assert.equal(crashed.verdict, VERDICT_PAUSED);

  const stuck = resolveVerdict({
    lifecycle: { state: "running" },
    signals: [{ type: "unproductive-loop", severity: "critical", summary: "loop" }],
    paused: { paused: true },
  });
  assert.equal(stuck.verdict, VERDICT_PAUSED);
});

test("resolveVerdict → paused:false (or absent flag) does NOT force PAUSED", () => {
  const explicit = resolveVerdict({
    lifecycle: { state: "running", runId: "deadbeef" },
    signals: [],
    paused: { paused: false },
  });
  assert.equal(explicit.verdict, VERDICT_RUNNING);

  const absent = resolveVerdict({
    lifecycle: { state: "running", runId: "deadbeef" },
    signals: [],
  });
  assert.equal(absent.verdict, VERDICT_RUNNING);
});

// ---------------------------------------------------------------------------
// Stuck-signal ranking
// ---------------------------------------------------------------------------

test("rankStuckSignals orders critical > warn > info, stable within tie", () => {
  const ranked = rankStuckSignals([
    { type: "a", severity: "info" },
    { type: "b", severity: "critical" },
    { type: "c", severity: "warn" },
    { type: "d", severity: "critical" },
  ]);
  assert.deepEqual(
    ranked.map((s) => s.type),
    ["b", "d", "c", "a"],
  );
});

test("rankStuckSignals handles non-array / unknown severity", () => {
  assert.deepEqual(rankStuckSignals(null), []);
  assert.deepEqual(rankStuckSignals(undefined), []);
  const ranked = rankStuckSignals([
    { type: "x", severity: "bogus" },
    { type: "y", severity: "warn" },
  ]);
  assert.deepEqual(
    ranked.map((s) => s.type),
    ["y", "x"],
  );
});
