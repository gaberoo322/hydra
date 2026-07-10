/**
 * Focused regression tests for the dispatch-bucket classification leaf
 * (`src/autopilot/retro-dispatch-classifier.ts`, issue #3090).
 *
 * This is the "characterize an individual dispatch's outcome" half of the old
 * `retro-projections.ts`: the `RetroDispatch` shape, the drill-flag selector,
 * `bucketOf`, and `projectDispatches`. The split earns its keep here — each
 * case drives the classifier with a minimal `{status, prNumber}`-shaped stub,
 * no cross-run cycle-id dedup math in sight. Imports directly from the focused
 * leaf (not the relay) to pin the concept/module boundary.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  bucketOf,
  flagDispatchesForDrill,
  projectDispatches,
  type RetroDispatch,
} from "../src/autopilot/retro-dispatch-classifier.ts";

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

describe("retro-dispatch-classifier: bucketOf", () => {
  test("maps merged/failed/pending statuses to coarse buckets", () => {
    assert.equal(bucketOf("merged"), "merged");
    assert.equal(bucketOf("abandoned"), "failed");
    assert.equal(bucketOf(null), null);
  });
});

describe("retro-dispatch-classifier: flagDispatchesForDrill", () => {
  test("flags failed / regressed / abandonReason rows; leaves the happy path out", () => {
    const rows = [
      dispatch({ cycleId: "ok", status: "merged", bucket: "merged" }),
      dispatch({ cycleId: "fail", status: "abandoned", bucket: "failed" }),
      dispatch({ cycleId: "churn", status: "merged", bucket: "merged", regressionIntroduced: true }),
      dispatch({ cycleId: "err", status: "merged", bucket: "merged", abandonReason: "boom" }),
      dispatch({ cycleId: "pending", status: null, bucket: null }),
    ];
    const flagged = flagDispatchesForDrill(rows).map((d) => d.cycleId);
    assert.deepEqual(flagged, ["fail", "churn", "err"]);
  });

  test("excludes an empty-cycleId (undrillable) row even when it carries a failure signal", () => {
    const rows = [dispatch({ cycleId: "", status: "abandoned", bucket: "failed", abandonReason: "run-interrupted" })];
    assert.deepEqual(flagDispatchesForDrill(rows), []);
  });
});

describe("retro-dispatch-classifier: projectDispatches", () => {
  test("projects one row per action-carried dispatch with resolved bucket", () => {
    const turns = [
      {
        turn_n: 1,
        actions: [
          {
            type: "dispatch",
            skill: "hydra-dev",
            prompt_args: { anchor: "issue-918" },
            outcome: { cycleId: "cyc-1", status: "merged", prNumber: 970 },
          },
        ],
        slots_snapshot: {},
      },
    ];
    const rows = projectDispatches(turns as Array<Record<string, unknown>>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cycleId, "cyc-1");
    assert.equal(rows[0].bucket, "merged");
    assert.equal(rows[0].prNumber, "970");
    assert.equal(rows[0].anchorReference, "issue-918");
  });

  test("synthesises a snapshot-only dispatch and seeds the candidate cycleId from task_id", () => {
    const turns = [
      {
        turn_n: 2,
        actions: [],
        slots_snapshot: {
          "slot-a": { skill: "hydra-dev", anchor: "PR#961", task_id: "task-9" },
        },
      },
    ];
    const rows = projectDispatches(turns as Array<Record<string, unknown>>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cycleId, "task-9");
    assert.equal(rows[0].skill, "hydra-dev");
    assert.equal(rows[0].prNumber, "961");
    assert.equal(rows[0].status, null);
  });
});
