/**
 * Focused regression tests for the cycle-id dedup + provisional-tracking leaf
 * (`src/autopilot/retro-cycle-identity.ts`, issue #3090).
 *
 * This is the "group dispatches across runs by canonical identity" half of the
 * old `retro-projections.ts`: the post-enrichment `dedupByCanonicalCycleId` and
 * the PROVISIONAL→CONFIRMED protocol (`collectProvisionalCycleIds` /
 * `confirmDrillableCycleIds`). The split earns its keep here — each case drives
 * the dedup math with a minimal `{cycleId, status}`-shaped stub, with no
 * bucket-classification noise. Imports directly from the focused leaf (not the
 * relay) to pin the concept/module boundary.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  collectProvisionalCycleIds,
  confirmDrillableCycleIds,
  dedupByCanonicalCycleId,
} from "../src/autopilot/retro-cycle-identity.ts";
import type { RetroDispatch } from "../src/autopilot/retro-dispatch-classifier.ts";

function dispatch(over: Partial<RetroDispatch> = {}): RetroDispatch {
  return {
    cycleId: "c1",
    turn_n: 1,
    skill: "hydra-dev",
    anchorReference: "issue-918",
    prNumber: null,
    status: "merged",
    bucket: "merged",
    abandonReason: null,
    regressionIntroduced: false,
    flagged: false,
    undrillable: false,
    ...over,
  };
}

describe("retro-cycle-identity: dedupByCanonicalCycleId", () => {
  test("collapses same-cycleId rows onto the earliest-turn canonical row, unioning fields", () => {
    const rows = [
      dispatch({ cycleId: "cyc", turn_n: 3, prNumber: "970", anchorReference: null }),
      dispatch({ cycleId: "cyc", turn_n: 1, prNumber: null, anchorReference: "issue-918", regressionIntroduced: true }),
    ];
    const survivors = dedupByCanonicalCycleId(rows);
    assert.equal(survivors.length, 1);
    // First-seen row is canonical; adopts the earlier turn_n and unions fields.
    assert.equal(survivors[0].turn_n, 1);
    assert.equal(survivors[0].prNumber, "970");
    assert.equal(survivors[0].anchorReference, "issue-918");
    assert.equal(survivors[0].regressionIntroduced, true);
  });

  test("never merges two distinct empty-cycleId rows", () => {
    const rows = [dispatch({ cycleId: "" }), dispatch({ cycleId: "" })];
    assert.equal(dedupByCanonicalCycleId(rows).length, 2);
  });
});

describe("retro-cycle-identity: PROVISIONAL→CONFIRMED protocol", () => {
  test("collectProvisionalCycleIds selects non-empty, status-null candidates only", () => {
    const rows = [
      dispatch({ cycleId: "prov", status: null }),
      dispatch({ cycleId: "resolved", status: "merged" }),
      dispatch({ cycleId: "", status: null }),
    ];
    assert.deepEqual([...collectProvisionalCycleIds(rows)], ["prov"]);
  });

  test("confirmDrillableCycleIds drops an unconfirmed provisional handle, keeps a confirmed one", () => {
    const rows = [
      dispatch({ cycleId: "kept", status: null }),
      dispatch({ cycleId: "dropped", status: null }),
      dispatch({ cycleId: "action-derived", status: "merged" }),
    ];
    const provisional = new Set(["kept", "dropped"]);
    const confirmed = new Set(["kept"]);
    confirmDrillableCycleIds(rows, provisional, confirmed);
    assert.equal(rows[0].cycleId, "kept");
    assert.equal(rows[1].cycleId, ""); // unconfirmed provisional → dropped to undrillable
    assert.equal(rows[2].cycleId, "action-derived"); // non-provisional never dropped
  });
});
