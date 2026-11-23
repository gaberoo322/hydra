/**
 * test/ratchets-live.test.mts — the one required test that runs every required
 * Ratchet against the live tree (parent epic #5649).
 *
 * The subtests are derived from the registry (scripts/ci/ratchets.ts): a row
 * with `enforcement: "required"` is measured here, an advisory row never is, and
 * flipping a policy to `required` enforces it on the next run with no edit to
 * this file. `verdict()` never throws; a measure or baseline-read crash comes
 * back as `{ ok: false, crashed: true, advice }`, so the assertion below fails
 * closed with the cause. Registry totality (every `*-baseline.json` on disk has
 * exactly one row) is asserted here too, from the inventory the registry owns.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RATCHETS, listBaselineFixtures, rowBaseline, rowId } from "../scripts/ci/ratchets.ts";

const ROOT = join(import.meta.dirname, "..");

describe("required ratchets on the live tree", { concurrency: true }, () => {
  for (const row of RATCHETS) {
    if (row.kind !== "ratchet" || row.ratchet.policy.enforcement !== "required") continue;
    test(row.ratchet.policy.id, { timeout: 60_000 }, async () => {
      const v = await row.ratchet.verdict();
      assert.ok(v.ok, v.advice);
    });
  }
});

describe("ratchet registry", () => {
  test("registry exercises at least one required ratchet", () => {
    const required = RATCHETS.filter((r) => r.kind === "ratchet" && r.ratchet.policy.enforcement === "required");
    assert.ok(required.length > 0, "no required ratchet row: the live-tree describe would run nothing");
  });

  test("every *-baseline.json on disk has exactly one row and every row's file exists", () => {
    assert.deepEqual(listBaselineFixtures(ROOT), RATCHETS.map(rowBaseline).sort());
  });

  test("row ids and baseline paths are unique", () => {
    const ids = RATCHETS.map(rowId);
    const baselines = RATCHETS.map(rowBaseline);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.equal(new Set(baselines).size, baselines.length, "baseline paths are unique");
  });

  test("every required external row's owner exists on disk", () => {
    for (const row of RATCHETS) {
      if (row.kind !== "external" || row.enforcement !== "required") continue;
      assert.ok(existsSync(join(ROOT, row.owner)), `${row.id}: owner ${row.owner} is missing`);
    }
  });
});
