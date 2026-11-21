/**
 * Regression test for issue #4046 — `npm run typecheck:test`
 * (`scripts/ci/test-typecheck-check.ts`) is a shrink-only baseline ratchet
 * over `test/**` + `scripts/**` (tsconfig.test.json), but it runs ONLY in the
 * advisory, non-required `test-typecheck.yml` workflow (issue #750). CI's
 * REQUIRED `test` job runs `npm test` (tsx, type-erased) and the REQUIRED
 * `typecheck` job runs `npm run typecheck` (src-only, `tsconfig.json`
 * excludes `test/` and never included `scripts/`) — so a new test-file type
 * error can land on master with every required check green, exactly as
 * happened with the 6 pre-existing errors this issue fixed.
 *
 * This test closes that gap the lower-tier way documented in operator memory
 * (`feedback_ci_gate_separate_workflow_avoids_tier0`: "a sibling workflow
 * can't block; a test/*.test.mts can, with no workflow edits"): it runs the
 * SAME Ratchet verdict the CLI prints (`typecheckRatchet.verdict()`) inside a
 * `test/*.test.mts` file, which `npm test` already executes as part of the
 * REQUIRED `test` CI job — so a new type error in `test/**` or `scripts/**`
 * now fails a REQUIRED check, without touching `.github/workflows/ci.yml`
 * (T4 / Verifier Core).
 *
 * The verdict compares against the checked-in baseline
 * (`scripts/ci/test-typecheck-baseline.json`, `{}` while the count is 0), so
 * the advisory workflow and this gate share one source of truth and one
 * piece of advice text (pinned in test/ratchet.test.mts, not here).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { typecheckRatchet } from "../scripts/ci/test-typecheck-check.ts";

describe("test/scripts type-check does not silently re-accumulate (issue #4046)", () => {
  test("tsc -p tsconfig.test.json error count matches the committed baseline", { timeout: 60_000 }, async () => {
    const v = await typecheckRatchet.verdict();
    assert.ok(v.ok, v.advice);
  });

  test("a tsc run with no output (no tsconfig.test.json) is a crash, never a count of 0 (INV-3)", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "typecheck-crash-"));
    try {
      const v = await typecheckRatchet.verdict(root);
      assert.equal(v.crashed, true);
      assert.equal(v.ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
