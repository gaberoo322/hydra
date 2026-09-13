/**
 * Tests for scripts/test/suite-count-check.mjs — the per-file top-level
 * suite/test count detector for the `--test-force-exit` silent-drop race
 * (issue #4020). See that file's header for the full mechanism.
 *
 * Also the designated test surface for issue #4292 (the #4043 recurrence:
 * the advisory suite-count gate's isolated-retry phase OOM-killed the
 * required `test` job, exit 137, AFTER the suite had already passed): the
 * retry-skip / exit-code / wording / observability pins for
 * scripts/test/redis-db-launch.mjs live further down, next to the design
 * invariants (INV-1..INV-9) they discharge.
 *
 * No Redis, no network — pure filesystem + string fixtures.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countTopLevelEntries,
  compareCapture,
  fileCoverageDiff,
  testFilesFromArgs,
} from "../scripts/test/suite-count-check.mjs";
import {
  shortfallRetrySuffix,
  launcherInfraKillLine,
  launcherIdentityLine,
  readOwnPgid,
  RETRY_TIMEOUT_MS,
  isGateBlocking,
  isFullSuiteRun,
  describeIncompleteRun,
  knownRunnerSlot,
  deriveDbIndex,
  parseOwnedDbIndex,
  redisChildEnv,
  resolveRedisUrl,
} from "../scripts/test/redis-db-launch.mjs";

const LAUNCHER_SOURCE = readFileSync(
  fileURLToPath(new URL("../scripts/test/redis-db-launch.mjs", import.meta.url)),
  "utf8",
);

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

// =============================================================================
// fileCoverageDiff — the one drop-detection --test-force-exit cannot reach
// (issue #4141).
//
// The count-based verdicts consult the reporter capture, so they inherit its
// truncation. This one compares two static lists — what the baseline says the
// suite contains, and what the runner was told to run — and consults no
// capture at all. Its own top-level suite with its own lifecycle.
// =============================================================================
describe("suite-count-check — fileCoverageDiff (issue #4141)", () => {
  const ROOT = "/repo";
  const baseline = { "test/a.test.mts": 3, "test/b.test.mts": 5, "test/c.test.mts": 1 };

  test("a run that covers exactly the baselined set is clean", () => {
    const r = fileCoverageDiff({
      baseline,
      testFiles: ["test/a.test.mts", "test/b.test.mts", "test/c.test.mts"],
      repoRoot: ROOT,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.droppedFromRun, []);
    assert.deepEqual(r.unbaselined, []);
  });

  test("THE MOTIVATING CASE: a baselined file the runner was never told to run", () => {
    // This is what a glob or runner-config change looks like from here, and it
    // is exactly what compareCapture cannot see: the dropped file is absent
    // from testFiles, so the count comparison never inspects it.
    const r = fileCoverageDiff({
      baseline,
      testFiles: ["test/a.test.mts", "test/c.test.mts"],
      repoRoot: ROOT,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.droppedFromRun, ["test/b.test.mts"]);
    assert.deepEqual(r.unbaselined, []);
  });

  test("a file that ran but is not baselined is reported too — it sits outside every count verdict", () => {
    const r = fileCoverageDiff({
      baseline,
      testFiles: ["test/a.test.mts", "test/b.test.mts", "test/c.test.mts", "test/new.test.mts"],
      repoRoot: ROOT,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unbaselined, ["test/new.test.mts"]);
    assert.deepEqual(r.droppedFromRun, []);
  });

  test("both directions are reported together, each sorted, never one masking the other", () => {
    const r = fileCoverageDiff({
      baseline,
      testFiles: ["test/c.test.mts", "test/z.test.mts", "test/n.test.mts"],
      repoRoot: ROOT,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.droppedFromRun, ["test/a.test.mts", "test/b.test.mts"]);
    assert.deepEqual(r.unbaselined, ["test/n.test.mts", "test/z.test.mts"]);
  });

  test("absolute and redundant relative paths normalise to the repo-relative form", () => {
    // `npm test` passes a shell-expanded glob; other callers pass absolute
    // paths. A path-shape difference must never read as a dropped file.
    const r = fileCoverageDiff({
      baseline,
      testFiles: ["/repo/test/a.test.mts", "./test/b.test.mts", "test/./c.test.mts"],
      repoRoot: ROOT,
    });
    assert.equal(r.ok, true, `expected clean, got ${JSON.stringify(r)}`);
  });

  test("an empty baseline never invents a dropped file", () => {
    const r = fileCoverageDiff({ baseline: {}, testFiles: ["test/a.test.mts"], repoRoot: ROOT });
    assert.deepEqual(r.droppedFromRun, []);
    assert.deepEqual(r.unbaselined, ["test/a.test.mts"]);
  });

  test("the verdict is independent of any capture — no reporter output is consulted", () => {
    // Pinning the property that makes this the only blockable verdict: the
    // function takes no capture path, so #4137's truncation has no route in.
    const params = fileCoverageDiff.length;
    assert.equal(params, 1, "fileCoverageDiff takes a single options object");
    const src = fileCoverageDiff.toString();
    assert.ok(!/capturePath|parseCapture|observedByFile/.test(src), "fileCoverageDiff must not read the capture");
  });
});

// =============================================================================
// redis-db-launch — issue #4292: the advisory gate's isolated-retry phase
// OOM-killed the required `test` job (exit 137, #4043 recurrence) AFTER the
// suite had already passed. The design-concept artifact (hash
// e9f4cc3414f13c36) fixes this by making the retry phase blocking-only, plus
// kill-attribution observability. The describes below pin each invariant the
// launcher itself can violate; structural (source-regex) pins follow the
// house style of test/redis-db-helper.test.mts's #4141 wiring tests, because
// the behavior only exists at the CLI level.
// =============================================================================

describe("redis-db-launch — advisory-mode retry skip (#4292, design INV-1/INV-3)", () => {
  test("advisory mode never spawns an isolated retry — the retry call site is guarded by isGateBlocking() (INV-1)", () => {
    // The load-bearing wiring: the ONLY call to retryShortfallsInIsolation is
    // nested under `!result.ok && isGateBlocking()`. Advisory mode
    // (isGateBlocking() === false, the default — nothing sets
    // SUITE_COUNT_GATE_BLOCKING) therefore reaches the comparator, prints the
    // advisory verdict, and exits with the child's code without ever spawning
    // a child of its own — no retry fan-out is alive after the TAP footer to
    // be OOM-killed (#4292's exact failure).
    assert.match(
      LAUNCHER_SOURCE,
      /let retriesRan = false;\s*\n\s*if \(!result\.ok && isGateBlocking\(\)\) \{\s*\n\s*result = await retryShortfallsInIsolation\(/,
      "the retry invocation must be guarded by exactly `!result.ok && isGateBlocking()`",
    );
    // And the guard is the ONLY route in: the function name appears exactly
    // twice in the file — its definition and the one guarded call site. A
    // second, unguarded call site would silently restore the OOM exposure.
    const mentions = LAUNCHER_SOURCE.match(/retryShortfallsInIsolation\(/g) ?? [];
    assert.equal(
      mentions.length,
      2,
      `expected definition + exactly one guarded call site, found ${mentions.length}`,
    );
  });

  test("blocking mode keeps the unchanged retry mechanics: RETRY_ATTEMPTS=2, the RETRY_TIMEOUT_MS ceiling, the #4137 INCONCLUSIVE classification (INV-3)", () => {
    // Under SUITE_COUNT_GATE_BLOCKING=1 — the only mode where the verdict can
    // redden a run — the retry machinery is untouched: same per-file attempt
    // count, same generous timeout ceiling, same incomplete-run
    // classification. The guard above fires on `!result.ok` alone, so a
    // blocking run retries exactly when the pre-#4292 code did.
    assert.match(LAUNCHER_SOURCE, /const RETRY_ATTEMPTS = 2;/);
    assert.equal(RETRY_TIMEOUT_MS, 600_000);
    assert.match(LAUNCHER_SOURCE, /const incomplete = describeIncompleteRun\(spawnResult\);/);
  });
});

describe("redis-db-launch — exit-code preservation (#4292, design INV-2)", () => {
  test("the exit handler preserves the child's exit code — no suite-count path can turn a non-zero into a 0 (INV-2)", () => {
    // Every exit in the child-exit handler region must relay the child's own
    // code (`process.exit(code ?? 1)`), harden a green run to 1 (the #4141
    // file-coverage verdict, or the blocking gate), or exit 1 — never exit 0.
    // This is what makes the advisory gate unable to mask a red suite, and
    // what lets a green advisory run exit green immediately (#4292).
    const handlerStart = LAUNCHER_SOURCE.indexOf('child.on("exit"');
    assert.ok(handlerStart >= 0, "child exit handler not found");
    const handler = LAUNCHER_SOURCE.slice(handlerStart);
    assert.match(handler, /process\.exit\(code \?\? 1\)/, "final exit must relay the child's code");
    assert.match(
      handler,
      /process\.exit\(code === 0 \? 1 : \(code \?\? 1\)\)/,
      "the file-coverage verdict may only harden a green run to 1",
    );
    assert.doesNotMatch(
      handler,
      /process\.exit\(0\)/,
      "no path in the suite-count verdict may force a green exit",
    );
  });
});

describe("redis-db-launch — advisory shortfall wording (#4292, design INV-4)", () => {
  test("the advisory shortfall header never claims retries that did not run and names SUITE_COUNT_GATE_BLOCKING=1 (INV-4)", () => {
    // In advisory mode no retry ran, so the header must not say "after N
    // isolated per-file retry attempts" — and must say how to enable them.
    const advisory = shortfallRetrySuffix(false);
    assert.ok(
      advisory.includes("SUITE_COUNT_GATE_BLOCKING=1"),
      `the advisory suffix must name the enabling variable, got: ${JSON.stringify(advisory)}`,
    );
    assert.ok(
      !advisory.includes("isolated per-file retry attempts"),
      `the advisory suffix must not claim retries that did not run, got: ${JSON.stringify(advisory)}`,
    );
    // In blocking mode the historical wording survives verbatim.
    assert.equal(shortfallRetrySuffix(true), " after 2 isolated per-file retry attempts");
    // And the header is wired to the same `retriesRan` flag the guard sets —
    // the wording cannot disagree with what actually ran.
    assert.match(LAUNCHER_SOURCE, /\$\{shortfallRetrySuffix\(retriesRan\)\}/);
  });
});

describe("redis-db-launch — launcher self-kill observability (#4292, design INV-5/INV-6)", () => {
  test("a launcher-received SIGTERM/SIGINT is logged as an INFRA-KILL line naming the phase, then re-raised (INV-5)", () => {
    // Exact line format from the design invariant: the signal AND the phase
    // the launcher was in when it arrived, so a post-mortem can tell "killed
    // mid-suite" from "killed during the verdict phase" without guessing.
    assert.match(
      launcherInfraKillLine("SIGTERM", "test-suite"),
      /^\[redis-db-launch\] INFRA-KILL: launcher received SIGTERM during phase test-suite\b/,
    );
    assert.match(
      launcherInfraKillLine("SIGINT", "suite-count-verdict"),
      /^\[redis-db-launch\] INFRA-KILL: launcher received SIGINT during phase suite-count-verdict\b/,
    );
    // Wiring: both signals are trapped, the line is printed BEFORE the
    // listeners are dropped and the signal re-raised (removeListeners first,
    // or the self-kill would re-enter the handler forever), and the existing
    // CHILD-signal INFRA-KILL line is unchanged.
    assert.match(LAUNCHER_SOURCE, /for \(const signal of \["SIGTERM", "SIGINT"\]\) \{/);
    assert.match(LAUNCHER_SOURCE, /console\.error\(launcherInfraKillLine\(signal, launcherPhase\)\);/);
    assert.match(
      LAUNCHER_SOURCE,
      /process\.removeAllListeners\(signal\);\s*\n\s*process\.kill\(process\.pid, signal\);/,
    );
    assert.match(LAUNCHER_SOURCE, /installLauncherSignalHandlers\(\);/);
    assert.match(LAUNCHER_SOURCE, /INFRA-KILL: test child received \$\{signal\}/);
  });

  test("startup prints launcher pid+pgid and spawn prints the test child pid on stderr (INV-6)", () => {
    // Post-mortem attribution (#4043 closed without ever attributing the
    // killer): a later `kill <pid>` / `pkill -f` in an agent transcript or a
    // reaper PLAN line can be matched against these recorded pids exactly.
    assert.equal(
      launcherIdentityLine(4242, 4243),
      "[redis-db-launch] launcher pid 4242, pgid 4243",
    );
    assert.match(launcherIdentityLine(4242, null), /pid 4242/);
    assert.match(launcherIdentityLine(4242, null), /pgid unavailable/);
    if (process.platform === "linux") {
      const pgid = readOwnPgid();
      assert.ok(
        Number.isInteger(pgid) && (pgid as number) > 0,
        `readOwnPgid() must parse /proc/self/stat on linux, got ${JSON.stringify(pgid)}`,
      );
    } else {
      assert.equal(readOwnPgid(), null, "non-linux platforms have no /proc — best-effort null");
    }
    assert.match(LAUNCHER_SOURCE, /launcherIdentityLine\(process\.pid, readOwnPgid\(\)\)/);
    assert.match(LAUNCHER_SOURCE, /test child pid \$\{child\.pid\}/);
  });
});

describe("redis-db-launch — export surface freeze (#4292, design INV-9)", () => {
  test("existing exports keep their signatures and semantics; the CLI usage contract is unchanged (INV-9)", () => {
    assert.equal(typeof isGateBlocking, "function");
    assert.equal(isGateBlocking({}), false);
    assert.equal(isGateBlocking({ SUITE_COUNT_GATE_BLOCKING: "1" }), true);

    assert.equal(typeof isFullSuiteRun, "function");
    assert.equal(isFullSuiteRun({ HYDRA_FULL_SUITE: "1" }), true);
    assert.equal(isFullSuiteRun({}), false);

    assert.equal(typeof describeIncompleteRun, "function");
    assert.equal(describeIncompleteRun({ status: 1, signal: null, error: undefined }), null);

    assert.equal(typeof knownRunnerSlot, "function");
    assert.equal(knownRunnerSlot("/home/gabe/actions-runner-2/_work/hydra/hydra"), 9);

    assert.equal(typeof deriveDbIndex, "function");
    const derived = deriveDbIndex("/tmp/agent-worktree-x");
    assert.equal(derived, deriveDbIndex("/tmp/agent-worktree-x"), "derivation stays stable per root");
    assert.ok(
      [12, 13, 14, 15].includes(derived),
      `non-runner roots must stay on the fallback pool {12..15}, got ${derived}`,
    );

    assert.equal(typeof parseOwnedDbIndex, "function");
    assert.equal(parseOwnedDbIndex("redis://localhost:6379/8"), 8);
    assert.equal(parseOwnedDbIndex("redis://localhost:6379/0"), null);

    assert.equal(typeof redisChildEnv, "function");
    const ownedEnv = redisChildEnv({}, "redis://localhost:6379/9", 9);
    assert.equal(ownedEnv.REDIS_URL, "redis://localhost:6379/9");
    assert.equal(ownedEnv.HYDRA_REDIS_DB, "9");
    const foreignEnv = redisChildEnv({}, "redis://example.com:6379/0", null);
    assert.equal(foreignEnv.HYDRA_REDIS_DB, undefined);

    assert.equal(typeof resolveRedisUrl, "function");
    assert.deepEqual(
      resolveRedisUrl({ REDIS_URL: "redis://example.com:6379/0" }, "/repo"),
      { url: "redis://example.com:6379/0", derived: false, db: null },
      "a pre-set REDIS_URL stays verbatim with db: null",
    );

    // The CLI contract is unchanged — contract tests and ci.yml invoke this
    // exact shape.
    assert.match(
      LAUNCHER_SOURCE,
      /\[redis-db-launch\] usage: node scripts\/test\/redis-db-launch\.mjs <command> \[args\.\.\.\] \| --print-url/,
    );
  });
});
