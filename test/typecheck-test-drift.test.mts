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
 * can't block; a test/*.test.mts can, with no workflow edits"): it re-runs
 * the SAME `tsc -p tsconfig.test.json` check inside a `test/*.test.mts` file,
 * which `npm test` already executes as part of the REQUIRED `test` CI job —
 * so a new type error in `test/**` or `scripts/**` now fails a REQUIRED
 * check, without touching `.github/workflows/ci.yml` (T4 / Verifier Core).
 *
 * It reuses the checked-in baseline (`scripts/ci/test-typecheck-baseline.json`,
 * currently 0 after this issue's fixes) rather than hard-coding 0, so it
 * stays in lockstep with the shrink-only-ratchet semantics the advisory
 * workflow already uses: an intentional raise via
 * `npm run typecheck:test -- --write-baseline` (committed alongside the
 * change that needed it) updates BOTH gates from the same source of truth.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { countTscErrors } from "../scripts/ci/test-typecheck-check.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BASELINE_PATH = resolve(REPO_ROOT, "scripts/ci/test-typecheck-baseline.json");

interface BaselineFile {
  count: number;
  note: string;
}

function loadBaseline(): BaselineFile {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
}

/** Run `tsc -p tsconfig.test.json`; tsc exits non-zero on diagnostics — that
 * is the expected path, not a crash. Mirrors `runTsc()` in
 * `scripts/ci/test-typecheck-check.ts` (kept separate rather than imported:
 * that script's `runTsc` is intentionally unexported, and duplicating ~10
 * lines here avoids widening that script's public surface for a single
 * test-only caller). */
async function runTsc(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsc", "--noEmit", "-p", "tsconfig.test.json"],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout + stderr;
  } catch (err: any) {
    const out = (err?.stdout ?? "") + (err?.stderr ?? "");
    if (!out.trim()) {
      throw new Error(
        `tsc produced no output (exit ${err?.code}). This is a crash, not type errors. stderr: ${err?.stderr ?? ""}`,
      );
    }
    return out;
  }
}

describe("test/scripts type-check does not silently re-accumulate (issue #4046)", () => {
  test("tsc -p tsconfig.test.json error count matches the committed baseline", { timeout: 60_000 }, async () => {
    const baseline = loadBaseline();
    const output = await runTsc();
    const current = countTscErrors(output);

    if (current > baseline.count) {
      const diagnostics = output
        .split("\n")
        .filter(line => /^\S.*\(\d+,\d+\): error TS\d+:/.test(line))
        .join("\n");
      assert.fail(
        `New type error(s) in test/** or scripts/**: current=${current} baseline=${baseline.count}. ` +
          `Fix the new error(s), or if intentionally raising the tolerated count run ` +
          `\`npm run typecheck:test -- --write-baseline\` and commit the new baseline.\n\n${diagnostics}`,
      );
    }

    if (current < baseline.count) {
      assert.fail(
        `Baseline is stale (fewer errors than recorded): current=${current} baseline=${baseline.count}. ` +
          `Re-run \`npm run typecheck:test -- --write-baseline\` and commit the lowered baseline.`,
      );
    }

    assert.equal(current, baseline.count);
  });
});
