/**
 * test/seam-check-lib.test.mts — pin the shared baseline-ratchet engine behind
 * the four CI Seam checks (issue #950). The four per-Seam test files keep
 * pinning their predicates; this pins the machinery the Adapters used to inline
 * four times: the shrink-only diff, the baseline-load fallback, the write/read
 * round-trip over the {callers, note} shape, and the CLI-entrypoint guard.
 *
 * Issue #4580 extended the module with the GENERIC JSON-baseline primitives
 * (loadJsonBaseline / writeJsonBaseline) that the sibling baseline-ratchet
 * scripts (skill-size, target-coupling, test-typecheck, test-subject-map)
 * now share; those are pinned here too — both fallback modes (default
 * catch-all vs strict ENOENT-only), the raw-SyntaxError strict-mode
 * propagation skill-size wraps at its call site, and the exact on-disk
 * write format.
 *
 * Pure pieces only — no git scan, no process.exit. (The full runSeamCheck arm
 * wiring is exercised end-to-end by the four per-Seam scripts in CI.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  diffBaseline,
  loadBaseline,
  writeBaselineFile,
  isCliEntrypoint,
  stripComments,
  loadJsonBaseline,
  writeJsonBaseline,
  diffBaselineGrowth,
  BaselineGrowthRefusedError,
  formatGrowthAdvice,
  formatStaleAdvice,
  writeBaselineOrRefuse,
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

describe("seam-check-lib: diffBaseline (shrink-only ratchet)", () => {
  test("a current violation absent from the baseline is NEW (fail closed)", () => {
    const diff = diffBaseline(
      ["src/a.ts", "src/b.ts"],
      { callers: ["src/a.ts"], note: "" },
    );
    assert.deepEqual(diff.newViolations, ["src/b.ts"]);
    assert.deepEqual(diff.fixedCallers, []);
  });

  test("a baseline entry that no longer violates is a fixedCaller (stale baseline)", () => {
    const diff = diffBaseline(
      ["src/a.ts"],
      { callers: ["src/a.ts", "src/b.ts"], note: "" },
    );
    assert.deepEqual(diff.newViolations, []);
    assert.deepEqual(diff.fixedCallers, ["src/b.ts"]);
  });

  test("an exact-match baseline yields no new and no fixed (clean pass)", () => {
    const diff = diffBaseline(
      ["src/a.ts", "src/b.ts"],
      { callers: ["src/a.ts", "src/b.ts"], note: "" },
    );
    assert.deepEqual(diff.newViolations, []);
    assert.deepEqual(diff.fixedCallers, []);
  });

  test("a grown baseline AND a fix surface simultaneously (mixed drift)", () => {
    // current = {a, c}; baseline = {a, b}: c is new, b is fixed.
    const diff = diffBaseline(
      ["src/a.ts", "src/c.ts"],
      { callers: ["src/a.ts", "src/b.ts"], note: "" },
    );
    assert.deepEqual(diff.newViolations, ["src/c.ts"]);
    assert.deepEqual(diff.fixedCallers, ["src/b.ts"]);
  });

  test("an empty baseline makes every current violation new (unseeded)", () => {
    const diff = diffBaseline(
      ["src/a.ts"],
      { callers: [], note: "baseline not yet seeded" },
    );
    assert.deepEqual(diff.newViolations, ["src/a.ts"]);
    assert.deepEqual(diff.fixedCallers, []);
  });
});

describe("seam-check-lib: loadBaseline fallback", () => {
  test("a missing baseline file falls back to an empty unseeded baseline", async () => {
    const missing = join(REPO_ROOT, "scripts/ci/__does-not-exist__.json");
    const baseline = await loadBaseline(missing);
    assert.deepEqual(baseline.callers, []);
    assert.equal(baseline.note, "baseline not yet seeded");
  });
});

describe("seam-check-lib: loadJsonBaseline / writeJsonBaseline (generic ratchet primitive, issue #4580)", () => {
  test("a missing file returns the caller's fallback in default (non-strict) mode — any payload shape", async () => {
    const missing = join(REPO_ROOT, "scripts/ci/__does-not-exist__.json");
    const fallback = { count: 0, note: "baseline not yet seeded" };
    assert.deepEqual(await loadJsonBaseline(missing, fallback), fallback);
  });

  test("a missing file returns the caller's fallback in strict mode too (ENOENT is the soft case)", async () => {
    // skill-size-ratchet's convention: fallback null — an unseeded baseline
    // is itself a reportable violation, not a typed default.
    const missing = join(REPO_ROOT, "scripts/ci/__does-not-exist__.json");
    assert.equal(await loadJsonBaseline(missing, null, { strict: true }), null);
  });

  test("malformed JSON falls back in default mode — corrupt and unseeded are the same state there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seam-check-lib-"));
    try {
      const path = join(dir, "baseline.json");
      await writeFile(path, "{ not json", "utf8");
      const fallback = { violations: [], note: "baseline not yet seeded" };
      assert.deepEqual(await loadJsonBaseline(path, fallback), fallback);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON throws the raw SyntaxError in strict mode (skill-size wraps it at its call site)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seam-check-lib-"));
    try {
      const path = join(dir, "baseline.json");
      await writeFile(path, "{ not json", "utf8");
      await assert.rejects(
        loadJsonBaseline(path, null, { strict: true }),
        (err) => err instanceof SyntaxError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round-trip: writeJsonBaseline then loadJsonBaseline preserves the payload; on-disk form is 2-space JSON with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seam-check-lib-"));
    try {
      const path = join(dir, "baseline.json");
      const payload = { b: 2, a: { x: 1 } };
      await writeJsonBaseline(path, payload);

      const raw = await readFile(path, "utf8");
      assert.ok(raw.endsWith("\n"), "must end with a trailing newline");
      assert.equal(raw, JSON.stringify(payload, null, 2) + "\n");

      const reloaded = await loadJsonBaseline<typeof payload>(path, {
        b: 0,
        a: { x: 0 },
      });
      assert.deepEqual(reloaded, payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("seam-check-lib: writeBaselineFile / loadBaseline round-trip", () => {
  test("written baseline reloads with identical callers and a stamped note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seam-check-lib-"));
    try {
      const path = join(dir, "x-seam-baseline.json");
      const callers = ["src/a.ts", "src/b.ts"];
      await writeBaselineFile(path, callers, "x-seam-check", "X ratchet: shrink only.");

      const reloaded = await loadBaseline(path);
      assert.deepEqual(reloaded.callers, callers);
      assert.match(
        reloaded.note,
        /Auto-generated by scripts\/ci\/x-seam-check\.ts --write-baseline on .+\. X ratchet: shrink only\./,
      );

      // The on-disk form is pretty-printed JSON with a trailing newline,
      // matching the historic per-check writeBaselineFile output.
      const raw = await readFile(path, "utf8");
      assert.ok(raw.endsWith("\n"));
      assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2) + "\n");
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

describe("seam-check-lib: writeJsonBaseline growth refusal (chokepoint for every ratchet writer)", () => {
  const shapes: Array<[string, unknown, unknown, unknown, string]> = [
    ["files map", { files: { "a.ts": 2, "b.ts": 1 } }, { files: { "a.ts": 3, "b.ts": 1 } }, { files: { "a.ts": 1 } }, "raised"],
    ["callers array", { callers: ["x", "y"], note: "n" }, { callers: ["x", "y", "z"], note: "n" }, { callers: ["x"], note: "n2" }, "added-element"],
    ["hits array", { hits: ["h1"] }, { hits: ["h1", "h2"] }, { hits: [] }, "added-element"],
    ["count", { count: 5 }, { count: 6 }, { count: 4 }, "raised"],
  ];

  async function withFile(prior: unknown, fn: (path: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "growth-"));
    try {
      const path = join(dir, "b.json");
      await writeFile(path, JSON.stringify(prior, null, 2) + "\n", "utf8");
      await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  for (const [name, prior, grown, shrunk, kind] of shapes) {
    test(`${name}: growth is refused, names the row, leaves the file untouched`, async () => {
      await withFile(prior, async (path) => {
        const before = await readFile(path, "utf8");
        await assert.rejects(
          () => writeJsonBaseline(path, grown, { allowGrow: false }),
          (err: any) => {
            assert.ok(err instanceof BaselineGrowthRefusedError);
            assert.equal(err.code, "baseline-growth-refused");
            assert.equal(err.rows[0].kind, kind);
            assert.match(err.message, /re-run with --allow-grow/);
            return true;
          },
        );
        assert.equal(await readFile(path, "utf8"), before);
      });
    });
    test(`${name}: allowGrow permits the growth`, async () => {
      await withFile(prior, async (path) => {
        await writeJsonBaseline(path, grown, { allowGrow: true });
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), grown);
      });
    });
    test(`${name}: shrink writes freely`, async () => {
      await withFile(prior, async (path) => {
        await writeJsonBaseline(path, shrunk, { allowGrow: false });
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), shrunk);
      });
    });
    test(`${name}: unchanged payload writes freely`, async () => {
      await withFile(prior, async (path) => {
        await writeJsonBaseline(path, prior, { allowGrow: false });
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), prior);
      });
    });
  }

  test("added object key and JSON type change are refused", () => {
    assert.deepEqual(diffBaselineGrowth({ a: 1 }, { a: 1, b: 1 }).map((r: any) => [r.path, r.kind]), [["b", "added-key"]]);
    assert.deepEqual(diffBaselineGrowth({ a: [] }, { a: 3 }).map((r: any) => r.kind), ["shape-changed"]);
    assert.deepEqual(diffBaselineGrowth({ a: { b: 1 } }, { a: { b: 2 } }).map((r: any) => r.path), ["a/b"]);
  });

  test("string-only differences (timestamped note) are not growth", () => {
    assert.deepEqual(diffBaselineGrowth({ note: "old", n: 1 }, { note: "new", n: 1 }), []);
  });

  test("missing file is a seed, not growth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "growth-"));
    try {
      const path = join(dir, "new.json");
      await writeJsonBaseline(path, { count: 99 }, { allowGrow: false });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 99 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("duplicate element (multiset growth) is refused; same multiset is not growth", async () => {
    assert.deepEqual(diffBaselineGrowth({ hits: ["a", "b"] }, { hits: ["a", "a", "b"] }).map((r: any) => r.kind), ["added-element"]);
    assert.deepEqual(diffBaselineGrowth({ hits: ["a", "a", "b"] }, { hits: ["b", "a", "a"] }), []);
    assert.deepEqual(diffBaselineGrowth({ hits: ["a", "a"] }, { hits: ["a"] }), []);
    await withFile({ hits: ["a", "b"] }, async (path) => {
      await assert.rejects(() => writeJsonBaseline(path, { hits: ["a", "a", "b"] }, { allowGrow: false }), (err: any) => err.code === "baseline-growth-refused");
    });
  });

  test("inherited keys do not mask an added key", () => {
    assert.deepEqual(diffBaselineGrowth({}, { constructor: 1 }).map((r: any) => r.kind), ["added-key"]);
  });

  test("an unparseable prior baseline does not bypass the gate", async () => {
    await withFile({}, async (path) => {
      await writeFile(path, "{not json", "utf8");
      await assert.rejects(() => writeJsonBaseline(path, { count: 9 }, { allowGrow: false }));
      assert.equal(await readFile(path, "utf8"), "{not json");
    });
  });

  test("writeBaselineOrRefuse (shared CLI handler): refusal returns 1 and calls onRefusal; shrink returns 0", async () => {
    await withFile({ hits: ["a", "b"] }, async (path) => {
      let called = 0;
      assert.equal(await writeBaselineOrRefuse(path, { hits: ["a", "b", "c"] }, { allowGrow: false, onRefusal: () => { called++; } }), 1);
      assert.equal(called, 1);
      assert.equal(await writeBaselineOrRefuse(path, { hits: ["a"] }, { allowGrow: false }), 0);
      assert.equal(await writeBaselineOrRefuse(path, { hits: ["a", "z"] }, { allowGrow: true }), 0);
    });
  });

  test("no writeJsonBaseline caller bypasses the chokepoint with its own writeFile", async () => {
    const { execFileSync } = await import("node:child_process");
    const files = execFileSync("git", ["grep", "-l", "writeJsonBaseline(", "--", "scripts/ci/*.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f: string) => !f.endsWith("seam-check-lib.ts"));
    assert.ok(files.length >= 8);
    for (const f of files) {
      const src = await readFile(join(REPO_ROOT, f), "utf8");
      assert.doesNotMatch(src, /\bwriteFile(Sync)?\(\s*[^)]*baseline/i, `${f} writes a baseline without the chokepoint`);
    }
  });

  test("growth is refused and the file stays byte-identical", async () => {
    await withFile({ count: 1, hits: ["a"] }, async (path) => {
      const before = await readFile(path, "utf8");
      await assert.rejects(
        () => writeJsonBaseline(path, { count: 2, hits: ["a", "b"] }, { allowGrow: false }),
        (err: any) => err.code === "baseline-growth-refused" && err.rows.length === 2,
      );
      assert.equal(await readFile(path, "utf8"), before);
    });
  });
});

describe("seam-check-lib: ratchet advice formatters", () => {
  const growth = formatGrowthAdvice({
    cmd: "npm run foo -- --write-baseline",
    baselineRel: "test/fixtures/foo-baseline.json",
    rowKey: "count",
    fixVerb: "fix the new error(s)",
    current: 7,
  });

  test("growth advice names the row, value, --allow-grow, and the Baseline-raise: line", () => {
    assert.match(growth, /Fix the code first: fix the new error\(s\)/);
    assert.ok(growth.includes("`count` row in test/fixtures/foo-baseline.json to 7"));
    assert.ok(growth.includes("`npm run foo -- --write-baseline --allow-grow`"));
    assert.ok(growth.includes("Baseline-raise: test/fixtures/foo-baseline.json count"));
    assert.ok(growth.includes("STD-BASELINE-EDIT-ROWS"));
  });

  test("stale advice names the baseline and rows, and never a writer command", () => {
    const stale = formatStaleAdvice({
      baselineRel: "test/fixtures/foo-baseline.json",
      rowAction: "lower the `count` row to 3",
    });
    assert.ok(stale.includes("In test/fixtures/foo-baseline.json, lower the `count` row to 3 by hand"));
    assert.ok(stale.includes("STD-BASELINE-EDIT-ROWS"));
    assert.doesNotMatch(stale, /--write-baseline|--allow-grow|Baseline-raise/);
  });

  test("sibling shape: growth and stale verdicts stay distinct", () => {
    const stale = formatStaleAdvice({ baselineRel: "b.json", rowAction: "x" });
    assert.doesNotMatch(stale, /Baseline-raise/);
    assert.doesNotMatch(growth, /Do not regenerate the whole baseline/);
  });

  test("every ratchet site routes its advice through the shared formatters", async () => {
    const sites: Array<[string, string]> = [
      ["scripts/ci/test-typecheck-check.ts", "formatGrowthAdvice("],
      ["scripts/ci/test-typecheck-check.ts", "formatStaleAdvice("],
      ["scripts/ci/skill-size-ratchet.ts", "formatGrowthAdvice("],
      ["scripts/ci/skill-size-ratchet.ts", "formatStaleAdvice("],
      ["scripts/ci/playbook-vocabulary-ratchet.ts", "formatStaleAdvice("],
    ];
    for (const [f, fn] of sites) {
      const src = await readFile(join(REPO_ROOT, f), "utf8");
      assert.ok(src.includes(fn), `${f} must call ${fn}`);
    }
  });
});
