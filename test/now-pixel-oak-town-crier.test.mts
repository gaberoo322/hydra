/**
 * test/now-pixel-oak-town-crier.test.mts — covers the bubble-color
 * resolver and the closed set of class colors.
 *
 * Slice 5 of /now-pixel (#642, #647). The OakTownCrier component is a
 * thin binder over WS events + resolveBubbleColor; the visual scroll +
 * collapse mechanics are exercised in-browser. The hardest-to-rebuild
 * piece if it drifts is the source → color resolution, so we pin that.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBubbleColor,
  CLASS_BUBBLE_COLOR,
  PIPELINE_CLASSES,
  SIGNAL_CLASSES,
} from "../dashboard/src/pages/now-pixel/sprite-map.ts";

test("CLASS_BUBBLE_COLOR: every class has a non-empty CSS color", () => {
  const all = [...PIPELINE_CLASSES, ...SIGNAL_CLASSES];
  for (const cls of all) {
    const c = CLASS_BUBBLE_COLOR[cls];
    assert.ok(typeof c === "string" && c.length > 0, `missing color for ${cls}`);
    // Hex shape: #RGB or #RRGGBB, optionally with named color fallback. We
    // shipped hex strings; if that ever flips to "rgb(...)" the test
    // should be relaxed deliberately, not silently.
    assert.match(c, /^#[0-9a-fA-F]{3,8}$/);
  }
});

test("resolveBubbleColor: dev_orch is the Forge orange (spec callout)", () => {
  // The slice spec explicitly calls dev_orch the "Forge" bubble color.
  // If we ever change the palette, this is the load-bearing pin.
  assert.equal(resolveBubbleColor("dev_orch"), "#fb923c");
});

test("resolveBubbleColor: every class name maps to its own palette entry", () => {
  for (const cls of [...PIPELINE_CLASSES, ...SIGNAL_CLASSES]) {
    assert.equal(resolveBubbleColor(cls), CLASS_BUBBLE_COLOR[cls]);
  }
});

test("resolveBubbleColor: skill names map through to their class", () => {
  // Some WS events carry `subagent_type` (hydra-dev, hydra-target-build,
  // etc.) instead of the class. The resolver must still pick the right
  // color so those bubbles don't all look like the grey fallback.
  assert.equal(resolveBubbleColor("hydra-dev"), CLASS_BUBBLE_COLOR.dev_orch);
  assert.equal(
    resolveBubbleColor("hydra-target-build"),
    CLASS_BUBBLE_COLOR.dev_target,
  );
  assert.equal(resolveBubbleColor("hydra-doctor"), CLASS_BUBBLE_COLOR.health);
});

test("resolveBubbleColor: unknown source → neutral grey fallback (still renders)", () => {
  assert.equal(resolveBubbleColor("totally-made-up"), "#9ca3af");
  assert.equal(resolveBubbleColor(""), "#9ca3af");
  assert.equal(resolveBubbleColor(null), "#9ca3af");
  assert.equal(resolveBubbleColor(undefined), "#9ca3af");
});
