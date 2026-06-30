import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MERGED_STATUSES,
  FAILED_STATUSES,
  bucketCycleStatus,
} from "../src/autopilot/cycle-status.ts";

// Pure taxonomy module (issue #2548) — no Redis, no clock. Tests the
// merged/failed cycle-status sets and the shared two-way bucketing predicate
// in isolation, without importing the digest read-projection surface.
describe("autopilot cycle-status taxonomy", () => {
  it("MERGED_STATUSES holds exactly the merged tokens", () => {
    assert.deepEqual(
      [...MERGED_STATUSES].sort(),
      ["completed", "merged", "succeeded"],
    );
  });

  it("FAILED_STATUSES holds exactly the failed tokens", () => {
    assert.deepEqual(
      [...FAILED_STATUSES].sort(),
      ["abandoned", "aborted", "failed", "timed-out", "timeout"],
    );
  });

  it("the two sets are disjoint", () => {
    for (const s of MERGED_STATUSES) {
      assert.ok(!FAILED_STATUSES.has(s), `${s} must not be in both sets`);
    }
  });

  it("bucketCycleStatus maps merged statuses to 'merged'", () => {
    for (const s of MERGED_STATUSES) {
      assert.equal(bucketCycleStatus(s), "merged");
    }
  });

  it("bucketCycleStatus maps failed statuses to 'failed'", () => {
    for (const s of FAILED_STATUSES) {
      assert.equal(bucketCycleStatus(s), "failed");
    }
  });

  it("bucketCycleStatus lowercases before the membership test", () => {
    assert.equal(bucketCycleStatus("MERGED"), "merged");
    assert.equal(bucketCycleStatus("Abandoned"), "failed");
    assert.equal(bucketCycleStatus("Timed-Out"), "failed");
  });

  it("bucketCycleStatus returns null for a status in neither set (the #1919 unaccounted case)", () => {
    assert.equal(bucketCycleStatus("no-op"), null);
    assert.equal(bucketCycleStatus("idle-drain"), null);
    assert.equal(bucketCycleStatus("dry-run"), null);
    assert.equal(bucketCycleStatus("unknown"), null);
  });

  it("bucketCycleStatus returns null for null/empty/undefined", () => {
    assert.equal(bucketCycleStatus(null), null);
    assert.equal(bucketCycleStatus(undefined), null);
    assert.equal(bucketCycleStatus(""), null);
  });
});
