/**
 * test/now-console-usage-panel-state.test.mts — the UsagePanel's pace +
 * attribution derivations (issue #891, now-console-4, parent #887; carried
 * verbatim from test/now-console-state.test.mts when #4382 split the module
 * into concern-scoped leaves).
 *
 * The dashboard ships no JSX test runner and deliberately will not adopt one
 * (issue #3706), so the derivations live in the pure
 * dashboard/src/pages/now-console/usage-panel-state.ts leaf and are pinned
 * here in the orchestrator suite — the same pattern as
 * now-pixel-oak-tab-state.test.mts.
 *
 * Covers:
 *   - weekly-pace classification (ahead / on / behind, ± tolerance)
 *   - attribution-table flattening (drop zero rows, sort by total desc)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPace,
  flattenAttribution,
} from "../dashboard/src/pages/now-console/usage-panel-state.ts";

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
// Attribution flattening
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
