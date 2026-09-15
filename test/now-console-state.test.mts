/**
 * test/now-console-state.test.mts — the console-state.ts barrel contract
 * (issue #4382).
 *
 * console-state.ts used to IMPLEMENT the /now Console's derivations; #4382
 * split it into four concern-scoped leaves (status-verdict-state.ts,
 * usage-panel-state.ts, console-format.ts, status-strip-state.ts) with the
 * six .jsx consumers' import path preserved as a pure re-export barrel. The
 * behavioural tests moved with their leaves; this file now pins the BARREL:
 *
 *   - every value export the barrel forwards is the SAME binding (===) as
 *     the leaf's — a re-export, never a re-implementation, so the leaf tests
 *     remain the tests of what the widgets actually run.
 *   - the retired view-mode names (ADR-0034 §3 killed the Console/Habitat
 *     toggle with the Habitat, PR #4106; zero production consumers remained)
 *     stay out of the barrel namespace — dead code must not resurface
 *     through the public surface.
 *   - the namespace exposes exactly the six-consumer surface and nothing
 *     else, so an accidental new export has to acknowledge this contract.
 *
 * Importing the barrel at all is itself load-bearing under the
 * `--experimental-strip-types` runner: a type-only name re-exported in value
 * form (`export { LifecycleLike } from …`) fails ESM linking HERE, at test
 * time, even though `tsc` passes (type erasure only) — this file is where
 * that mistake turns red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as barrel from "../dashboard/src/pages/now-console/console-state.ts";
import * as verdictLeaf from "../dashboard/src/pages/now-console/status-verdict-state.ts";
import * as usageLeaf from "../dashboard/src/pages/now-console/usage-panel-state.ts";
import * as formatLeaf from "../dashboard/src/pages/now-console/console-format.ts";
import * as stripLeaf from "../dashboard/src/pages/now-console/status-strip-state.ts";

test("barrel value exports are strictly equal to their leaf exports", () => {
  // The barrel must forward the leaves' bindings, never duplicate them.
  const pairs: Array<[string, unknown, unknown]> = [
    ["VERDICT_RUNNING", barrel.VERDICT_RUNNING, verdictLeaf.VERDICT_RUNNING],
    ["VERDICT_IDLE", barrel.VERDICT_IDLE, verdictLeaf.VERDICT_IDLE],
    ["VERDICT_STUCK", barrel.VERDICT_STUCK, verdictLeaf.VERDICT_STUCK],
    ["VERDICT_CRASHED", barrel.VERDICT_CRASHED, verdictLeaf.VERDICT_CRASHED],
    ["VERDICT_PAUSED", barrel.VERDICT_PAUSED, verdictLeaf.VERDICT_PAUSED],
    ["rankStuckSignals", barrel.rankStuckSignals, verdictLeaf.rankStuckSignals],
    ["resolveVerdict", barrel.resolveVerdict, verdictLeaf.resolveVerdict],
    ["classifyPace", barrel.classifyPace, usageLeaf.classifyPace],
    ["flattenAttribution", barrel.flattenAttribution, usageLeaf.flattenAttribution],
    ["formatPercent", barrel.formatPercent, formatLeaf.formatPercent],
    ["formatTokens", barrel.formatTokens, formatLeaf.formatTokens],
    ["formatDuration", barrel.formatDuration, formatLeaf.formatDuration],
    ["formatRatio", barrel.formatRatio, formatLeaf.formatRatio],
    [
      "formatNextDispatchCountdown",
      barrel.formatNextDispatchCountdown,
      stripLeaf.formatNextDispatchCountdown,
    ],
    ["deriveInflightSlots", barrel.deriveInflightSlots, stripLeaf.deriveInflightSlots],
  ];
  assert.equal(pairs.length, 15);
  for (const [name, viaBarrel, viaLeaf] of pairs) {
    assert.equal(viaBarrel, viaLeaf, `${name} via the barrel must be the leaf binding`);
    assert.ok(typeof viaBarrel === "function" || typeof viaBarrel === "string", name);
  }
});

test("retired view-mode names are absent from the barrel namespace", () => {
  // ADR-0034 §3 retired the Console/Habitat toggle (with its ?view=
  // deep-link and localStorage machinery) in PR #4106; #4382 deleted the
  // orphaned block. None of its names may resurface on the public surface.
  const retired = [
    "VIEW_CONSOLE",
    "VIEW_HABITAT",
    "DEFAULT_NOW_VIEW",
    "NOW_VIEW_STORAGE_KEY",
    "isNowViewMode",
    "resolveNowView",
    "writeStoredNowView",
  ];
  for (const name of retired) {
    assert.equal(name in barrel, false, `${name} must stay retired`);
  }
});

test("barrel namespace is exactly the six-consumer surface", () => {
  // The widgets import 15 value names from "./console-state.ts" (type-only
  // names are erased by strip-types and never appear at runtime). An entry
  // added or dropped here is a public-surface change that must be deliberate.
  assert.deepEqual(Object.keys(barrel).sort(), [
    "VERDICT_CRASHED",
    "VERDICT_IDLE",
    "VERDICT_PAUSED",
    "VERDICT_RUNNING",
    "VERDICT_STUCK",
    "classifyPace",
    "deriveInflightSlots",
    "flattenAttribution",
    "formatDuration",
    "formatNextDispatchCountdown",
    "formatPercent",
    "formatRatio",
    "formatTokens",
    "rankStuckSignals",
    "resolveVerdict",
  ]);
});
