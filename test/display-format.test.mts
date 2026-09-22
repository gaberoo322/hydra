/**
 * test/display-format.test.mts — the dashboard's canonical token-count and
 * duration formatters (issue #4564).
 *
 * dashboard/src/lib/display-format.ts is the ONE home of token abbreviation
 * and compound h/m/s duration math; autopilot-format.js, runs-state.js,
 * console-format.ts, CostPanel.jsx and UsagePanel.jsx all delegate to it.
 * Pure and DOM-free, so it is pinned here in the orchestrator suite — same
 * pattern as relative-time-format.test.mts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatTokens, formatDuration } from "../dashboard/src/lib/display-format.ts";
import * as consoleFormat from "../dashboard/src/pages/now-console/console-format.ts";
import { formatRunDuration } from "../dashboard/src/components/pages/runs/runs-state.js";

function src(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

test("formatTokens: canonical K/M table", () => {
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(814_897), "815K");
  assert.equal(formatTokens(1234), "1K");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(512), "512");
  assert.equal(formatTokens(12.6), "13");
  assert.equal(formatTokens(-2_500_000), "-2.5M");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatTokens(undefined), "—");
  assert.equal(formatTokens(Number.NaN), "—");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "—");
});

test("formatDuration seconds precision: every smaller unit rendered, zeros included", () => {
  assert.equal(formatDuration(0, { precision: "seconds" }), "0s");
  assert.equal(formatDuration(45, { precision: "seconds" }), "45s");
  assert.equal(formatDuration(125, { precision: "seconds" }), "2m 5s");
  assert.equal(formatDuration(3723, { precision: "seconds" }), "1h 2m 3s");
  assert.equal(formatDuration(3600, { precision: "seconds" }), "1h 0m 0s");
  assert.equal(formatDuration(45.9, { precision: "seconds" }), "45s");
});

test("formatDuration minutes precision: floored, zero minutes rendered", () => {
  assert.equal(formatDuration(0, { precision: "minutes" }), "0m");
  assert.equal(formatDuration(59, { precision: "minutes" }), "0m");
  assert.equal(formatDuration(707, { precision: "minutes" }), "11m");
  assert.equal(formatDuration(3599, { precision: "minutes" }), "59m");
  assert.equal(formatDuration(3600, { precision: "minutes" }), "1h 0m");
  assert.equal(formatDuration(3660, { precision: "minutes" }), "1h 1m");
});

test("formatDuration: non-number / non-finite / negative → em dash", () => {
  for (const precision of ["seconds", "minutes"] as const) {
    assert.equal(formatDuration(null, { precision }), "—");
    assert.equal(formatDuration(undefined, { precision }), "—");
    assert.equal(formatDuration(Number.NaN, { precision }), "—");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY, { precision }), "—");
    assert.equal(formatDuration(-5, { precision }), "—");
    assert.equal(formatDuration("60" as any, { precision }), "—");
  }
});

test("wrappers delegate: console-format re-exports formatTokens by identity, runs-state uses minutes precision", () => {
  assert.equal(consoleFormat.formatTokens, formatTokens);
  assert.equal(formatRunDuration(3600), formatDuration(3600, { precision: "minutes" }));
  assert.equal(consoleFormat.formatDuration(45), "45s");
  assert.equal(consoleFormat.formatDuration(5400), "1h 30m");
});

test("display-format.ts is pure: no React, no clock, no import.meta, no lib→pages edge", async () => {
  const code = await src("../dashboard/src/lib/display-format.ts");
  const body = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(body, /from\s+["']react["']/);
  assert.doesNotMatch(body, /Date\.now\(/);
  assert.doesNotMatch(body, /import\.meta/);
  assert.doesNotMatch(body, /pages\//);
});

test("no in-scope caller keeps its own token or h/m/s bucket arithmetic", async () => {
  const files = [
    "../dashboard/src/lib/autopilot-format.js",
    "../dashboard/src/components/pages/runs/runs-state.js",
    "../dashboard/src/pages/now-console/console-format.ts",
    "../dashboard/src/components/pages/health/CostPanel.jsx",
    "../dashboard/src/pages/now-console/UsagePanel.jsx",
  ];
  for (const f of files) {
    const code = await src(f);
    assert.doesNotMatch(code, /\/\s*3600\b/, `${f} divides by 3600`);
    assert.doesNotMatch(code, /%\s*3600\b/, `${f} buckets by 3600`);
    assert.doesNotMatch(code, /\/\s*1_?000_?000\b/, `${f} divides by 1e6`);
    assert.doesNotMatch(code, /function\s+fmtTokens\b/, `${f} keeps a local fmtTokens`);
  }
  const usage = await src("../dashboard/src/pages/now-console/UsagePanel.jsx");
  assert.match(usage, /resets in \$\{formatDuration\(diffSec, \{ precision: "minutes" \}\)\}/);
  assert.match(usage, /"resets now"/);
});
