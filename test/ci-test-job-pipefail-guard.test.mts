/**
 * Drift guard for the REQUIRED `test` job's pipefail protection (issue #3741).
 *
 * ## Why this guard exists, and why it is a ratchet rather than the fix
 *
 * `.github/workflows/ci.yml`'s `test` job ran `npm test 2>&1 | tee
 * test-output.txt` in a `run:` block with no `shell:` key. The Actions DEFAULT
 * shell for such a block is `bash -e {0}` — `-e` but NOT `-o pipefail`. A
 * pipeline's exit status is its LAST command, so `tee`'s success masked the
 * suite's failure and a RED suite concluded the REQUIRED `test` check GREEN
 * (empirically: runs 30218225198 and 30227202092 both concluded `success`
 * while carrying `# fail 1`).
 *
 * That defect is the one class the repo's "implement a drift guard as a
 * `test/*.test.mts` rather than a sibling workflow, because a test reaches a
 * blocking check" pattern *cannot* fix — the pattern's entire blocking power is
 * the `test` job's exit code, which is exactly what was being swallowed. So
 * this file could not have been the fix; `ci.yml` had to change. It is however
 * a genuine ratchet the instant that change lands beside it: from then on, a
 * later edit that silently re-removes pipefail (or drops the count floor back
 * down) reddens a check that can now actually go red.
 *
 * ## Two independent assertions
 *
 * 1. INVARIANT — parse `ci.yml`, locate the step that pipes `npm test`, and
 *    assert it is pipefail-protected. Deliberately accepts ANY of the three
 *    correct spellings (`set … pipefail` in the run block, `shell: bash` on the
 *    step, or an explicit `PIPESTATUS` check) so a later legitimate refactor of
 *    the step is not falsely reddened — the guard pins the *invariant*, never
 *    one implementation. Also asserts the `MIN_TESTS` floor, and that `| tee`
 *    survives (observability: the suite must still stream to the live job log).
 *
 * 2. MECHANISM — spawn the two shells and observe the exit codes directly, so
 *    the *reason* the one-line fix works is pinned in-repo, offline, with no CI
 *    run required. This is what stops a future reader from "simplifying" the
 *    pipefail away on the theory that `-e` already covers it.
 *
 * Comments are stripped before the invariant checks, so prose that merely
 * mentions `pipefail` or `shell: bash` can never satisfy the guard.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/ci.yml");

/**
 * The floor the `test` job's count ratchet must be at or above. Raised from
 * 450 to 6000 in #3741: once a red suite actually reddens the job, the count
 * floor's only remaining job is catching a suite that ran FEWER tests and still
 * exited 0. This constant may only ever move UP, and must stay well below the
 * live pass count so it never becomes an ambient poison pill.
 */
export const MIN_TESTS_FLOOR = 6000;

/** Drop whole-line comments (YAML `#` and shell `#` alike). */
export function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Extract a top-level job block from a workflow, by job key.
 *
 * Jobs are the 2-space-indented keys under `jobs:`; the block runs to the next
 * line at that same indent (or EOF). Returns null when the job is absent —
 * callers assert on that, so a renamed job fails loudly rather than vacuously
 * passing.
 */
