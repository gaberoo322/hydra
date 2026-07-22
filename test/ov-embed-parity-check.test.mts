/**
 * Tests for the OpenViking embedding-parity check pure logic (issue #3543).
 *
 * Covers the exported decision surface of scripts/ov-embed-parity-check.ts:
 *   - cosineSimilarity: identical / orthogonal / opposite vectors, FP clamp,
 *     and the null-degrade cases (length mismatch, empty, zero-magnitude,
 *     non-finite) that mark a sample unpairable.
 *   - summarizeParity branches:
 *       * parity (mean >= threshold, incl. exact-boundary)
 *       * drift  (mean <  threshold)
 *       * not-runnable (no paired cosines — never a green light)
 *     plus meanCosine / minCosine / pairedCount reporting.
 *   - exitCodeFor: the verdict -> exit-code contract (0 / 1 / 2).
 *   - DEFAULT_PARITY_THRESHOLD is the 0.99 cutover gate.
 *
 * The driver (workspace sampling + the two /v1/embeddings HTTP calls) is
 * intentionally NOT exercised here — it does filesystem + network I/O and
 * fails soft to `not-runnable` (exit 2), which the pure branches below already
 * cover. Mirrors the test/deploy-drift.test.mts convention (test the pure
 * classifier, trust the wiring).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  cosineSimilarity,
  summarizeParity,
  exitCodeFor,
  DEFAULT_PARITY_THRESHOLD,
} from "../scripts/ov-embed-parity-check.ts";

describe("cosineSimilarity", () => {
  test("identical vectors -> 1", () => {
    const cos = cosineSimilarity([1, 2, 3], [1, 2, 3]);
    assert.ok(cos !== null);
    assert.ok(Math.abs(cos! - 1) < 1e-9, `expected ~1, got ${cos}`);
  });

  test("parallel (scaled) vectors -> 1", () => {
    const cos = cosineSimilarity([1, 2, 3], [2, 4, 6]);
    assert.ok(cos !== null);
    assert.ok(Math.abs(cos! - 1) < 1e-9, `expected ~1, got ${cos}`);
  });

  test("orthogonal vectors -> 0", () => {
    const cos = cosineSimilarity([1, 0], [0, 1]);
    assert.ok(cos !== null);
    assert.ok(Math.abs(cos!) < 1e-9, `expected ~0, got ${cos}`);
  });

  test("opposite vectors -> -1", () => {
    const cos = cosineSimilarity([1, 2, 3], [-1, -2, -3]);
    assert.ok(cos !== null);
    assert.ok(Math.abs(cos! + 1) < 1e-9, `expected ~-1, got ${cos}`);
  });

  test("result is clamped into [-1, 1]", () => {
    const cos = cosineSimilarity([1e-3, 1e-3], [1e-3, 1e-3]);
    assert.ok(cos !== null);
    assert.ok(cos! <= 1 && cos! >= -1);
  });

  test("length mismatch (dimension drift) -> null (unpairable)", () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), null);
  });

  test("empty vector -> null", () => {
    assert.equal(cosineSimilarity([], []), null);
    assert.equal(cosineSimilarity([1, 2], []), null);
  });

  test("zero-magnitude vector -> null (no direction)", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), null);
  });

  test("non-finite component -> null, never NaN/throw", () => {
    assert.equal(cosineSimilarity([1, Number.NaN], [1, 2]), null);
    assert.equal(cosineSimilarity([1, Infinity], [1, 2]), null);
  });
});

describe("summarizeParity — parity (mean >= threshold)", () => {
  test("all-1 cosines clear the 0.99 gate -> parity / exit-code 0 verdict", () => {
    const s = summarizeParity([1, 1, 1, 1]);
    assert.equal(s.verdict, "parity");
    assert.equal(s.pairedCount, 4);
    assert.equal(s.meanCosine, 1);
    assert.equal(s.minCosine, 1);
    assert.equal(s.threshold, DEFAULT_PARITY_THRESHOLD);
    assert.match(s.message, /PARITY/);
    assert.match(s.message, /NO reindex/);
  });

  test("mean exactly at the threshold counts as parity (>=)", () => {
    // Single sample so the mean is exactly the threshold value (no FP sum
    // drift); the >= boundary must classify as parity, not drift.
    const s = summarizeParity([0.99], 0.99);
    assert.equal(s.verdict, "parity");
    assert.equal(s.meanCosine, 0.99);
  });

  test("reports the worst outlier as minCosine while still meeting parity", () => {
    const s = summarizeParity([1.0, 0.995, 0.998], 0.99);
    assert.equal(s.verdict, "parity");
    assert.equal(s.minCosine, 0.995);
  });
});

describe("summarizeParity — drift (mean < threshold)", () => {
  test("mean below the gate -> drift verdict demanding a reindex", () => {
    const s = summarizeParity([0.8, 0.85, 0.9], 0.99);
    assert.equal(s.verdict, "drift");
    assert.ok(s.meanCosine < 0.99);
    assert.match(s.message, /DRIFT/);
    assert.match(s.message, /reindex/);
  });

  test("a single bad outlier can drag the mean under the gate", () => {
    // Three near-perfect + one poor pair; mean falls below 0.99.
    const s = summarizeParity([1.0, 1.0, 1.0, 0.9], 0.99);
    assert.equal(s.verdict, "drift");
    assert.equal(s.minCosine, 0.9);
  });
});

describe("summarizeParity — not-runnable (no paired cosines)", () => {
  test("empty cosine set is NOT a green light", () => {
    const s = summarizeParity([], 0.99);
    assert.equal(s.verdict, "not-runnable");
    assert.equal(s.pairedCount, 0);
    assert.equal(s.meanCosine, 0);
    assert.match(s.message, /NOT RUNNABLE/);
  });

  test("uses the default threshold when none is given", () => {
    const s = summarizeParity([0.999, 0.999]);
    assert.equal(s.threshold, DEFAULT_PARITY_THRESHOLD);
    assert.equal(s.verdict, "parity");
  });
});

describe("exitCodeFor — verdict -> exit-code contract", () => {
  test("parity -> 0 (safe cutover, no reindex)", () => {
    assert.equal(exitCodeFor("parity"), 0);
  });

  test("drift -> 1 (below threshold, reindex required)", () => {
    assert.equal(exitCodeFor("drift"), 1);
  });

  test("not-runnable -> 2 (could not measure, not a green light)", () => {
    assert.equal(exitCodeFor("not-runnable"), 2);
  });

  test("a drift run exits non-zero (the acceptance criterion)", () => {
    const s = summarizeParity([0.5, 0.6], 0.99);
    assert.notEqual(exitCodeFor(s.verdict), 0);
  });
});

describe("DEFAULT_PARITY_THRESHOLD", () => {
  test("is the 0.99 cutover gate from issue #3543", () => {
    assert.equal(DEFAULT_PARITY_THRESHOLD, 0.99);
  });
});
