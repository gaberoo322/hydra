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
import { RATCHETS, listBaselineFixtures, rowBaseline, rowId, rowStaleReason } from "../scripts/ci/ratchets.ts";

const ROOT = join(import.meta.dirname, "..");
// The describe below derives one subtest per required row (INV-2: no hand-written id list);
// suite-count only sees top-level units, so the registry-derived count is floored here instead.
const REQUIRED_RATCHET_FLOOR = 13;

describe("required ratchets on the live tree", { concurrency: true }, () => {
  for (const row of RATCHETS) {
    if (row.kind !== "ratchet" || row.ratchet.policy.enforcement !== "required") continue;
    test(row.ratchet.policy.id, { timeout: 180_000 }, async (t) => {
      const v = await row.ratchet.verdict();
      if (v.ok && v.stale.length > 0) t.diagnostic(v.advice);
      assert.ok(v.ok, v.advice);
    });
  }
});

describe("ratchet registry", () => {
  test("registry keeps at least 12 required ratchet rows (floor on the registry-derived subtests)", () => {
    const required = RATCHETS.filter((r) => r.kind === "ratchet" && r.ratchet.policy.enforcement === "required");
    assert.ok(
      required.length >= REQUIRED_RATCHET_FLOOR,
      `only ${required.length} required ratchet rows (floor ${REQUIRED_RATCHET_FLOOR}): a dropped or demoted row would silently shrink the live-tree describe; raise the floor in the same PR that adds required rows`,
    );
  });

  test("every *-baseline.json on disk has exactly one row and every row's file exists", () => {
    assert.deepEqual(listBaselineFixtures(ROOT), RATCHETS.map(rowBaseline).sort());
  });

  test("a ratchet row declares stale: fail only with a written staleReason", () => {
    for (const row of RATCHETS) {
      if (row.kind !== "ratchet" || row.ratchet.policy.stale !== "fail") continue;
      const reason = rowStaleReason(row);
      assert.ok(
        typeof reason === "string" && reason.trim().length > 0,
        `${rowId(row)}: stale: "fail" needs a non-empty staleReason (the default is the ceiling: a below-ceiling measurement passes with a hint)`,
      );
    }
  });

  test("rowStaleReason is undefined for a default-policy ratchet and for non-ratchet rows", () => {
    const ratchet = RATCHETS.find((r) => r.kind === "ratchet" && r.ratchet.policy.stale !== "fail");
    assert.ok(ratchet, "expected at least one default-policy ratchet row");
    assert.equal(rowStaleReason(ratchet), undefined);
    for (const row of RATCHETS) if (row.kind !== "ratchet") assert.equal(rowStaleReason(row), undefined);
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