export function extractJobBlock(workflow: string, jobName: string): string | null {
  const lines = workflow.split("\n");
  const startRe = new RegExp(`^  ${jobName}:\\s*$`);
  const start = lines.findIndex((line) => startRe.test(line));
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A non-blank line at 2-space indent starts the next job.
    if (/^ {2}\S/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Split a job block into its `steps:` list items.
 *
 * Steps are the 6-space-indented `- ` entries. A leading comment block that
 * precedes a step attaches to the PREVIOUS entry rather than the next one; that
 * is harmless here because comments are stripped before any assertion runs.
 */
export function extractSteps(jobBlock: string): string[] {
  const lines = jobBlock.split("\n");
  const steps: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^ {6}- /.test(line)) {
      if (current) steps.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

/** The step that runs the suite: the one whose (comment-free) body pipes `npm test`. */
export function findSuiteStep(steps: string[]): string | null {
  const match = steps
    .map(stripComments)
    .find((step) => /\bnpm test\b/.test(step) && step.includes("|"));
  return match ?? null;
}

/**
 * Is this step protected against a masked pipeline exit code?
 *
 * Accepts any of the three correct mechanisms. `stripComments` has already run,
 * so prose mentioning these tokens does not count.
 */
export function isPipefailProtected(stepText: string): boolean {
  // (a) `set -o pipefail` / `set -eo pipefail` / `set -euo pipefail` …
  if (/^\s*set\s+[^\n]*\bpipefail\b/m.test(stepText)) return true;
  // (b) `shell: bash` — Actions expands this to `bash --noprofile --norc -eo pipefail {0}`.
  if (/^\s*shell:\s*bash\s*$/m.test(stepText)) return true;
  // (c) an explicit exit-status capture of the pipeline's first element.
  if (/\bPIPESTATUS\b/.test(stepText)) return true;
  return false;
}

/** The `MIN_TESTS=<n>` count floor asserted inside the step, or null if absent. */
export function extractMinTests(stepText: string): number | null {
  const m = /^\s*MIN_TESTS=(\d+)\s*$/m.exec(stepText);
  return m ? Number(m[1]) : null;
}

describe("ci.yml `test` job — pipefail invariant (#3741)", () => {
  const workflow = readFileSync(CI_WORKFLOW, "utf8");

  test("the `test` job still exists under exactly that name", () => {
    // The required-status-check context is the job name. Renaming it silently
    // detaches branch protection, so pin it here rather than in prose.
    assert.notEqual(
      extractJobBlock(workflow, "test"),
      null,
      "ci.yml has no `test:` job — branch protection's required `test` context would never report",
    );
  });

  test("the suite step pipes `npm test` and is pipefail-protected", () => {
    const job = extractJobBlock(workflow, "test");
    assert.notEqual(job, null, "ci.yml has no `test:` job");
    const step = findSuiteStep(extractSteps(job as string));
    assert.notEqual(
      step,
      null,
      "no step in the `test` job pipes `npm test` — if the pipe was removed the exit code is already safe, but this guard must be updated deliberately",
    );
    assert.equal(
      isPipefailProtected(step as string),
      true,
      "the step piping `npm test` is NOT pipefail-protected: without `set … pipefail`, `shell: bash`, or a PIPESTATUS check, the pipeline's exit status is tee's and a RED suite concludes the required `test` job GREEN (issue #3741)",
    );
  });

  test("`| tee` survives, so the suite still streams to the live job log", () => {
    const job = extractJobBlock(workflow, "test");
    const step = findSuiteStep(extractSteps(job as string));
    assert.match(
      step as string,
      /\|\s*tee\s+test-output\.txt/,
      "the `| tee test-output.txt` capture was removed — the count-ratchet grep reads that file and the job log loses the streamed suite output",
    );
  });

  test("the MIN_TESTS count floor is present and has not been lowered", () => {
    const job = extractJobBlock(workflow, "test");
    const step = findSuiteStep(extractSteps(job as string));
    const floor = extractMinTests(step as string);
    assert.notEqual(floor, null, "MIN_TESTS is no longer set in the suite step — the partial-collapse detector is gone");
    assert.ok(
      (floor as number) >= MIN_TESTS_FLOOR,
      `MIN_TESTS=${floor} is below the ratchet floor ${MIN_TESTS_FLOOR}; this floor may only ever move UP (issue #3741)`,
    );
  });
});

describe("pipefail mechanism — why the one-line fix works (#3741)", () => {
  // These pin the shell semantics the fix depends on, offline and with no CI
  // run. `false | tee /dev/null` is the exact shape of `npm test | tee …`: a
  // failing left-hand side feeding a command that always succeeds.
  test("`bash -e` alone does NOT propagate a failing pipeline element", () => {
    const r = spawnSync("bash", ["-e", "-c", "false | tee /dev/null"], { encoding: "utf8" });
    assert.equal(r.error, undefined, `failed to spawn bash: ${r.error?.message}`);
    assert.equal(
      r.status,
      0,
      "`bash -e -c 'false | tee /dev/null'` exited non-zero — the premise of #3741 (that -e alone masks a failing pipeline element) no longer holds on this bash; re-derive the fix before relaxing ci.yml",
    );
  });

  test("`bash -e -o pipefail` DOES propagate a failing pipeline element", () => {
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", "false | tee /dev/null"], {
      encoding: "utf8",
    });
    assert.equal(r.error, undefined, `failed to spawn bash: ${r.error?.message}`);
    assert.notEqual(
      r.status,
      0,
      "`bash -e -o pipefail -c 'false | tee /dev/null'` exited 0 — pipefail is not doing what ci.yml relies on",
    );
  });
});

describe("pipefail guard parsing helpers", () => {
  test("stripComments removes whole-line comments but keeps inline `#` text", () => {
    const stripped = stripComments("# a comment\n  # indented comment\nrun: grep '^# fail'\n");
    assert.equal(stripped.includes("a comment"), false);
    assert.equal(stripped.includes("indented comment"), false);
    assert.match(stripped, /grep '\^# fail'/);
  });

  test("isPipefailProtected accepts all three correct spellings", () => {
    assert.equal(isPipefailProtected("        run: |\n          set -o pipefail\n"), true);
    assert.equal(isPipefailProtected("        run: |\n          set -euo pipefail\n"), true);
    assert.equal(isPipefailProtected("        shell: bash\n        run: |\n"), true);
    assert.equal(
      isPipefailProtected('        run: |\n          npm test | tee o.txt\n          exit "${PIPESTATUS[0]}"\n'),
      true,
    );
  });

  test("isPipefailProtected rejects the unprotected original and prose-only mentions", () => {
    assert.equal(isPipefailProtected("        run: |\n          npm test 2>&1 | tee test-output.txt\n"), false);
    // A prose mention is not protection. (In the real check `stripComments`
    // has already removed such lines; this pins the predicate itself.)
    assert.equal(isPipefailProtected("        run: |\n          echo we should add pipefail one day\n"), false);
    assert.equal(isPipefailProtected("        shell: pwsh\n        run: |\n"), false);
  });

  test("extractMinTests reads the floor and returns null when absent", () => {
    assert.equal(extractMinTests("          MIN_TESTS=6000\n"), 6000);
    assert.equal(extractMinTests("          MIN_TESTS=450\n"), 450);
    assert.equal(extractMinTests("          echo hi\n"), null);
  });

  test("extractJobBlock isolates one job and returns null for an unknown key", () => {
    const wf = "jobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: npm test\n  deploy:\n    runs-on: self-hosted\n";
    const job = extractJobBlock(wf, "test");
    assert.match(job as string, /npm test/);
    assert.equal((job as string).includes("deploy"), false);
    assert.equal(extractJobBlock(wf, "nope"), null);
  });

  test("findSuiteStep picks the piping npm-test step, not its neighbours", () => {
    const steps = ["      - run: npm ci", "      - run: |\n          npm test 2>&1 | tee o.txt", "      - run: npm run build"];
    const step = findSuiteStep(steps);
    assert.match(step as string, /npm test/);
  });

  test("findSuiteStep returns null when no step pipes npm test", () => {
    assert.equal(findSuiteStep(["      - run: npm ci", "      - run: npm run build"]), null);
  });
});
