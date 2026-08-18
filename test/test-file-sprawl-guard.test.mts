/**
 * Ratchet: a test subject may not gain test files (issue #4134).
 *
 * WHY THIS EXISTS. The suite grew one test file per ISSUE rather than per
 * module — `scripts/autopilot/decide.py` owns 20 test files,
 * `scripts/autopilot/collect-state.sh` 8, `src/autopilot/anchor-type.ts` 6 —
 * and 14 files carry a bare issue number in their basename. It costs nothing
 * at runtime and a great deal in agent context: every dispatch touching one
 * module must first discover and read a dozen files. Epic #4131 measured this
 * as the largest single drain on operator Claude quota in the suite.
 *
 * WHY A RATCHET AND NOT A SWEEP. Consolidating the existing clusters (#4136,
 * #4139, #4140) fixes today's files and nothing else. Without a guard the
 * clusters simply regrow — the same shape as #4044, whose static enumeration
 * of 3 files was overtaken by 2 more written inside its own open window.
 *
 * WHY A TEST RATHER THAN A CI WORKFLOW. A sibling advisory workflow cannot
 * block a merge — operator memory records that no seam check in this repo is a
 * required check, so a red ratchet is routed around. Only checks inside the
 * already-required `test` job block, and running here needs no workflow edit
 * (which would land in the Verifier Core). Same reasoning, same lane, as
 * test/watchdog-spawn-timeout-ratchet.test.mts.
 *
 * HOW TO SATISFY IT. Add your cases to the test file that already covers the
 * subject. If a new file is genuinely right, regenerate the baseline in the
 * same PR:
 *
 *     npx tsx scripts/ci/test-subject-map.ts --update-baseline
 *
 * That bump is visible in the diff and reviewable. It is deliberately the
 * escape hatch INSTEAD of a marker in the PR body: a PR-body hatch would mean
 * reading GITHUB_EVENT_PATH from inside the suite, which is exactly the
 * coupling #4132 removed after it caused 12 of 19 red `test` jobs and could
 * not self-clear on a re-run.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  buildSubjectCounts,
  findOvergrowth,
  resolvePrimarySubjects,
  countBySubject,
  srcImportsOf,
  scriptTargetsOf,
  stripComments,
  readTestFacts,
  TEST_DIR,
  BASELINE_PATH,
  type FileFacts,
} from "../scripts/ci/test-subject-map.ts";

describe("test-file sprawl ratchet — live tree (#4134)", () => {
  test("the baseline exists and is regenerable", () => {
    assert.ok(existsSync(BASELINE_PATH), `missing ${BASELINE_PATH}`);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    assert.ok(Object.keys(baseline).length > 100, "baseline looks truncated");
  });

  test("no subject owns more test files than its baseline allows", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const observed = buildSubjectCounts(TEST_DIR);
    const grown = findOvergrowth(observed, baseline);
    assert.deepEqual(
      grown,
      [],
      grown.length === 0
        ? ""
        : `Test-file sprawl: ${grown.length} subject(s) gained test files.\n` +
            grown
              .map(
                (g) =>
                  `  ${g.subject}: ${g.observed} files (baseline ${g.baseline})`,
              )
              .join("\n") +
            `\n\nAdd your cases to the file that already covers the subject. If a new\n` +
            `file is genuinely right, regenerate the baseline in this PR:\n` +
            `  npx tsx scripts/ci/test-subject-map.ts --update-baseline`,
    );
  });

  test("the ratchet is a going-forward guard — it does not fire on today's tree", () => {
    // Guards the guard: the existing clusters are grandfathered on purpose. A
    // ratchet that starts red is an ambient poison pill, not a gate.
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const observed = buildSubjectCounts(TEST_DIR);
    for (const [subject, count] of Object.entries(observed)) {
      if (count > 1) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(baseline, subject),
          `subject ${subject} owns ${count} files but is absent from the baseline`,
        );
      }
    }
  });
});

describe("test-file sprawl ratchet — subject resolution (#4134)", () => {
  test("a spawn-only file resolves to its script target, not to nothing", () => {
    // THE load-bearing case: all 14 decide-*.test.mts files import ZERO from
    // ../src and instead spawn scripts/autopilot/decide.py. An import-only
    // rule misses the largest cluster in the suite entirely.
    const source = `
      import { test } from "node:test";
      const OUT = spawnSync("python3", ["scripts/autopilot/decide.py", "--json"]);
    `;
    assert.deepEqual(srcImportsOf(source), []);
    assert.deepEqual(scriptTargetsOf(source), ["scripts/autopilot/decide.py"]);

    const facts: FileFacts[] = [
      { file: "test/decide-a.test.mts", srcImports: [], scriptTargets: ["scripts/autopilot/decide.py"] },
    ];
    const subjects = resolvePrimarySubjects(facts);
    assert.equal(subjects.get("test/decide-a.test.mts"), "scripts/autopilot/decide.py");
  });

  test("the script target wins over imports when a file does both", () => {
    const facts: FileFacts[] = [
      {
        file: "test/x.test.mts",
        srcImports: ["src/redis/connection.ts"],
        scriptTargets: ["scripts/autopilot/reap.py"],
      },
    ];
    assert.equal(resolvePrimarySubjects(facts).get("test/x.test.mts"), "scripts/autopilot/reap.py");
  });

  test("the RAREST import wins — shared plumbing is never the subject", () => {
    // src/redis/connection.ts is imported by 23 test files and is a utility.
    // Keying on it would fire the ratchet on unrelated work.
    const facts: FileFacts[] = [
      { file: "test/a.test.mts", srcImports: ["src/redis/connection.ts"], scriptTargets: [] },
      { file: "test/b.test.mts", srcImports: ["src/redis/connection.ts"], scriptTargets: [] },
      { file: "test/c.test.mts", srcImports: ["src/redis/connection.ts"], scriptTargets: [] },
      {
        file: "test/d.test.mts",
        srcImports: ["src/redis/connection.ts", "src/autopilot/anchor-type.ts"],
        scriptTargets: [],
      },
    ];
    const subjects = resolvePrimarySubjects(facts);
    assert.equal(subjects.get("test/d.test.mts"), "src/autopilot/anchor-type.ts");
  });

  test("a file with neither signal has no subject and is never ratcheted", () => {
    const facts: FileFacts[] = [{ file: "test/doc.test.mts", srcImports: [], scriptTargets: [] }];
    assert.equal(resolvePrimarySubjects(facts).get("test/doc.test.mts"), null);
    assert.deepEqual(countBySubject(resolvePrimarySubjects(facts)), {});
  });

  test("subject resolution is stable — ties break deterministically", () => {
    const facts: FileFacts[] = [
      { file: "test/a.test.mts", srcImports: ["src/z.ts", "src/a.ts"], scriptTargets: [] },
    ];
    // Both imported once; the path-sorted first wins, every run.
    assert.equal(resolvePrimarySubjects(facts).get("test/a.test.mts"), "src/a.ts");
  });
});

describe("test-file sprawl ratchet — subjects come from CODE, not prose (#4136 follow-up)", () => {
  // A prose mention used to outrank everything a file actually did. Because a
  // single scripts/** target wins the specificity ladder outright, ONE
  // backticked path in a JSDoc block decided the subject:
  //
  //   test/api-scheduler.test.mts:154  // brain (`scripts/autopilot/decide.py`)
  //
  // Three API tests were attributed to decide.py that way. It inflated its
  // baseline to 12 against a true 9 — three units of slack in a ratchet whose
  // entire job is resisting growth.

  test("a path mentioned only in a line comment is not a target", () => {
    const source = `
      // the brain (\`scripts/autopilot/decide.py\`) emits this
      import { test } from "node:test";
    `;
    assert.deepEqual(scriptTargetsOf(source), []);
  });

  test("a path mentioned only in a JSDoc block is not a target", () => {
    const source = [
      "/**",
      " * Mirrors the action emitted by `scripts/autopilot/decide.py`, so the",
      " * dashboard can correlate it.",
      " */",
      'import Redis from "ioredis";',
    ].join("\n");
    assert.deepEqual(scriptTargetsOf(source), []);
  });

  test("a src import mentioned only in a comment is not an import", () => {
    const source = `// see from "../src/autopilot/anchor-type.ts" for the ladder\nconst x = 1;`;
    assert.deepEqual(srcImportsOf(source), []);
  });

  test("stripComments keeps string and template contents verbatim", () => {
    // The whole point: comments go, strings stay. A URL's "//" must not be
    // read as a comment, and a quote inside a comment must not open a string.
    const src = 'const u = "https://x/y"; // don\'t break here\nconst v = `a/*b*/c`;';
    const out = stripComments(src);
    assert.match(out, /"https:\/\/x\/y"/);
    assert.match(out, /`a\/\*b\*\/c`/);
    assert.ok(!out.includes("break here"), "the line comment must be gone");
  });

  test("a segment-built path IS a target — join(ROOT, \"scripts\", ..., \"x.py\")", () => {
    // Most files build the path a segment at a time, which the whole-path
    // pattern never matched. That went unnoticed only because the header
    // comment matched instead — right answer, wrong reason.
    const source = `const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");`;
    assert.deepEqual(scriptTargetsOf(source), ["scripts/autopilot/decide.py"]);
  });

  test("a two-step segment build is resolved through its binding", () => {
    const source = [
      'const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");',
      'const DECIDE = join(SCRIPTS, "decide.py");',
    ].join("\n");
    assert.deepEqual(scriptTargetsOf(source), ["scripts/autopilot/decide.py"]);
  });

  test("resolve() builds a path the same way join() does", () => {
    const source = `const D = resolve(REPO_ROOT, "scripts", "autopilot", "decide.py");`;
    assert.deepEqual(scriptTargetsOf(source), ["scripts/autopilot/decide.py"]);
  });

  test("a whole-path string literal still works", () => {
    const source = `spawnSync("python3", ["scripts/autopilot/decide.py", "--json"]);`;
    assert.deepEqual(scriptTargetsOf(source), ["scripts/autopilot/decide.py"]);
  });

  test("the live tree has no subject resolved purely from prose", () => {
    // Regression on the real files: all three were decide.py, none executes it.
    const subjects = resolvePrimarySubjects(readTestFacts(TEST_DIR));
    for (const f of [
      "test/api-scheduler.test.mts",
      "test/scheduler-status.test.mts",
      "test/agent-stream-correlation.test.mts",
    ]) {
      assert.notEqual(
        subjects.get(f),
        "scripts/autopilot/decide.py",
        `${f} mentions decide.py only in a comment and must not be attributed to it`,
      );
    }
  });
});

