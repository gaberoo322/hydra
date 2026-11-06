/**
 * Serial/parallel pool classification (issue #5199, amends ADR-0038).
 *
 * The manifest `test/fixtures/test-pools.json` is a ratchet: this suite
 * regenerates it with scripts/test/test-pools.mjs's static scan and fails on
 * drift. Fix = `node scripts/test/test-pools.mjs --update` in the same PR.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildPoolInvocations,
  joinTap,
  runPools,
  DEFAULT_PARALLEL_CONCURRENCY,
  loadManifest,
  parallelConcurrency,
  REDIS_MARKERS,
  scanPools,
  splitPools,
} from "../scripts/test/test-pools.mjs";

describe("test-pools — manifest drift guard (INV-3)", () => {
  test("committed manifest equals a fresh static scan", () => {
    const committed = loadManifest();
    const scanned = scanPools();
    assert.deepEqual(
      committed,
      scanned,
      "test/fixtures/test-pools.json drifted from the static scan — run: node scripts/test/test-pools.mjs --update",
    );
  });

  test("no parallel-listed file mentions a Redis marker directly", () => {
    for (const f of loadManifest().parallel) {
      assert.equal(REDIS_MARKERS.test(readFileSync(f, "utf8")), false, `${f} reaches Redis`);
    }
  });

  test("a file is never both parallel and serial-pinned", () => {
    const m = loadManifest();
    for (const f of Object.keys(m.serialPinned)) assert.equal(m.parallel.includes(f), false, f);
  });
});

describe("test-pools — splitPools default-serial (INV-2)", () => {
  const manifest = { parallel: ["test/a.test.mts", "test/pinned.test.mts"], serialPinned: { "test/pinned.test.mts": "why" } };

  test("unlisted and pinned files run serial; only listed files go parallel", () => {
    const r = splitPools(["test/a.test.mts", "test/new.test.mts", "test/pinned.test.mts"], manifest);
    assert.deepEqual(r.parallel, ["test/a.test.mts"]);
    assert.deepEqual(r.serial, ["test/new.test.mts", "test/pinned.test.mts"]);
  });

  test("the union of both pools is the original file list", () => {
    const files = ["test/a.test.mts", "test/b.test.mts", "test/pinned.test.mts"];
    const r = splitPools(files, manifest);
    assert.deepEqual([...r.serial, ...r.parallel].sort(), [...files].sort());
  });
});

describe("test-pools — buildPoolInvocations (INV-5, INV-8, INV-9)", () => {
  const manifest = { parallel: ["test/b.test.mts"], serialPinned: {} };
  const args = [
    "node",
    "--test",
    "--test-reporter-destination=stdout",
    "--test-reporter-destination=cap.ndjson",
    "test/a.test.mts",
    "test/b.test.mts",
  ];

  test("each pool gets its own concurrency flag and file list", () => {
    const r = buildPoolInvocations(args, manifest, 3);
    assert.ok(r.serial.argv.includes("--test-concurrency=1"));
    assert.ok(r.serial.argv.includes("test/a.test.mts"));
    assert.ok(!r.serial.argv.includes("test/b.test.mts"));
    assert.ok(r.parallel?.argv.includes("--test-concurrency=3"));
    assert.ok(r.parallel?.argv.includes("test/b.test.mts"));
  });

  test("non-stdout reporter destinations are rewritten per pool and listed for merging", () => {
    const r = buildPoolInvocations(args, manifest, 3);
    assert.deepEqual(r.merged, ["cap.ndjson"]);
    assert.ok(r.serial.argv.includes("--test-reporter-destination=cap.ndjson.serial"));
    assert.ok(r.parallel?.argv.includes("--test-reporter-destination=cap.ndjson.parallel"));
    assert.ok(r.serial.argv.includes("--test-reporter-destination=stdout"));
    assert.ok(!r.serial.argv.includes("--test-reporter-destination=cap.ndjson"));
  });

  test("no parallel-eligible file yields a single serial invocation", () => {
    const r = buildPoolInvocations(args, { parallel: [], serialPinned: {} }, 3);
    assert.equal(r.parallel, null);
    assert.ok(r.serial.argv.includes("test/b.test.mts"));
  });

  test("parallel concurrency defaults to 4 and honours the env override (never availableParallelism)", () => {
    assert.equal(DEFAULT_PARALLEL_CONCURRENCY, 4);
    assert.equal(parallelConcurrency({}), 4);
    assert.equal(parallelConcurrency({ HYDRA_TEST_PARALLEL_CONCURRENCY: "2" }), 2);
    assert.equal(parallelConcurrency({ HYDRA_TEST_PARALLEL_CONCURRENCY: "nope" }), 4);
  });
});

describe("test-pools — package.json wiring (INV-9)", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  test("`test` and `test:debug` opt in via --pools and no longer hard-code concurrency", () => {
    for (const k of ["test", "test:debug"]) {
      assert.match(pkg.scripts[k], /redis-db-launch\.mjs --pools /);
      assert.doesNotMatch(pkg.scripts[k], /--test-concurrency/);
    }
  });

  test("`test:file` keeps the single-child behaviour", () => {
    assert.doesNotMatch(pkg.scripts["test:file"], /--pools/);
  });
});

// ---------------------------------------------------------------------------
// QA round-2 forward-fix (#5340): launcher orchestration, footer merge, and
// transitive hazard scan, exercised against stub children / synthetic trees.
// ---------------------------------------------------------------------------

const NODE = process.execPath;
const footerJs = (t: number, p: number, d: number) =>
  `console.log("# tests ${t}\\n# suites 0\\n# pass ${p}\\n# fail ${t - p}\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms ${d}")`;

function inv(serialJs: string, parallelJs: string | null, merged: string[] = []) {
  const mk = (pool: string, js: string) => ({ pool, argv: [NODE, "-e", js], files: ["test/x.test.mts"] });
  return { serial: mk("serial", serialJs), parallel: parallelJs === null ? null : mk("parallel", parallelJs), merged };
}

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WriteStream,
    get out() { return out; },
    get err() { return err; },
  };
}

describe("test-pools — TAP footer merge (reflection-deposit takes the LAST footer)", () => {
  test("joinTap strips per-pool footers and ends with ONE summed footer", () => {
    const a = "ok 1\n# tests 10\n# pass 9\n# fail 1\n# duration_ms 100.5\n";
    const b = "ok 2\n# tests 5\n# pass 5\n# fail 0\n# duration_ms 40\n";
    const merged = joinTap([a, b]);
    assert.equal(merged.match(/^# tests /gm)?.length, 1);
    assert.match(merged, /^# tests 15$/m);
    assert.match(merged, /^# pass 14$/m);
    assert.match(merged, /^# fail 1$/m);
    assert.match(merged, /^# duration_ms 100.5$/m);
    assert.ok(merged.indexOf("ok 2") < merged.indexOf("# tests 15"));
  });

  test("sibling shape: a single footer-less or single-footer text is unchanged in content", () => {
    assert.equal(joinTap(["ok 1\n"]), "ok 1\n");
    assert.equal(joinTap(["ok 1\n# tests 2\n# pass 2\n"]), "ok 1\n# tests 2\n# pass 2\n");
  });

  test("the deposit parser's last-footer read sees the combined total", () => {
    const merged = joinTap(["# tests 10\n# pass 10\n", "# tests 5\n# pass 4\n"]);
    const last = [...merged.matchAll(/^# tests (\d+)$/gm)].pop()![1];
    assert.equal(last, "15");
  });
});

describe("test-pools — runPools orchestration (INV-5/6/7)", () => {
  test("both pools pass: exit 0, parallel stdout appended after serial, one summed footer last", async () => {
    const c = capture();
    const r = await runPools({
      invocations: inv(`console.log("SERIAL-LINE"); ${footerJs(3, 3, 100)}`, `console.log("PARALLEL-LINE"); ${footerJs(2, 2, 50)}`),
      env: process.env, stdout: c.stdout, stderr: c.stderr,
    });
    assert.equal(r.code, 0);
    assert.equal(r.signal, null);
    assert.ok(c.out.indexOf("SERIAL-LINE") < c.out.indexOf("PARALLEL-LINE"));
    assert.equal(c.out.match(/^# tests /gm)?.length, 1);
    assert.match(c.out, /^# tests 5$/m);
    assert.ok(c.out.trimEnd().endsWith("# duration_ms 100"));
  });

  test("a failing child propagates its exit code even when the sibling passes", async () => {
    const c = capture();
    const r = await runPools({
      invocations: inv(`${footerJs(1, 1, 1)}`, `console.log("x"); process.exit(3)`),
      env: process.env, stdout: c.stdout, stderr: c.stderr,
    });
    assert.equal(r.code, 3);
    assert.equal(r.signal, null);
  });

  test("signal death of one child terminates the sibling and reports the killed pool", async () => {
    const c = capture();
    const t0 = Date.now();
    const r = await runPools({
      invocations: inv(`setTimeout(() => {}, 30000)`, `process.kill(process.pid, "SIGKILL")`),
      env: process.env, stdout: c.stdout, stderr: c.stderr,
    });
    assert.equal(r.killedPool, "parallel");
    assert.equal(r.signal, "SIGKILL");
    assert.ok(Date.now() - t0 < 15000, "sibling must be killed, not waited out");
    assert.match(c.err, /INFRA-KILL source: the parallel pool child/);
  });

  test("per-pool reporter destination files are concatenated into one footer and the parts removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pools-dest-"));
    try {
      const w = (n: number) => `require("fs").writeFileSync(process.env.DEST_BASE + "${n === 1 ? ".serial" : ".parallel"}", "tap ${n}\\n# tests ${n}\\n# pass ${n}\\n")`;
      const c = capture();
      const env = { ...process.env, DEST_BASE: join(dir, "out.tap") };
      const r = await runPools({ invocations: inv(w(1), w(2), ["out.tap"]), env, cwd: dir, stdout: c.stdout, stderr: c.stderr });
      assert.equal(r.code, 0);
      const text = readFileSync(join(dir, "out.tap"), "utf8");
      assert.match(text, /tap 1\ntap 2\n/);
      assert.equal(text.match(/^# tests /gm)?.length, 1);
      assert.match(text, /^# tests 3$/m);
      assert.equal(existsSync(join(dir, "out.tap.serial")), false);
      assert.equal(existsSync(join(dir, "out.tap.parallel")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the private buffer directory is removed on success and on signal death", async () => {
    const root = mkdtempSync(join(tmpdir(), "pools-tmproot-"));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const c = capture();
      await runPools({ invocations: inv(`1`, `console.log("p")`), env: process.env, stdout: c.stdout, stderr: c.stderr });
      assert.deepEqual(readdirSync(root), []);
      await runPools({ invocations: inv(`setTimeout(()=>{},30000)`, `process.kill(process.pid,"SIGKILL")`), env: process.env, stdout: c.stdout, stderr: c.stderr });
      assert.deepEqual(readdirSync(root), []);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sibling shape: a lone serial pool passes through with its own footer", async () => {
    const c = capture();
    const r = await runPools({ invocations: inv(`console.log("only"); ${footerJs(4, 4, 9)}`, null), env: process.env, stdout: c.stdout, stderr: c.stderr });
    assert.equal(r.code, 0);
    assert.match(c.out, /only/);
    assert.match(c.out, /^# tests 4$/m);
  });
});

describe("test-pools — hazard scan is transitive (QA round 2)", () => {
  function tree(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "pools-tree-"));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return root;
  }

  test("a fixed /tmp path in an imported helper pins the importing test serial", () => {
    const root = tree({
      "test/a.test.mts": 'import "../scripts/h.mjs";\n',
      "test/b.test.mts": 'import "../scripts/clean.mjs";\n',
      "scripts/h.mjs": 'export const p = "/tmp/shared-thing";\n',
      "scripts/clean.mjs": "export const x = 1;\n",
    });
    try {
      const m = scanPools(root);
      assert.deepEqual(m.parallel, ["test/b.test.mts"]);
      assert.ok("test/a.test.mts" in m.serialPinned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a mkdtemp-wrapped tmpdir() prefix is unique per call and is not a hazard; a bare constant path is", () => {
    const root = tree({
      "test/a.test.mts": 'const d = mkdtempSync(join(tmpdir(), "a-test-"));\n',
      "test/b.test.mts": 'const p = join(tmpdir(), "shared-name");\n',
    });
    try {
      const m = scanPools(root);
      assert.deepEqual(m.parallel, ["test/a.test.mts"]);
      assert.ok("test/b.test.mts" in m.serialPinned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spawned slashless script that the scan cannot resolve fails toward serial", () => {
    const root = tree({
      "test/a.test.mts": 'spawn("mystery.mjs");\n',
      "test/b.test.mts": 'spawn("known.mjs");\n',
      "scripts/known.mjs": "export const x = 1;\n",
    });
    try {
      const m = scanPools(root);
      assert.ok("test/a.test.mts" in m.serialPinned);
      assert.deepEqual(m.parallel, ["test/b.test.mts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a Redis marker reached through a slashless script literal keeps the test out of both lists", () => {
    const root = tree({
      "test/a.test.mts": 'spawn("db.mjs");\n',
      "scripts/db.mjs": 'import Redis from "ioredis";\n',
    });
    try {
      const m = scanPools(root);
      assert.deepEqual(m.parallel, []);
      assert.deepEqual(m.serialPinned, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
