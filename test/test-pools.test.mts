/**
 * Serial/parallel pool classification (issue #5199, amends ADR-0038).
 *
 * The manifest `test/fixtures/test-pools.json` is a ratchet: this suite
 * regenerates it with scripts/test/test-pools.mjs's static scan and fails on
 * drift. Fix = `node scripts/test/test-pools.mjs --update` in the same PR.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPoolInvocations,
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