describe("test-file sprawl ratchet — growth detection (#4134)", () => {
  test("a NEW file for an already-covered subject fails", () => {
    const grown = findOvergrowth(
      { "scripts/autopilot/decide.py": 21 },
      { "scripts/autopilot/decide.py": 20 },
    );
    assert.equal(grown.length, 1);
    assert.deepEqual(grown[0], {
      subject: "scripts/autopilot/decide.py",
      baseline: 20,
      observed: 21,
    });
  });

  test("a first test file for a genuinely NEW subject passes", () => {
    assert.deepEqual(findOvergrowth({ "src/brand-new.ts": 1 }, {}), []);
  });

  test("a SECOND file for an unbaselined subject is already sprawl", () => {
    const grown = findOvergrowth({ "src/brand-new.ts": 2 }, {});
    assert.equal(grown.length, 1);
    assert.equal(grown[0].baseline, 1);
  });

  test("consolidating a cluster passes — the ratchet only resists growth", () => {
    // #4136 merges 14 decide-* files into one. That must not fail the guard.
    assert.deepEqual(
      findOvergrowth({ "scripts/autopilot/decide.py": 7 }, { "scripts/autopilot/decide.py": 20 }),
      [],
    );
  });

  test("holding steady passes", () => {
    assert.deepEqual(findOvergrowth({ "src/a.ts": 3 }, { "src/a.ts": 3 }), []);
  });

  test("the report is ordered worst-first so the message leads with the real offender", () => {
    const grown = findOvergrowth(
      { "src/a.ts": 2, "src/b.ts": 9 },
      { "src/a.ts": 1, "src/b.ts": 1 },
    );
    assert.equal(grown[0].subject, "src/b.ts");
  });
});
