/**
 * Direct unit tests for src/mutation-gate-inputs.ts — the shared pure-leaf
 * seam extracted in issue #4346 from the hand-duplicated copies in
 * scripts/ci/mutation-check.ts (Orchestrator gate) and
 * scripts/target/mutation-check.ts (Target gate).
 *
 * The leaf lives under src/ deliberately (design-concept INV-10): the PR's own
 * mutation gate mutates only src/**\/*.ts, so placing the shared helpers there
 * puts them under the kill-rate floor. Every branch below is asserted
 * directly so mutants survive nowhere:
 *
 *   isQuickFix         — match / miss / case-insensitivity / empty body.
 *   parseIntEnv        — unset / empty / NaN / negative → fallback;
 *                         zero and valid integers → parsed.
 *   parseChangedFiles  — newline / CRLF / space / tab / mixed runs → one
 *                         entry per path; empty and whitespace-only → [];
 *                         non-string → []. Newline-only input parses
 *                         byte-identically to the legacy newline-only split
 *                         (the CI contract — ci.yml feeds newline-separated
 *                         git diff output).
 *   readChangedFiles   — the env seam delegates to parseChangedFiles on
 *                         CHANGED_FILES (empty env → []).
 *   classifyTimedOut   — null when not timed out; warn WITH testable
 *                         mutants (partial kill rate + counts in the
 *                         reason); warn WITHOUT testable mutants (null kill
 *                         rate, n/a in the reason).
 *
 * classifyNoSignal is deliberately NOT tested here — it stays separate in
 * each gate (design-concept INV-4: the tier ladder vs the money-critical
 * boolean is policy divergence, not drift) and is covered by each gate's own
 * test file.
 *
 * All helpers are pure (the only impurity is parseIntEnv/readChangedFiles
 * reading process.env, exercised via a saved/restored env mutation) — no
 * git, no filesystem, no Redis, no network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isQuickFix,
  parseIntEnv,
  parseChangedFiles,
  readChangedFiles,
  classifyTimedOut,
} from "../src/mutation-gate-inputs.ts";
import type { MutationTestReport } from "../src/mutation.ts";

/**
 * Build a MutationTestReport for the classifyTimedOut tests. Only the fields
 * the helper reads (totalMutants, skipped, killed, timedOut,
 * candidatesGenerated) are meaningful; the rest are inert placeholders.
 */
function makeReport(
  partial: Partial<MutationTestReport>,
): MutationTestReport {
  return {
    candidatesGenerated: 0,
    totalMutants: 0,
    skipped: 0,
    killed: 0,
    survived: 0,
    durationMs: 0,
    timedOut: false,
    survivors: [],
    inconclusive: 0,
    noCoverage: 0,
    filesMutated: [],
    ...partial,
  } as MutationTestReport;
}

describe("isQuickFix (shared leaf, issue #4346)", () => {
  test("quick-fix match, miss, case-insensitivity, empty body", () => {
    assert.equal(isQuickFix("has a [quick-fix] tag"), true, "must match the tag");
    assert.equal(isQuickFix("has a [Quick-Fix] tag"), true, "must match case-insensitively");
    assert.equal(isQuickFix("no tag here"), false, "must miss without the tag");
    assert.equal(isQuickFix(""), false, "empty body must not match");
  });
});

