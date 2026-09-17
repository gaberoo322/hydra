/**
 * Direct unit tests for src/retro-inputs.ts — the shared pure-leaf seam
 * extracted in issue #4535 from the byte-identical copies in
 * scripts/ci/hydra-retro-emit.ts (Orchestrator `/hydra-retro`) and
 * scripts/target/target-retro.ts (Target `/hydra-target-retro`).
 *
 * The parseArgs assertions below are the UNION of the two describes the script
 * suites used to carry (they asserted the same behaviour independently — the
 * near-duplication issue #4535 removes, mirroring test/mutation-gate-inputs
 * .test.mts for the #4346 mutation-gate extraction), plus two pins the old
 * suites never asserted (first-positional-wins; whitespace-only input).
 * KEBAB_CUE gets its first DIRECT grammar tests here — before #4535 it was
 * only covered indirectly through validateFindings / validateObservations
 * cue-error cases, which stay in their own suites.
 *
 * The leaf lives under src/ deliberately (same rationale as #4346's INV-10):
 * the PR's own mutation gate mutates only src/**\/*.ts, so placing the shared
 * parser there puts it under the kill-rate floor. Every branch of parseArgs is
 * asserted directly so mutants survive nowhere.
 *
 * Pure tests — no fs, no env, no Redis, no network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { KEBAB_CUE, parseArgs } from "../src/retro-inputs.ts";

describe("parseArgs — audit is the default", () => {
  test("no args ⇒ apply:false, no runId key", () => {
    // deepEqual is strict (node:assert/strict), so a `runId: undefined` key
    // would FAIL these — the key must be omitted entirely.
    assert.deepEqual(parseArgs(""), { apply: false });
    assert.deepEqual(parseArgs(null), { apply: false });
    assert.deepEqual(parseArgs(undefined), { apply: false });
  });

  test("whitespace-only input ⇒ apply:false, no runId key", () => {
    // Guards the token split/trim/filter chain: an empty token that survived
    // filtering would be captured as the run id.
    assert.deepEqual(parseArgs("   "), { apply: false });
    assert.deepEqual(parseArgs(" \t "), { apply: false });
  });

  test("--audit / --dry-run both force dry-run", () => {
    assert.deepEqual(parseArgs("--audit"), { apply: false });
    assert.deepEqual(parseArgs("--dry-run"), { apply: false });
  });

  test("--apply is the explicit opt-in", () => {
    assert.deepEqual(parseArgs("--apply"), { apply: true });
  });

  test("positional run id is captured; --audit forces dry-run", () => {
    assert.deepEqual(parseArgs("run-123"), { apply: false, runId: "run-123" });
    assert.deepEqual(parseArgs("run-123 --apply"), { apply: true, runId: "run-123" });
    assert.deepEqual(parseArgs("run-123 --audit"), { apply: false, runId: "run-123" });
  });

  test("extra whitespace between tokens is collapsed", () => {
    assert.deepEqual(parseArgs("  run-123   --apply  "), { apply: true, runId: "run-123" });
  });

  test("only the FIRST positional token becomes the run id", () => {
    assert.deepEqual(parseArgs("run-1 run-2"), { apply: false, runId: "run-1" });
  });

  test("unknown flags are ignored, not misparsed as the run id", () => {
    assert.deepEqual(parseArgs("--verbose run-9"), { apply: false, runId: "run-9" });
    assert.deepEqual(parseArgs("--frobnicate run-9"), { apply: false, runId: "run-9" });
  });
});

describe("KEBAB_CUE — the friction-store cue grammar", () => {
  test("accepts non-empty lowercase kebab-case", () => {
    for (const cue of ["a", "a-b", "a-1", "abc-123-def", "x0-y9"]) {
      assert.ok(KEBAB_CUE.test(cue), `expected "${cue}" to match`);
    }
  });

  test("rejects uppercase, separators at edges, spaces, underscores, empty", () => {
    for (const bad of ["", "A", "aB", "-a", "a-", "a b", "a_b", "a--b"]) {
      assert.ok(!KEBAB_CUE.test(bad), `expected "${bad}" to be rejected`);
    }
  });
});
