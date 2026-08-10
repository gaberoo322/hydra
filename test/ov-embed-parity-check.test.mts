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
 *     plus meanCosine / minCosine / pairedCount reporting. UNCHANGED by
 *     issue #3854 — see the classifyWorkspace tests below for the new
 *     missing-workspace coverage; this function's own not-runnable branch is
 *     byte-for-byte identical to before.
 *   - exitCodeFor: the verdict -> exit-code contract (0 / 1 / 2).
 *   - DEFAULT_PARITY_THRESHOLD is the 0.99 cutover gate.
 *   - classifyWorkspace (issue #3854): distinguishes "missing" / "unreadable"
 *     / "ok" so a misconfigured OV_PARITY_WORKSPACE can be reported as a
 *     `not-runnable` verdict with a `reason` field distinct from a genuine
 *     "sampled but nothing paired" not-runnable result (main()'s driver
 *     layers that `reason` on by spreading, never inside summarizeParity).
 *
 * The network half of the driver (the two /v1/embeddings HTTP calls) is
 * intentionally NOT exercised here — it fails soft to `not-runnable` (exit 2),
 * which the pure branches below already cover. classifyWorkspace IS exercised
 * against real temp-dir fixtures since it is a deterministic sync fs check
 * with no network dependency. Mirrors the test/deploy-drift.test.mts
 * convention (test the pure classifier, trust the wiring).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cosineSimilarity,
  summarizeParity,
  exitCodeFor,
  classifyWorkspace,
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

  test("does not carry a reason field itself — unchanged by #3854, verbatim message preserved", () => {
    // The `reason` discriminant is layered on by main()'s driver via object
    // spread (see classifyWorkspace tests below); summarizeParity's own
    // return object is byte-for-byte the same shape it always was.
    const s = summarizeParity([], 0.99);
    assert.equal((s as any).reason, undefined);
    assert.equal(
      s.message,
      "embed parity: NOT RUNNABLE — no doc embedded on both backends " +
        "(empty sample or an endpoint unreachable); cannot green-light a cutover",
    );
  });

  test("uses the default threshold when none is given", () => {
    const s = summarizeParity([0.999, 0.999]);
    assert.equal(s.threshold, DEFAULT_PARITY_THRESHOLD);
    assert.equal(s.verdict, "parity");
  });
});

describe("classifyWorkspace (issue #3854)", () => {
  test("a real, existing, readable directory -> ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-parity-check-"));
    try {
      assert.equal(classifyWorkspace(dir), "ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nonexistent path -> missing", () => {
    assert.equal(
      classifyWorkspace("/tmp/definitely-does-not-exist-ov-parity-3854"),
      "missing",
    );
  });

  test("a path that is a file, not a directory -> unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-parity-check-"));
    const file = join(dir, "not-a-dir.txt");
    writeFileSync(file, "hello");
    try {
      assert.equal(classifyWorkspace(file), "unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never throws on a missing or unreadable path — fails soft to a status string", () => {
    assert.doesNotThrow(() => classifyWorkspace("/nonexistent/ov/workspace"));
    assert.doesNotThrow(() => classifyWorkspace(""));
  });

  test("a directory nested under a nonexistent parent -> missing, not unreadable", () => {
    // ENOENT (missing) and EACCES/EPERM (unreadable) must classify
    // differently — a caller discriminates workspace-missing from
    // workspace-unreadable on this distinction.
    assert.equal(
      classifyWorkspace("/tmp/ov-parity-3854-does-not-exist/nested/deeper"),
      "missing",
    );
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
