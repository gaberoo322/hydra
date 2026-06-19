/**
 * Test-output parser seam for the grounding Module (grounding/index.ts).
 *
 * Pure functions over strings — no spawning, no filesystem I/O. Owns:
 *   - `parseTestCounts`   — extract pass/fail/total from vitest or jest output
 *   - `parseFailingTests` — extract failing test names from vitest/jest output
 *
 * Keeping these functions in a dedicated module lets callers import them
 * directly (e.g. a future CI-quality aggregator wanting `parseTestCounts`
 * without a full `groundProject` run) and lets tests reach them without the
 * `_testing` escape hatch on `grounding/index.ts`.
 *
 * Both functions depend on `stripAnsi` from grounding/cmd.ts because ANSI
 * codes appear in the output of vitest running under npm with FORCE_COLOR=1.
 */

import { stripAnsi } from "./cmd.ts";

/**
 * Parse vitest/jest output for pass/fail/total counts.
 *
 * Returns `{ passed, failed, total, recognised }` where `recognised` is true
 * if at least one known summary pattern matched. A `recognised: false` result
 * paired with `exitCode === 0` is the silent-no-op shape — the test command
 * appeared to succeed but the parser found nothing to read. Callers translate
 * that into a `testParseStatus` field on the grounding snapshot so consumers
 * can distinguish "ran 0 tests" from "we couldn't read the result". See issue #456.
 */
export function parseTestCounts(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): { passed: number; failed: number; total: number; recognised: boolean } {
  // Strip ANSI codes first — see stripAnsi() docs in grounding/cmd.ts.
  const combined = stripAnsi((stdout || "") + "\n" + (stderr || ""));
  let passed = 0, failed = 0, total = 0;
  let recognised = false;

  // Vitest outputs two lines: "Test Files  43 passed (43)" and "Tests  352 passed (352)"
  // We want the "Tests" line (individual test count), not "Test Files" (file count).
  const testsLineMatch = combined.match(/^\s*Tests\s+(\d+)\s+passed/m);
  const testsFailMatch = combined.match(/^\s*Tests\s+.*?(\d+)\s+failed/m);
  if (testsLineMatch) {
    passed = parseInt(testsLineMatch[1]);
    recognised = true;
  }
  if (testsFailMatch) {
    failed = parseInt(testsFailMatch[1]);
    recognised = true;
  }

  // Fallback: generic "N passed" if the vitest-specific pattern didn't match.
  if (passed === 0) {
    const genericPass = combined.match(/(\d+)\s+passed/);
    if (genericPass) {
      passed = parseInt(genericPass[1]);
      recognised = true;
    }
  }
  if (failed === 0) {
    const genericFail = combined.match(/(\d+)\s+failed/);
    if (genericFail) {
      failed = parseInt(genericFail[1]);
      recognised = true;
    }
  }

  total = passed + failed;

  // Try "Tests: X passed, Y total" (jest).
  if (total === 0) {
    const jestMatch = combined.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
    if (jestMatch) {
      passed = parseInt(jestMatch[1]);
      total = parseInt(jestMatch[2]);
      failed = total - passed;
      recognised = true;
    }
  }

  return { passed, failed, total, recognised };
}

/**
 * Extract failing test names from vitest/jest output.
 * Returns at most 20 entries (capped to avoid noise in prompts).
 */
export function parseFailingTests(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): string[] {
  // Strip ANSI codes first — see stripAnsi() docs in grounding/cmd.ts.
  const combined = stripAnsi((stdout || "") + "\n" + (stderr || ""));
  const failures: string[] = [];

  // Vitest: "FAIL  src/foo.test.ts > suite > test name"
  // Or: "× test name" / "✗ test name"
  for (const line of combined.split("\n")) {
    const failLine = line.match(/(?:FAIL|×|✗|✘)\s+(.+)/);
    if (failLine) {
      failures.push(failLine[1].trim());
    }
  }

  return failures.slice(0, 20); // cap at 20
}
