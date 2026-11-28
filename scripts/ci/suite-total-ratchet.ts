#!/usr/bin/env -S npx tsx
/**
 * Suite-total floor (issue #5777, parent epic #5776; ADR-0038 Decision 2 amendment).
 *
 * One committed number: the scanned top-level test total
 * (`countSuiteTotal()` in scripts/test/suite-count-check.mjs, the static
 * source scan, never the truncated runtime capture) must stay at or above
 * `test/fixtures/suite-total-baseline.json`. Deleting tests drops the total
 * under the floor and fails the required `test` job (it rides
 * test/ratchets-live.test.mts; ci.yml is not edited). Adding tests never
 * requires touching the floor: measured above the floor is only a hint.
 *
 * Usage:
 *   npx tsx scripts/ci/suite-total-ratchet.ts                    # check
 *   npx tsx scripts/ci/suite-total-ratchet.ts --write-baseline   # raise only
 * Lowering the floor needs a PR-body line
 * `Baseline-raise: test/fixtures/suite-total-baseline.json test/*.test.mts - <reason>`.
 */
import { resolve } from "node:path";
import { countSuiteTotal } from "../test/suite-count-check.mjs";
import { defineRatchet, runIfCli } from "./ratchet.ts";

export const SUITE_TOTAL_KEY = "test/*.test.mts";

export const suiteTotalRatchet = defineRatchet({
  id: "suite-total",
  baseline: "test/fixtures/suite-total-baseline.json",
  shape: "counted",
  polarity: "floor",
  stale: "hint",
  enforcement: "required",
  async measure(root) {
    return { [SUITE_TOTAL_KEY]: countSuiteTotal(resolve(root)) };
  },
  help: [
    "The scanned top-level test total fell below the committed floor: tests were deleted.",
    "Restore them. Lowering the floor is a deliberate, disclosed act (Baseline-raise line, ADR-0038).",
  ],
});

runIfCli(import.meta.url, suiteTotalRatchet);
