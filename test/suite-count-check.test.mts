/**
 * Tests for scripts/test/suite-count-check.mjs — the per-file top-level
 * suite/test count detector for the `--test-force-exit` silent-drop race
 * (issue #4020). See that file's header for the full mechanism.
 *
 * No Redis, no network — pure filesystem + string fixtures.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countTopLevelEntries,
  compareCapture,
  testFilesFromArgs,
} from "../scripts/test/suite-count-check.mjs";

describe("suite-count-check — countTopLevelEntries (static source scan)", () => {
  test("counts top-level describe() calls", () => {
    const src = `
describe("a", () => {
  test("x", () => {});
});
describe("b", () => {
  test("y", () => {});
});
`;
    assert.equal(countTopLevelEntries(src), 2);
  });

  test("counts bare top-level test() calls not wrapped in describe", () => {
    const src = `
test("a", () => {});
test("b", () => {});
test("c", async () => {});
`;
    assert.equal(countTopLevelEntries(src), 3);
  });

  test("does not count nested test()/describe() calls", () => {
    const src = `
describe("outer", () => {
  test("inner 1", () => {});
  describe("nested describe", () => {
    test("inner 2", () => {});
  });
});
`;
    // Only "outer" is top-level; everything else is nested inside its callback.
    assert.equal(countTopLevelEntries(src), 1);
  });

  test("counts describe.skip/.only/.todo the same as a plain call", () => {
    const src = `
describe.skip("a", () => {});
test.only("b", () => {});
describe.todo("c", () => {});
`;
    assert.equal(countTopLevelEntries(src), 3);
  });

  test("handles the 3-arg test(name, options, fn) form (test/build-spritesheet.test.mts shape)", () => {
    // The options object's own `{` must NOT be mistaken for the callback body
    // — it is preceded by neither `=>` nor a `function (...)` header.
    const src = `
test("a", { skip: "reason" }, () => {
  test("should not be reachable in this fixture, but if mis-parsed as inline this would still be a describe/test call");
});
test("b", { skip: false }, () => {});
`;
    assert.equal(countTopLevelEntries(src), 2);
  });

  test("ignores describe/test-looking text inside comments and strings", () => {
    const src = `
// describe("fake top-level from a comment", () => {});
const s = "describe(\\"also fake, inside a string\\", () => {})";
/* describe("fake, block comment", () => {}); */
describe("real one", () => {
  test("x", () => {});
});
`;
    assert.equal(countTopLevelEntries(src), 1);
  });

  test("a bare top-level for-loop does not itself add nesting (only a describe/test callback does)", () => {
    // Mirrors test/hydra-dev-reflection-deposit.test.mts's shape: a for-loop
    // is not a describe/test call, so a describe() call site directly inside
    // it is still top-level. Known, documented limitation: this counts the
    // CALL SITE once — it does not evaluate the loop to know how many times it
    // fires at runtime (see STATIC_COUNT_OVERRIDES in the source module).
    const src = `
for (const name of ["a", "b"]) {
  describe(\`\${name} suite\`, () => {
    test("x", () => {});
  });
}
describe("also top-level", () => {});
`;
    assert.equal(countTopLevelEntries(src), 2);
  });

  test("a regex literal containing a quote character does not corrupt downstream brace tracking (real bug, #4020 PR)", () => {
    // Discovered against test/branch-prune-script.test.mts: a regex literal
    // like /"\$FOO"/ (matching quoted shell-script text) was previously
    // mistaken for a real string starting at its embedded `"`, which then
    // consumed real code (including a later describe/test call's braces) as
    // if it were still "inside a string" — corrupting every count after it.
    // True count here is 1 (one top-level describe; the nested test() reads
    // a regex containing a literal double-quote and must not be miscounted
    // as ending the outer describe early or opening a phantom nested scope).
    const src = `
describe("outer", () => {
  test("matches quoted text", () => {
    const text = "some source";
    const match = text.match(/if \\[ "\\$FOO" -gt 0 \\]; then/);
    assert.ok(match);
  });
});
describe("also top-level, must still be seen", () => {});
`;
    assert.equal(countTopLevelEntries(src), 2);
  });

  test("a regex literal with a {n} quantifier does not leak real braces (real bug, #4020 PR)", () => {
    const src = `
describe("outer", () => {
  test("checks a mode string", () => {
    assert.match(mode, /^[7][0-9]{2}$/);
  });
});
`;
    assert.equal(countTopLevelEntries(src), 1);
  });

  test("RegExp.prototype.test(...) is NOT mistaken for node:test's test() (real bug, #4020 PR)", () => {
    // Discovered against test/autopilot-hooks.test.mts: `someRegex.test(x)`
    // (JS's built-in RegExp method, used throughout this suite to assert
    // against captured shell/log output) matched the old "\btest\s*\(" regex
    // as a false top-level test() call — inflating the file's baseline from
    // a true 6 to a miscounted 9 (three `.test(` call sites). A DOT
    // immediately before "test"/"describe" means it's a property access on
    // some other value, never node:test's own function.
    const src = `
function isDone(lines, i) {
  while (/^ok/.test(lines[i])) {
    i++;
  }
  return i;
}
describe("real one", () => {
  test("x", () => {});
});
`;
    assert.equal(countTopLevelEntries(src), 1);
  });

  test("describe.skip(...) / test.only(...) still count — the dot-exclusion only blocks a DIFFERENT object's property access", () => {
    // Guards against an overcorrection: the (?<!\.) fix must not also reject
    // the legitimate `describe.skip(`/`test.only(` suffix-modifier form,
    // since there the dot sits AFTER "describe"/"test", not before it.
    const src = `
describe.skip("a", () => {});
test.only("b", () => {});
`;
    assert.equal(countTopLevelEntries(src), 2);
  });
});

