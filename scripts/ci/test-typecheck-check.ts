#!/usr/bin/env -S npx tsx
/**
 * Test-typecheck check — issue #750 CI-health ratchet.
 *
 * # The gap this closes
 *
 * `tsconfig.json` excludes `test/` (and never included `scripts/`), so
 * `npm run typecheck` (`tsc --noEmit`) leaves both trees unchecked. `npm test`
 * runs through tsx (transpile-only — types erased), so type errors in test and
 * script files are caught by NEITHER gate. They only surface in an editor/LSP,
 * and type rot accumulates silently in the test suite (concrete evidence: the
 * `dc`-as-namespace pattern in test/design-concept.test.mts, pre-existing on
 * master and type-incorrect, yet green on every CI run).
 *
 * # What this does
 *
 * Runs `tsc --noEmit -p tsconfig.test.json` (which widens the include to
 * `test/**` + `scripts/**`), counts the type errors, and compares the count to a
 * committed baseline. This is a SHRINK-ONLY ratchet, identical in spirit to
 * `target-coupling-check.ts` (ADR-0013) and `redis-seam-check.ts` (ADR-0009):
 *
 *   - current > baseline  → FAIL  (new type rot introduced — block the merge)
 *   - current < baseline  → FAIL  (baseline is stale; lower the row and commit)
 *   - current == baseline → PASS
 *
 * It deliberately does NOT fix the pre-existing errors up front (that would be a
 * flag-day change that blocks the merge queue) and is NOT wired into the
 * blocking `npm run typecheck`. The intended end state is an empty/zero baseline,
 * driven down over time.
 *
 * # Why a separate workflow, not ci.yml
 *
 * `ci.yml` is exact-match Untouchable Core (ADR-0001/ADR-0015: "the gate that
 * gates the gate", operator-only). A NEW verification belongs in a sibling
 * workflow that can land as a normal (non-Tier-0) change — the coupling-check.yml
 * precedent and operator memory (feedback_ci_gate_separate_workflow_avoids_tier0).
 * This check lives in `.github/workflows/test-typecheck.yml`.
 *
 * Usage:
 *   npx tsx scripts/ci/test-typecheck-check.ts
 *   npm run typecheck:test
 *
 * Runs on the Ratchet module (`ratchet.ts`, #5654): one counted row, `count`;
 * the baseline file is `{}` while the count is 0.
 *
 * Update flow when intentionally changing the tolerated count (fixing or
 * knowingly adding errors): fix the errors, or raise the `count` row by hand and
 * add `Baseline-raise: scripts/ci/test-typecheck-baseline.json count — <reason>`
 * to the PR body. `--write-baseline` only tightens (add `--allow-grow` to loosen).
 *
 * Self-test:
 *   --self-test exercises the pure count parser against synthetic tsc output and
 *   exits non-zero if it miscounts. This proves the gate would catch a
 *   newly-introduced test/scripts type error without depending on the live
 *   error set.
 */

import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GateInvariantError } from "../../src/errors.ts";
import { isCliEntrypoint } from "./seam-check-lib.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";

const execFileAsync = promisify(execFile);

const TSCONFIG = "tsconfig.test.json";

// ---------------------------------------------------------------------------
// Pure parser — exported for tests / self-test.
// ---------------------------------------------------------------------------

/**
 * Count type errors in raw tsc output. Pure — no I/O.
 *
 * `tsc --noEmit -p <config>` emits one `path(line,col): error TSxxxx: msg` line
 * per diagnostic, plus indented continuation lines for multi-line messages
 * (overload mismatches etc.). We count only the lines that START a diagnostic —
 * i.e. lines matching `: error TS<digits>:` after the file location — so a
 * multi-line error counts once. Indented "Overload N of M" continuation lines do
 * not match (they begin with whitespace and lack the `path(l,c):` prefix).
 */
