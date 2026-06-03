/**
 * test/now-console-state.test.mts — pure plumbing for the /now Console view
 * (issue #891, now-console-4, parent #887).
 *
 * The dashboard ships no JSX test runner (see
 * dashboard/test/recommendations-tab.test.jsx), so the load-bearing Console
 * derivations live in dashboard/src/pages/now-console/console-state.ts and are
 * pinned here in the orchestrator suite — the same pattern as
 * now-pixel-oak-tab-state.test.mts.
 *
 * Covers:
 *   - view-mode resolution (deep-link > localStorage > Console default)
 *   - composite verdict resolution (RUNNING / IDLE / STUCK / CRASHED) and its
 *     precedence rules
 *   - stuck-signal ranking, pace classification, attribution flattening
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOW_VIEW,
  NOW_VIEW_STORAGE_KEY,
  VIEW_CONSOLE,
  VIEW_HABITAT,
  VERDICT_RUNNING,
  VERDICT_IDLE,
  VERDICT_STUCK,
  VERDICT_CRASHED,
  classifyPace,
  flattenAttribution,
  formatRatio,
  formatTokens,
  isNowViewMode,
  rankStuckSignals,
  resolveNowView,
  resolveVerdict,
  writeStoredNowView,
} from "../dashboard/src/pages/now-console/console-state.ts";

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    _map: m,
  };
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

test("isNowViewMode accepts only the two known modes", () => {
  assert.equal(isNowViewMode(VIEW_CONSOLE), true);
  assert.equal(isNowViewMode(VIEW_HABITAT), true);
  assert.equal(isNowViewMode("nope"), false);
  assert.equal(isNowViewMode(null), false);
  assert.equal(isNowViewMode(undefined), false);
});

test("resolveNowView precedence: deep-link > localStorage > default", () => {
  const stored = memStorage({ [NOW_VIEW_STORAGE_KEY]: VIEW_HABITAT });

  // deep-link wins over a conflicting stored value
  assert.equal(resolveNowView(VIEW_CONSOLE, stored), VIEW_CONSOLE);
  // no deep-link → stored value
  assert.equal(resolveNowView(null, stored), VIEW_HABITAT);
  // no deep-link, no stored → Console default
  assert.equal(resolveNowView(null, memStorage()), DEFAULT_NOW_VIEW);
  assert.equal(DEFAULT_NOW_VIEW, VIEW_CONSOLE);
  // garbage deep-link is ignored, falls through to stored
  assert.equal(resolveNowView("garbage", stored), VIEW_HABITAT);
});

test("resolveNowView tolerates a throwing/absent storage", () => {
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
  };
  assert.equal(resolveNowView(null, throwing), DEFAULT_NOW_VIEW);
  assert.equal(resolveNowView(null, null), DEFAULT_NOW_VIEW);
  assert.equal(resolveNowView(VIEW_HABITAT, null), VIEW_HABITAT);
});

test("writeStoredNowView round-trips and swallows failures", () => {
  const s = memStorage();
  writeStoredNowView(s, VIEW_HABITAT);
  assert.equal(s.getItem(NOW_VIEW_STORAGE_KEY), VIEW_HABITAT);

  // Throwing storage must not propagate.
  const throwing = {
    setItem() {
      throw new Error("quota");
    },
  };
  assert.doesNotThrow(() => writeStoredNowView(throwing, VIEW_CONSOLE));
  assert.doesNotThrow(() => writeStoredNowView(null, VIEW_CONSOLE));
});

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

// ---------------------------------------------------------------------------
// Pace classification
// ---------------------------------------------------------------------------

test("classifyPace: ahead/on/behind around the target with tolerance", () => {
  assert.equal(classifyPace(90, 80), "ahead");
  assert.equal(classifyPace(81, 80), "on"); // within ±2
  assert.equal(classifyPace(80, 80), "on");
  assert.equal(classifyPace(70, 80), "behind");
  assert.equal(classifyPace(null, 80), "on"); // non-finite → neutral
  assert.equal(classifyPace(50, undefined), "on");
});

// ---------------------------------------------------------------------------
// Attribution + formatters
// ---------------------------------------------------------------------------

test("flattenAttribution drops zero rows and sorts by total desc", () => {
  const rows = flattenAttribution({
    "hydra-dev": { opus: { total: 100 }, sonnet: { total: 0 } },
    unattributed: { opus: { total: 500 }, haiku: { total: 50 } },
  });
  assert.deepEqual(rows, [
    { skill: "unattributed", model: "opus", total: 500 },
    { skill: "hydra-dev", model: "opus", total: 100 },
    { skill: "unattributed", model: "haiku", total: 50 },
  ]);
});

test("flattenAttribution tolerates null/garbage input", () => {
  assert.deepEqual(flattenAttribution(null), []);
  assert.deepEqual(flattenAttribution(undefined), []);
  assert.deepEqual(flattenAttribution({ s: null as never }), []);
});

test("formatTokens humanizes magnitudes", () => {
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(814_897), "815K");
  assert.equal(formatTokens(512), "512");
  assert.equal(formatTokens(null), "—");
});

test("formatRatio renders a 0..1 ratio as percent", () => {
  assert.equal(formatRatio(0.95), "95.0%");
  assert.equal(formatRatio(null), "—");
});
