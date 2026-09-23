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
