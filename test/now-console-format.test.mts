/**
 * test/now-console-format.test.mts — the /now Console's shared display
 * formatters (issue #891, now-console-4, parent #887; carried verbatim from
 * test/now-console-state.test.mts when #4382 split the module into
 * concern-scoped leaves).
 *
 * The dashboard ships no JSX test runner and deliberately will not adopt one
 * (issue #3706), so the formatters live in the pure
 * dashboard/src/pages/now-console/console-format.ts leaf and are pinned here
 * in the orchestrator suite — the same pattern as
 * now-pixel-oak-tab-state.test.mts.
 *
 * Covers:
 *   - token humanization (K / M magnitudes, null → em dash)
 *   - ratio → percent rendering
 *   - duration bucketing (s / m / h and their boundaries)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatTokens,
  formatRatio,
  formatDuration,
} from "../dashboard/src/pages/now-console/console-format.ts";

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

test("formatDuration: —/s/m/h branches and the 60/3600 boundaries", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(undefined), "—");
  assert.equal(formatDuration(NaN), "—");
  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(-5), "—");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(60), "1m");
  assert.equal(formatDuration(90), "2m");
  assert.equal(formatDuration(3599), "60m");
  assert.equal(formatDuration(3600), "1.0h");
  assert.equal(formatDuration(5400), "1.5h");
});