describe("parseIntEnv (shared leaf, issue #4346)", () => {
  test("unset / empty / NaN / negative → fallback; zero / valid → parsed", () => {
    const cases: Array<[string | undefined, number]> = [
      [undefined, 42], // unset
      ["", 42], // empty
      ["garbage", 42], // NaN after parseInt
      ["-5", 42], // negative
      ["0", 0], // zero is accepted
      ["30", 30], // valid
    ];
    for (const [raw, expected] of cases) {
      const name = "MUTATION_TEST_ENV_PROBE";
      const saved = process.env[name];
      try {
        if (raw === undefined) delete process.env[name];
        else process.env[name] = raw;
        assert.equal(parseIntEnv(name, 42), expected, `env=${JSON.stringify(raw)}`);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
  });
});

describe("parseChangedFiles (shared leaf, issue #3803 via #4346)", () => {
  test("newline-only input parses byte-identically to the legacy newline split (the CI contract)", () => {
    const raw = "src/a.ts\nsrc/b.ts\r\nsrc/c.ts\n\n  \nsrc/d.ts\n";
    assert.deepEqual(parseChangedFiles(raw), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  test("space-, tab- and mixed-separated input (hand invocation) → one entry per path", () => {
    assert.deepEqual(
      parseChangedFiles("web/src/a.ts web/src/b.ts"),
      ["web/src/a.ts", "web/src/b.ts"],
    );
    assert.deepEqual(parseChangedFiles("src/a.ts\tsrc/b.ts"), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(parseChangedFiles(" src/a.ts  \n\t src/b.ts "), ["src/a.ts", "src/b.ts"]);
  });

  test("empty / whitespace-only / non-string input → []", () => {
    assert.deepEqual(parseChangedFiles(""), []);
    assert.deepEqual(parseChangedFiles("  \n\t "), []);
    assert.deepEqual(parseChangedFiles(undefined as unknown as string), []);
  });
});

describe("readChangedFiles (env seam, issue #4346)", () => {
  test("reads CHANGED_FILES through parseChangedFiles; empty env → []", () => {
    const saved = process.env.CHANGED_FILES;
    try {
      delete process.env.CHANGED_FILES;
      assert.deepEqual(readChangedFiles(), []);
      process.env.CHANGED_FILES = "src/a.ts\nsrc/b.ts";
      assert.deepEqual(readChangedFiles(), ["src/a.ts", "src/b.ts"]);
      process.env.CHANGED_FILES = "src/a.ts src/b.ts";
      assert.deepEqual(readChangedFiles(), ["src/a.ts", "src/b.ts"]);
    } finally {
      if (saved === undefined) delete process.env.CHANGED_FILES;
      else process.env.CHANGED_FILES = saved;
    }
  });
});

describe("classifyTimedOut (shared leaf, issues #2393/#1821 via #4346)", () => {
  test("returns null when the runner did NOT time out", () => {
    const r = classifyTimedOut(makeReport({ totalMutants: 3, skipped: 0, killed: 3, timedOut: false }));
    assert.equal(r, null);
  });

  test("timed out WITH testable mutants → warn, partial kill rate + counts in the reason", () => {
    const r = classifyTimedOut(
      makeReport({ totalMutants: 75, skipped: 0, killed: 40, candidatesGenerated: 553, timedOut: true }),
    );
    assert.ok(r, "a timed-out report must classify");
    assert.equal(r.status, "warn");
    assert.equal(r.timedOut, true);
    assert.equal(r.killRate, 53, "partial kill rate is 40/75 rounded");
    assert.match(r.reason, /timed out before evaluating all mutants/);
    assert.match(r.reason, /75 of 553/);
    assert.match(r.reason, /53%/);
  });

  test("timed out WITHOUT testable mutants → warn, null kill rate, n/a in the reason", () => {
    const r = classifyTimedOut(
      makeReport({ totalMutants: 0, skipped: 0, killed: 0, candidatesGenerated: 10, timedOut: true }),
    );
    assert.ok(r, "a timed-out report must classify");
    assert.equal(r.status, "warn");
    assert.equal(r.killRate, null);
    assert.match(r.reason, /n\/a/);
  });

  test("issue #4504: inconclusive + no-coverage mutants are excluded from the partial-rate denominator", () => {
    // 10 run: 3 killed, 1 survived, 4 inconclusive, 2 no-coverage → 3/4 = 75%.
    const r = classifyTimedOut(
      makeReport({
        totalMutants: 10,
        skipped: 0,
        killed: 3,
        survived: 1,
        inconclusive: 4,
        noCoverage: 2,
        candidatesGenerated: 40,
        timedOut: true,
      }),
    );
    assert.ok(r);
    assert.equal(r.killRate, 75, "denominator is conclusive mutants (killed + survived) only");
  });

  test("issue #4504: all-inconclusive timed-out run → null kill rate (never a fabricated 100%)", () => {
    const r = classifyTimedOut(
      makeReport({ totalMutants: 12, skipped: 0, killed: 0, inconclusive: 12, candidatesGenerated: 17, timedOut: true }),
    );
    assert.ok(r);
    assert.equal(r.killRate, null);
  });
});