export function countTscErrors(output: string): number {
  let count = 0;
  for (const line of output.split("\n")) {
    // A diagnostic-opening line looks like:  src/foo.ts(12,3): error TS2769: ...
    // Continuation lines are indented and/or lack the leading file(loc) anchor.
    if (/^\S.*\(\d+,\d+\): error TS\d+:/.test(line)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Run tsc in `root`; return its combined stdout+stderr (tsc writes diagnostics to stdout). */
async function runTsc(root: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsc", "--noEmit", "-p", TSCONFIG],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout + stderr;
  } catch (err: any) {
    // tsc exits non-zero when there are errors — that is the EXPECTED path here.
    // The diagnostics are on stdout. Throw only if there's genuinely no output
    // to parse (a real crash, e.g. config not found): the Ratchet reports it as
    // crashed (exit 2), never as a count of 0.
    const out = (err?.stdout ?? "") + (err?.stderr ?? "");
    if (!out.trim()) {
      throw new GateInvariantError(
        `tsc produced no output (exit ${err?.code}). This is a crash, not type errors. stderr: ${err?.stderr ?? ""}`,
      );
    }
    return out;
  }
}

export const typecheckRatchet = defineRatchet({
  id: "test-typecheck-check",
  baseline: "scripts/ci/test-typecheck-baseline.json",
  shape: "counted",
  polarity: "ceiling",
  stale: "fail",
  enforcement: "required",
  async measure(root) {
    const output = await runTsc(resolve(root));
    const count = countTscErrors(output);
    if (count > 0) {
      console.error("Type errors (tsc -p tsconfig.test.json):");
      for (const line of output.split("\n")) {
        if (/^\S.*\(\d+,\d+\): error TS\d+:/.test(line)) console.error(`  ${line}`);
      }
    }
    return { count };
  },
});

// ---------------------------------------------------------------------------
// Self-test — proves the parser counts diagnostics, not continuation lines.
// ---------------------------------------------------------------------------

function runSelfTest(): number {
  const failures: string[] = [];

  // 1. A single multi-line overload error counts as exactly ONE.
  const overload = [
    "scripts/foo.ts(219,11): error TS2769: No overload matches this call.",
    "  Overload 1 of 8, '(file: string): void', gave the following error.",
    "    Type 'utf8' is not assignable to type 'buffer'.",
  ].join("\n");
  if (countTscErrors(overload) !== 1) {
    failures.push(`multi-line overload error: expected 1, got ${countTscErrors(overload)}`);
  }

  // 2. Three distinct single-line errors count as three.
  const three = [
    "test/a.test.mts(28,5): error TS2578: Unused '@ts-expect-error' directive.",
    "test/b.test.mts(31,5): error TS2578: Unused '@ts-expect-error' directive.",
    "test/c.test.mts(82,5): error TS2503: Cannot find namespace 'dc'.",
  ].join("\n");
  if (countTscErrors(three) !== 3) {
    failures.push(`three distinct errors: expected 3, got ${countTscErrors(three)}`);
  }

  // 3. Clean output (no diagnostics) counts as zero.
  if (countTscErrors("") !== 0) failures.push("empty output should count 0");
  if (countTscErrors("\n\n") !== 0) failures.push("blank lines should count 0");

  // 4. A new error ADDED to an existing set is reflected in the count — this is
  //    the property the ratchet relies on to catch newly-introduced type rot.
  const before = countTscErrors(three);
  const after = countTscErrors(
    three + "\ntest/d.test.mts(10,2): error TS2339: Property 'x' does not exist.",
  );
  if (after !== before + 1) {
    failures.push(`adding one error should raise the count by 1 (before=${before}, after=${after})`);
  }

  // 5. A prose line mentioning "error TS" but lacking the file(loc) anchor must
  //    NOT be counted (avoids false positives from message bodies).
  const prose = "    See the error TS2769 docs for details.";
  if (countTscErrors(prose) !== 0) failures.push("prose mentioning error TS must not count");

  if (failures.length > 0) {
    console.error("[test-typecheck-check --self-test] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(
    "[test-typecheck-check --self-test] OK — parser counts diagnostics (not continuation/prose lines) and reflects newly-added errors.",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// --self-test is script-handled; every other flag belongs to the Ratchet CLI.
if (isCliEntrypoint(import.meta.url) && process.argv.includes("--self-test")) {
  process.exit(runSelfTest());
} else {
  runIfCli(import.meta.url, typecheckRatchet);
}