describe("suite-count-check — testFilesFromArgs", () => {
  test("extracts only .test.mts args, preserving order", () => {
    const args = [
      "--test-force-exit",
      "test/foo.test.mts",
      "--test-concurrency=1",
      "test/bar.test.mts",
    ];
    assert.deepEqual(testFilesFromArgs(args), ["test/foo.test.mts", "test/bar.test.mts"]);
  });

  test("returns an empty array when no test files are present", () => {
    assert.deepEqual(testFilesFromArgs(["--print-url"]), []);
  });
});

describe("suite-count-check — compareCapture (comparator)", () => {
  const scratchDirs: string[] = [];
  after(() => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* intentional: best-effort scratch-dir cleanup on teardown */
      }
    }
  });

  function writeCapture(lines: Array<{ file: string; name: string; ok: boolean }>): string {
    const dir = mkdtempSync(join(tmpdir(), "hydra-suite-count-"));
    scratchDirs.push(dir);
    const path = join(dir, "capture.ndjson");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  test("ok=true when every relevant file meets its baseline", () => {
    const capturePath = writeCapture([
      { file: "test/a.test.mts", name: "s1", ok: true },
      { file: "test/a.test.mts", name: "s2", ok: true },
      { file: "test/b.test.mts", name: "s1", ok: true },
    ]);
    const baseline = { "test/a.test.mts": 2, "test/b.test.mts": 1 };
    const result = compareCapture({
      capturePath,
      baseline,
      testFiles: ["test/a.test.mts", "test/b.test.mts"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.shortfalls, []);
    assert.equal(result.checkedFileCount, 2);
  });

  test("ok=false and names the file + counts when observed is under baseline", () => {
    const capturePath = writeCapture([
      { file: "test/a.test.mts", name: "s1", ok: true },
      // s2 dropped — only 1 of the expected 2 top-level entries fired.
    ]);
    const baseline = { "test/a.test.mts": 2 };
    const result = compareCapture({
      capturePath,
      baseline,
      testFiles: ["test/a.test.mts"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.shortfalls, [{ file: "test/a.test.mts", expected: 2, observed: 0 + 1 }]);
  });

  test("a fully-dropped file (zero capture lines) is a MISSING file, not a shortfall (#4141)", () => {
    // This is the worst case the design doc calls out explicitly: a file with
    // NO capture lines at all must not be treated as "wasn't part of this
    // run" when it WAS named in testFiles.
    //
    // Since #4141 it is also reported in its own bucket. The two verdicts
    // carry opposite evidential weight — a partial shortfall is the #4137
    // reporter truncation and is advisory; zero entries means the file never
    // executed, which is deterministic and blocks — so they must not share a
    // list.
    const capturePath = writeCapture([
      { file: "test/other.test.mts", name: "s1", ok: true },
    ]);
    const baseline = { "test/a.test.mts": 3, "test/other.test.mts": 1 };
    const result = compareCapture({
      capturePath,
      baseline,
      testFiles: ["test/a.test.mts", "test/other.test.mts"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFiles, [{ file: "test/a.test.mts", expected: 3, observed: 0 }]);
    assert.deepEqual(result.shortfalls, [], "a zero-entry file must NOT also appear as a shortfall");
  });

  test("partial and zero verdicts are separated in the same run (#4141)", () => {
    // The discriminating case: one file truncated (advisory) and one absent
    // (blocking) at once. Collapsing them would either wedge the merge queue
    // on truncation or let a dropped file through on a technicality.
    const capturePath = writeCapture([
      { file: "test/partial.test.mts", name: "s1", ok: true },
    ]);
    const baseline = { "test/partial.test.mts": 4, "test/absent.test.mts": 2 };
    const result = compareCapture({
      capturePath,
      baseline,
      testFiles: ["test/partial.test.mts", "test/absent.test.mts"],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.shortfalls, [
      { file: "test/partial.test.mts", expected: 4, observed: 1 },
    ]);
    assert.deepEqual(result.missingFiles, [
      { file: "test/absent.test.mts", expected: 2, observed: 0 },
    ]);
  });

  test("an out-of-run file is never a missing file — single-file runs stay safe (#4141)", () => {
    // The zero-entry verdict blocks, so a false positive here would be an
    // ambient poison pill: `npm run test:file -- one.test.mts` must not fail
    // the other ~450 baselined files, every one of which observed zero.
    const capturePath = writeCapture([{ file: "test/a.test.mts", name: "s1", ok: true }]);
    const result = compareCapture({
      capturePath,
      baseline: { "test/a.test.mts": 1, "test/elsewhere.test.mts": 30 },
      testFiles: ["test/a.test.mts"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFiles, []);
  });

  test("a fully-SKIPPED file is not a missing file — skips still emit entries (#4141)", () => {
    // Verified against node:test rather than assumed (the issue asked for
    // exactly this check): a suite and a test both declared `{ skip: true }`
    // still each emit a top-level `test:pass` event, so a skipped file
    // observes its full baseline count and never reaches the zero verdict.
    const capturePath = writeCapture([
      { file: "test/all-skipped.test.mts", name: "skipped suite", ok: true },
      { file: "test/all-skipped.test.mts", name: "skipped test", ok: true },
    ]);
    const result = compareCapture({
      capturePath,
      baseline: { "test/all-skipped.test.mts": 2 },
      testFiles: ["test/all-skipped.test.mts"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFiles, []);
  });

  test("a baseline of 0 never produces a missing-file verdict", () => {
    // Guard against `expected > 0` being dropped from the condition: a file
    // baselined at 0 observing 0 is correct, not a regression.
    const capturePath = writeCapture([{ file: "test/other.test.mts", name: "s", ok: true }]);
    const result = compareCapture({
      capturePath,
      baseline: { "test/zero.test.mts": 0, "test/other.test.mts": 1 },
      testFiles: ["test/zero.test.mts", "test/other.test.mts"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFiles, []);
  });

  test("a file with no baseline entry is never checked (new file, no manifest row yet)", () => {
    const capturePath = writeCapture([
      { file: "test/brand-new.test.mts", name: "s1", ok: true },
    ]);
    const result = compareCapture({
      capturePath,
      baseline: {},
      testFiles: ["test/brand-new.test.mts"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.checkedFileCount, 0);
  });

  test("only checks files named in testFiles — a single-file run never flags every OTHER baselined file", () => {
    const capturePath = writeCapture([
      { file: "test/a.test.mts", name: "s1", ok: true },
    ]);
    // Baseline has many files with high expected counts, but only test/a.test.mts
    // was part of THIS run.
    const baseline = {
      "test/a.test.mts": 1,
      "test/never-ran-1.test.mts": 50,
      "test/never-ran-2.test.mts": 100,
    };
    const result = compareCapture({
      capturePath,
      baseline,
      testFiles: ["test/a.test.mts"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.checkedFileCount, 1);
  });

  test("missing capture file reports a readError but does not throw", () => {
    const result = compareCapture({
      capturePath: "/nonexistent/path/capture.ndjson",
      baseline: { "test/a.test.mts": 1 },
      testFiles: ["test/a.test.mts"],
    });
    assert.ok(result.readError, "must surface a readError for a missing capture file");
    // With no capture data, everything relevant is a 0-vs-expected shortfall.
    assert.equal(result.ok, false);
  });

  test("tolerates a truncated/corrupt final NDJSON line without failing the whole comparison", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-suite-count-"));
    scratchDirs.push(dir);
    const path = join(dir, "capture.ndjson");
    writeFileSync(
      path,
      `${JSON.stringify({ file: "test/a.test.mts", name: "s1", ok: true })}\n{"file":"test/a.test.mts","name":"s2","ok":tr`,
    );
    const result = compareCapture({
      capturePath: path,
      baseline: { "test/a.test.mts": 1 },
      testFiles: ["test/a.test.mts"],
    });
    assert.equal(result.ok, true, "the one valid line already meets baseline 1");
  });
});
