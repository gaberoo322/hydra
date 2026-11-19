/**
 * test/ratchet.test.mts — the Ratchet module (scripts/ci/ratchet.ts) at its
 * interface: verdict() over both shapes x both polarities x both stale rules,
 * the CLI exit codes, the retired flags, and the import-without-running guard.
 * Every ratchet runs against a throwaway root, never the live tree.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { defineRatchet } = await import("../scripts/ci/ratchet.ts");

const BASELINE = "baseline.json";
type Shape = "set" | "counted";
type Polarity = "ceiling" | "floor";
type Stale = "fail" | "hint";

function setup(baseline: unknown | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "ratchet-test-"));
  if (baseline !== undefined) writeFileSync(join(root, BASELINE), JSON.stringify(baseline));
  return root;
}

function make(shape: Shape, polarity: Polarity, stale: Stale, rows: string[] | (() => Promise<string[]>)) {
  return defineRatchet({
    id: "t",
    baseline: BASELINE,
    shape,
    polarity,
    stale,
    enforcement: "advisory",
    measure: typeof rows === "function" ? rows : async () => rows,
  });
}

describe("ratchet: verdict over shape x polarity x stale", () => {
  const cases: Array<{
    name: string;
    shape: Shape;
    polarity: Polarity;
    stale: Stale;
    baseline: unknown;
    measured: string[];
    ok: boolean;
    added: string[];
    staleRows: string[];
  }> = [
    { name: "set ceiling: new row is added", shape: "set", polarity: "ceiling", stale: "fail", baseline: ["a"], measured: ["a", "b"], ok: false, added: ["b"], staleRows: [] },
    { name: "set ceiling: stale fail", shape: "set", polarity: "ceiling", stale: "fail", baseline: ["a", "b"], measured: ["a"], ok: false, added: [], staleRows: ["b"] },
    { name: "set ceiling: stale hint passes", shape: "set", polarity: "ceiling", stale: "hint", baseline: ["a", "b"], measured: ["a"], ok: true, added: [], staleRows: ["b"] },
    { name: "set ceiling: a duplicate finding is one row", shape: "set", polarity: "ceiling", stale: "fail", baseline: ["a"], measured: ["a", "a"], ok: true, added: [], staleRows: [] },
    { name: "set floor: a vanished row is added", shape: "set", polarity: "floor", stale: "hint", baseline: ["a", "b"], measured: ["a"], ok: false, added: ["b"], staleRows: [] },
    { name: "set floor: an extra row is stale", shape: "set", polarity: "floor", stale: "fail", baseline: ["a"], measured: ["a", "b"], ok: false, added: [], staleRows: ["b"] },
    { name: "counted ceiling: a count that rose is added", shape: "counted", polarity: "ceiling", stale: "hint", baseline: { a: 1 }, measured: ["a", "a"], ok: false, added: ["a"], staleRows: [] },
    { name: "counted ceiling: a new key is added", shape: "counted", polarity: "ceiling", stale: "hint", baseline: { a: 1 }, measured: ["a", "b"], ok: false, added: ["b"], staleRows: [] },
    { name: "counted ceiling: a count that fell is stale (fail)", shape: "counted", polarity: "ceiling", stale: "fail", baseline: { a: 2 }, measured: ["a"], ok: false, added: [], staleRows: ["a"] },
    { name: "counted ceiling: a count that fell is a hint", shape: "counted", polarity: "ceiling", stale: "hint", baseline: { a: 2 }, measured: ["a"], ok: true, added: [], staleRows: ["a"] },
    { name: "counted floor: a count that fell is added", shape: "counted", polarity: "floor", stale: "hint", baseline: { a: 2 }, measured: ["a"], ok: false, added: ["a"], staleRows: [] },
    { name: "counted floor: a vanished key is added", shape: "counted", polarity: "floor", stale: "hint", baseline: { a: 1, b: 1 }, measured: ["a"], ok: false, added: ["b"], staleRows: [] },
    { name: "counted floor: a count that rose is stale", shape: "counted", polarity: "floor", stale: "fail", baseline: { a: 1 }, measured: ["a", "a"], ok: false, added: [], staleRows: ["a"] },
    { name: "counted ceiling: equal passes clean", shape: "counted", polarity: "ceiling", stale: "fail", baseline: { a: 2 }, measured: ["a", "a"], ok: true, added: [], staleRows: [] },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const root = setup(c.baseline);
      try {
        const v = await make(c.shape, c.polarity, c.stale, c.measured).verdict(root);
        assert.equal(v.ok, c.ok);
        assert.deepEqual(v.added, c.added);
        assert.deepEqual(v.stale, c.staleRows);
        assert.equal(v.crashed, undefined);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("a second identical finding is reported as added, not absorbed by one row", async () => {
    const root = setup({ "x\tf\tg": 1 });
    try {
      const v = await make("counted", "ceiling", "hint", ["x\tf\tg", "x\tf\tg"]).verdict(root);
      assert.deepEqual(v.added, ["x\tf\tg"]);
      assert.equal(v.measured, 2);
      assert.equal(v.baselineRows, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale rows fail the verdict under stale=fail and only hint under stale=hint", async () => {
    const root = setup({ gone: 1, kept: 1 });
    try {
      const strict = await make("counted", "ceiling", "fail", ["kept"]).verdict(root);
      assert.equal(strict.ok, false);
      assert.deepEqual(strict.stale, ["gone"]);
      const lenient = await make("counted", "ceiling", "hint", ["kept"]).verdict(root);
      assert.equal(lenient.ok, true);
      assert.deepEqual(lenient.stale, ["gone"]);
      assert.match(lenient.advice, /hint/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing baseline is an empty baseline", async () => {
    const root = setup(undefined);
    try {
      const v = await make("counted", "ceiling", "hint", ["a"]).verdict(root);
      assert.deepEqual(v.added, ["a"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ratchet: verdict never throws", () => {
  test("a measure failure is returned as ok:false with the cause", async () => {
    const root = setup({});
    try {
      const v = await make("counted", "ceiling", "hint", async () => {
        throw new Error("scanner exploded");
      }).verdict(root);
      assert.equal(v.ok, false);
      assert.equal(v.crashed, true);
      assert.match(v.advice, /scanner exploded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a corrupt or wrong-shape baseline is returned as ok:false", async () => {
    const root = setup(["not", "an", "object"]);
    try {
      const v = await make("counted", "ceiling", "hint", []).verdict(root);
      assert.equal(v.ok, false);
      assert.equal(v.crashed, true);
      assert.match(v.advice, /baseline/);
      writeFileSync(join(root, BASELINE), "{ not json");
      const w = await make("set", "ceiling", "hint", []).verdict(root);
      assert.equal(w.ok, false);
      assert.equal(w.crashed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ratchet: advice", () => {
  test("names the exact rows and the Baseline-raise line, never 'regenerate'", async () => {
    const root = setup({ "k\tf": 1, "gone\tf": 1 });
    try {
      const v = await make("counted", "ceiling", "fail", ["k\tf", "k\tf", "new\tf"]).verdict(root);
      assert.match(v.advice, /k \| f \(baseline 1, measured 2\)/);
      assert.match(v.advice, /new \| f/);
      assert.match(v.advice, /gone \| f/);
      assert.match(v.advice, /Baseline-raise: baseline\.json/);
      assert.equal(/regenerat/i.test(v.advice), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ratchet: CLI main", () => {
  async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
    const e = console.error;
    const l = console.log;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    console.log = () => {};
    try {
      return { value: await fn(), err: lines.join("\n") };
    } finally {
      console.error = e;
      console.log = l;
    }
  }

  /** A counted ceiling ratchet whose baseline is an absolute temp path. */
  function cli(dir: string, measure: () => Promise<string[]>) {
    return defineRatchet({
      id: "cli",
      baseline: join(dir, "b.json"),
      shape: "counted",
      polarity: "ceiling",
      stale: "hint",
      enforcement: "advisory",
      measure,
    });
  }

  const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, "b.json"), "utf8"));

  test("each retired flag exits 2 and names --write-baseline", async () => {
    for (const flag of ["--init", "--seed", "--shrink-baseline", "--update-baseline"]) {
      const { value, err } = await quiet(() => cli("/nonexistent", async () => []).main([flag]));
      assert.equal(value, 2, flag);
      assert.match(err, /--write-baseline/, flag);
    }
  });

  test("an unknown flag is a usage error (exit 2)", async () => {
    const { value } = await quiet(() => cli("/nonexistent", async () => []).main(["--bogus"]));
    assert.equal(value, 2);
  });

  test("exit codes: 0 pass, 1 violation, 2 crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-cli-"));
    try {
      writeFileSync(join(dir, "b.json"), JSON.stringify({ a: 1 }));
      let rows = ["a"];
      const r = cli(dir, async () => {
        if (rows[0] === "boom") throw new Error("boom");
        return rows;
      });
      assert.equal((await quiet(() => r.main([]))).value, 0);
      rows = ["a", "a"];
      assert.equal((await quiet(() => r.main([]))).value, 1);
      rows = ["boom"];
      assert.equal((await quiet(() => r.main([]))).value, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--write-baseline refuses growth with exit 1 (not 2) and --allow-grow permits it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-cli-"));
    try {
      writeFileSync(join(dir, "b.json"), JSON.stringify({ a: 1 }));
      const r = cli(dir, async () => ["a", "a"]);
      const refused = await quiet(() => r.main(["--write-baseline"]));
      assert.equal(refused.value, 1);
      assert.deepEqual(onDisk(dir), { a: 1 });
      assert.equal((await quiet(() => r.main(["--write-baseline", "--allow-grow"]))).value, 0);
      assert.deepEqual(onDisk(dir), { a: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--write-baseline lowers counts, drops zero keys and writes sorted keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-cli-"));
    try {
      writeFileSync(join(dir, "b.json"), JSON.stringify({ gone: 1, b: 3, a: 1 }));
      const r = cli(dir, async () => ["b", "a"]);
      assert.equal((await quiet(() => r.main(["--write-baseline"]))).value, 0);
      assert.deepEqual(Object.keys(onDisk(dir)), ["a", "b"]);
      assert.deepEqual(onDisk(dir), { a: 1, b: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a set baseline is written as a sorted JSON array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-cli-"));
    try {
      writeFileSync(join(dir, "b.json"), JSON.stringify(["z", "a", "gone"]));
      const r = defineRatchet({
        id: "cli-set",
        baseline: join(dir, "b.json"),
        shape: "set",
        polarity: "ceiling",
        stale: "hint",
        enforcement: "advisory",
        measure: async () => ["z", "a"],
      });
      assert.equal((await quiet(() => r.main(["--write-baseline"]))).value, 0);
      assert.deepEqual(onDisk(dir), ["a", "z"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ratchet: runIfCli import guard", () => {
  test("importing a module that calls runIfCli never measures or exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-guard-"));
    const ratchetUrl = new URL("../scripts/ci/ratchet.ts", import.meta.url).href;
    const mod = join(dir, "mod.mts");
    const importer = join(dir, "importer.mts");
    writeFileSync(
      mod,
      `import { defineRatchet, runIfCli } from ${JSON.stringify(ratchetUrl)};\n` +
        `export const r = defineRatchet({ id: "g", baseline: "b.json", shape: "set", polarity: "ceiling", stale: "hint", enforcement: "advisory", measure: async () => { console.log("MEASURED"); return []; } });\n` +
        `runIfCli(import.meta.url, r);\n`,
    );
    writeFileSync(importer, `await import(${JSON.stringify(mod)});\nconsole.log("IMPORTED");\n`);
    try {
      const imported = spawnSync("node", ["--no-warnings", "--experimental-strip-types", importer], { encoding: "utf8" });
      assert.equal(imported.status, 0);
      assert.match(imported.stdout, /IMPORTED/);
      assert.equal(imported.stdout.includes("MEASURED"), false);
      const direct = spawnSync("node", ["--no-warnings", "--experimental-strip-types", mod], { encoding: "utf8" });
      assert.match(direct.stdout, /MEASURED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
