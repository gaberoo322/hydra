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
import { formatGrowthAdvice, formatStaleAdvice } from "../scripts/ci/seam-check-lib.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BASELINE_REL = "scripts/ci/test-typecheck-baseline.json";
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_REL);

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

/** Growth-arm failure text. Option values mirror the call site in
 * `scripts/ci/test-typecheck-check.ts` so the required job and the advisory
 * CLI print identical advice. */
function growthFailureMessage(current: number, baseline: number, diagnostics: string): string {
  return (
    `New type error(s) in test/** or scripts/**: current=${current} baseline=${baseline}. ` +
    formatGrowthAdvice({
      cmd: "npm run typecheck:test -- --write-baseline",
      baselineRel: BASELINE_REL,
      rowKey: "count",
      fixVerb: "fix the new error(s)",
      current,
    }) +
    `\n\n${diagnostics}`
  );
}

/** Stale-arm failure text (hand-edit the row; names no writer command). */
function staleFailureMessage(current: number, baseline: number): string {
  return (
    `Baseline is stale (fewer errors than recorded): current=${current} baseline=${baseline}. ` +
    formatStaleAdvice({
      baselineRel: BASELINE_REL,
      rowAction: `lower the \`count\` row to ${current}`,
    })
  );
}

describe("typecheck drift failure advice", () => {
  test("growth arm names --allow-grow and the Baseline-raise line, never a bare writer", () => {
    const msg = growthFailureMessage(3, 1, "x.ts(1,1): error TS1000: boom");
    assert.ok(msg.includes("--write-baseline --allow-grow"));
    assert.ok(msg.includes(`Baseline-raise: ${BASELINE_REL} count — <reason>`));
    assert.equal(msg.replaceAll("--write-baseline --allow-grow", "").includes("--write-baseline"), false);
    assert.ok(msg.endsWith("x.ts(1,1): error TS1000: boom"));
  });

  test("stale arm says lower the count row by hand and names no writer command", () => {
    const msg = staleFailureMessage(0, 2);
    assert.ok(msg.includes("lower the `count` row to 0"));
    assert.ok(msg.includes("by hand"));
    assert.equal(msg.includes("--write-baseline"), false);
  });
});

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
      assert.fail(growthFailureMessage(current, baseline.count, diagnostics));
    }

    if (current < baseline.count) {
      assert.fail(staleFailureMessage(current, baseline.count));
    }

    assert.equal(current, baseline.count);
  });
});
