/**
 * Regression tests for the metrics publisher (issue #315).
 *
 * Bug class this guards against:
 *   - `metrics/orchestrator-share.txt` missing on disk because the
 *     orchestrator never publishes it -> outcomes file adapter logs ENOENT
 *     every Meta-analysis tick.
 *   - Non-finite values (NaN, Infinity) silently written -> file adapter
 *     returns null and the outcome is permanently unobservable.
 *   - Missing `metrics/` directory crashing the publisher (it has to
 *     mkdir it on first cycle).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeMetricFile } from "../src/metrics-publisher.ts";
import { getOutcomeValue, type Outcome } from "../src/outcomes.ts";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-metrics-pub-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("writeMetricFile — basic IO", () => {
  test("writes a finite share value with trailing newline", async () => {
    const filePath = join(tmpDir, "share.txt");
    const ok = await writeMetricFile(0.42, filePath);
    assert.equal(ok, true);
    const raw = await readFile(filePath, "utf-8");
    // Number(raw.trim()) must round-trip — that's what the outcomes file
    // adapter does (src/outcomes.ts readFileAdapter).
    assert.equal(Number(raw.trim()), 0.42);
    assert.ok(raw.endsWith("\n"), "trailing newline expected");
  });

  test("creates parent directories when missing", async () => {
    // Nested path that does not yet exist — first-cycle scenario.
    const filePath = join(tmpDir, "deep", "nested", "share.txt");
    const ok = await writeMetricFile(0.18, filePath);
    assert.equal(ok, true);
    const st = await stat(filePath);
    assert.ok(st.isFile());
    assert.equal(Number((await readFile(filePath, "utf-8")).trim()), 0.18);
  });

  test("overwrites previous value on subsequent writes", async () => {
    const filePath = join(tmpDir, "rolling.txt");
    assert.equal(await writeMetricFile(0.1, filePath), true);
    assert.equal(await writeMetricFile(0.3, filePath), true);
    const raw = await readFile(filePath, "utf-8");
    assert.equal(Number(raw.trim()), 0.3);
  });

  test("refuses to write non-finite values (NaN / Infinity)", async () => {
    const filePath = join(tmpDir, "bad.txt");
    assert.equal(await writeMetricFile(Number.NaN, filePath), false);
    assert.equal(await writeMetricFile(Number.POSITIVE_INFINITY, filePath), false);
    // File should not exist after refused writes.
    await assert.rejects(stat(filePath), /ENOENT/);
  });
});

describe("round-trip — writer + outcomes file adapter", () => {
  // Core regression: writing a known share value and reading it back
  // through getOutcomeValue() yields the same number. This is the
  // acceptance criterion: "Regression test: writing a known share value
  // and reading it back returns the same number through the outcome
  // adapter." (issue #315)
  test("written share is readable via outcomes file adapter", async () => {
    const filePath = join(tmpDir, "roundtrip.txt");
    const written = 0.275;
    assert.equal(await writeMetricFile(written, filePath), true);

    const outcome: Outcome = {
      name: "orchestrator-self-improvement-share",
      kind: "leading",
      direction: "up",
      source: "file",
      // Absolute path so resolveFilePath() doesn't append HYDRA_ROOT.
      query: filePath,
      baseline: 0,
      target: 0.25,
      noise_epsilon: 0.01,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "outcomes file adapter should return a reading, not null");
    assert.equal(reading!.value, written);
    assert.ok(typeof reading!.ts === "string" && reading!.ts.length > 0);
  });

  test("zero share is a valid reading (not null, not error)", async () => {
    // When no cycles have recorded yet, share is 0. Writing 0 must still
    // produce a parseable file — the file adapter treats 0 as a real value
    // and reports it honestly. The alternative — refusing to write — was
    // the bug this issue exists to fix.
    const filePath = join(tmpDir, "zero.txt");
    assert.equal(await writeMetricFile(0, filePath), true);

    const outcome: Outcome = {
      name: "x",
      kind: "leading",
      direction: "up",
      source: "file",
      query: filePath,
      baseline: 0,
      target: 0.25,
      noise_epsilon: 0,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "zero must be readable");
    assert.equal(reading!.value, 0);
  });
});
