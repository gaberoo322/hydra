/**
 * test/seam-check-lib.test.mts — pin the shared baseline-ratchet primitives
 * behind the nine CI Seam checks (issue #950). The per-Seam test files keep
 * pinning their predicates; this pins the shared primitives and (issue #5651)
 * that all nine Seam checks run on the Ratchet module: policy fields, set-format
 * baselines, and the live-tree verdict of the required redis seam.
 *
 * Issue #5656 retired the module's baseline read/write/diff/advice primitives
 * into ratchet.ts (test/ratchet.test.mts pins the writer gate); the export
 * surface test below pins that only the measure-side helpers remain.
 *
 * No process.exit; the one scan runs over a throwaway fixture tree.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  isCliEntrypoint,
  stripComments,
  escapeRegExp,
  REPO_ROOT,
} = await import("../scripts/ci/seam-check-lib.ts");

describe("seam-check-lib: stripComments (token-scan preprocessing, issue #3703)", () => {
  test("removes block and line comments", () => {
    assert.equal(stripComments(`/* journalctl */ const a = 1;`).includes("journalctl"), false);
    assert.equal(stripComments(`const a = 1; // journalctl`).includes("journalctl"), false);
    assert.equal(
      stripComments(`/**\n * journalctl\n */\nconst a = 1;`).includes("journalctl"),
      false,
    );
  });

  test("PRESERVES string and template literals — a spawned binary name lives there", () => {
    assert.equal(stripComments(`spawn("journalctl");`).includes("journalctl"), true);
    assert.equal(stripComments(`spawn('journalctl');`).includes("journalctl"), true);
    assert.equal(stripComments("const b = `journalctl`;").includes("journalctl"), true);
  });

  test("does not treat // inside a string literal as a comment", () => {
    // The classic naive-stripper bug: truncating at `//` inside a URL would eat
    // the rest of the line and silently hide a real token.
    const out = stripComments(`const url = "http://x"; spawn("journalctl");`);
    assert.equal(out.includes("journalctl"), true);
  });

  test("does not treat an escaped slash inside a regex literal as a comment", () => {
    const out = stripComments(`const re = /https?:\\/\\//; spawn("journalctl");`);
    assert.equal(out.includes("journalctl"), true);
  });

  test("handles an escaped quote inside a string without losing the terminator", () => {
    const out = stripComments(`const s = "a\\"b"; // journalctl\nspawn("df");`);
    assert.equal(out.includes("journalctl"), false);
    assert.equal(out.includes("df"), true);
  });

  test("leaves ordinary code untouched", () => {
    assert.equal(
      stripComments(`import { spawn } from "node:child_process";`),
      `import { spawn } from "node:child_process";`,
    );
  });
});

describe("seam-check-lib: the nine Seam checks run on the Ratchet module (issue #5651)", () => {
  const EXPECTED = [
    ["redis", "required"],
    ["schema", "advisory"],
    ["query", "advisory"],
    ["github", "advisory"],
    ["host-probe", "advisory"],
    ["journal", "advisory"],
    ["claude-cli", "advisory"],
    ["anthropic", "advisory"],
    ["telegram", "advisory"],
  ] as const;
  const camel = (n: string): string => n.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());

  for (const [name, enforcement] of EXPECTED) {
    test(`${name}-seam-check exports a set/ceiling/stale-fail ratchet (${enforcement})`, async () => {
      const mod = await import(`../scripts/ci/${name}-seam-check.ts`);
      const ratchet = mod[`${camel(name)}SeamRatchet`];
      assert.ok(ratchet, `${name}-seam-check must export ${camel(name)}SeamRatchet`);
      const p = ratchet.policy;
      assert.equal(p.id, `${name}-seam-check`);
      assert.equal(p.baseline, `scripts/ci/${name}-seam-baseline.json`);
      assert.equal(p.shape, "set");
      assert.equal(p.polarity, "ceiling");
      assert.equal(p.stale, "fail");
      assert.equal(p.enforcement, enforcement);
      assert.ok(Array.isArray(p.help) && p.help.length > 0, "fix wording rides on policy.help");
    });

    test(`${name}-seam-baseline.json is a bare sorted JSON array of paths`, async () => {
      const raw = JSON.parse(await readFile(join(REPO_ROOT, `scripts/ci/${name}-seam-baseline.json`), "utf8"));
      assert.ok(Array.isArray(raw), "set-format baseline is an array, not a {callers, note} envelope");
      assert.deepEqual(raw, [...raw].sort());
    });
  }

  test("a fixture tree with a new violation fails the verdict and prints the seam's fix wording", async () => {
    const { redisSeamRatchet } = await import("../scripts/ci/redis-seam-check.ts");
    const { execFileSync } = await import("node:child_process");
    const dir = await mkdtemp(join(tmpdir(), "seam-ratchet-fixture-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "scripts/ci"), { recursive: true });
      await writeFile(join(dir, "src/bad.ts"), "import x from './redis/keys.ts';\n");
      await writeFile(join(dir, "scripts/ci/redis-seam-baseline.json"), "[]\n");
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["add", "."], { cwd: dir });
      const v = await redisSeamRatchet.verdict(dir);
      assert.equal(v.ok, false);
      assert.deepEqual(v.added, ["src/bad.ts"]);
      assert.match(v.advice, /NEW Redis-seam violations/);
      assert.match(v.advice, /typed accessor in src\/redis/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("seam-check-lib: isCliEntrypoint guard", () => {
  test("returns false when the module URL is not process.argv[1]", () => {
    // Under the test runner, argv[1] is the test entry, never an Adapter — so
    // importing an Adapter (e.g. for the predicate tests) does NOT trigger a
    // scan or a process.exit.
    assert.equal(
      isCliEntrypoint("file:///some/other/scripts/ci/redis-seam-check.ts"),
      false,
    );
  });
});

describe("seam-check-lib: export surface (issue #5656)", () => {
  test("exports only the measure-side helpers; the baseline read/write/diff/advice primitives are retired", async () => {
    const lib = await import("../scripts/ci/seam-check-lib.ts");
    assert.deepEqual(Object.keys(lib).sort(), [
      "REPO_ROOT",
      "escapeRegExp",
      "isCliEntrypoint",
      "listTrackedFiles",
      "seamMeasure",
      "stripComments",
    ]);
    for (const retired of [
      "loadJsonBaseline",
      "writeJsonBaseline",
      "diffBaselineGrowth",
      "formatGrowthAdvice",
      "formatStaleAdvice",
      "BaselineGrowthRefusedError",
      "writeBaselineOrRefuse",
      "buildRowBaseline",
      "mergeRowsForFiles",
      "compareCountRows",
      "mergeCountRows",
      "resolveListFlag",
      "runBaselineRatchet",
    ]) {
      assert.equal(retired in lib, false, retired);
    }
  });

  test("escapeRegExp makes a literal safe inside a RegExp source", () => {
    assert.equal(new RegExp(escapeRegExp("a.b(c)")).test("a.b(c)"), true);
    assert.equal(new RegExp(escapeRegExp("a.b")).test("axb"), false);
  });
});
