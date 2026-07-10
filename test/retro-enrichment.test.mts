/**
 * Direct unit tests for the per-cycle dispatch enrichment join
 * (`src/autopilot/retro-enrichment.ts`, issue #3055).
 *
 * The join was extracted out of the 552-line `assembleRetroBundle` so the
 * three-source terminal-record chain (durable outcome record → cycle-metrics
 * sidecar → cycle-hash), the #1352 provisional-cycleId confirm-or-drop, the
 * #1823 post-enrichment canonical-cycleId dedup, and the #975/#1168
 * crash-term-reason backfill live in ONE focused, directly-testable function.
 *
 * The structural win the extraction buys (issue #3055): a test for a single
 * join rule needs ONLY the enricher's deps bag (a `safeSource` shim + two cycle
 * readers + an outcome map + a term_reason) — NO run-record stub, NO reflection
 * stub, NO friction / stuck-signal / recommendation fan-out scaffolding. These
 * tests assert directly on `RetroDispatch[]` in / `RetroDispatch[]` out. The
 * end-to-end behaviour stays pinned by `test/retro-bundle.test.mts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  enrichDispatchesWithCycleData,
  CRASH_TERM_REASONS,
  type EnrichDispatchesDeps,
  type SafeSource,
} from "../src/autopilot/retro-enrichment.ts";
import type { RetroDispatch } from "../src/autopilot/retro-projections.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";

// ---------------------------------------------------------------------------
// Fixtures — note how little scaffolding a single-rule test needs.
// ---------------------------------------------------------------------------

function dispatch(over: Partial<RetroDispatch> = {}): RetroDispatch {
  return {
    cycleId: "c1",
    turn_n: 1,
    skill: "hydra-dev",
    anchorReference: "issue-3055",
    prNumber: null,
    status: "merged",
    bucket: "merged",
    abandonReason: null,
    regressionIntroduced: false,
    flagged: false,
    undrillable: false,
    ...over,
  };
}

/**
 * The real never-throw `safeSource` shape: run `fn`, and on rejection record
 * the failed source name + return the fallback. Mirrors the assembler's
 * private wrapper (already tested in `retro-bundle.test.mts`), letting these
 * tests assert the enricher's error surfacing without an `errors[]` array.
 */
function makeSafeSource(failedSources: string[]): SafeSource {
  return async <T,>(source: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      failedSources.push(source);
      return fallback;
    }
  };
}

function baseDeps(over: Partial<EnrichDispatchesDeps> = {}): EnrichDispatchesDeps {
  return {
    readCycleMetrics: async () => ({}),
    readCycleHash: async () => ({}),
    outcomeByCycleId: new Map<string, DispatchOutcomeRecord>(),
    termReason: "budget",
    safeSource: makeSafeSource([]),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Three-source terminal-record chain
// ---------------------------------------------------------------------------

describe("enrichDispatchesWithCycleData — three-source join", () => {
  test("cycle-metrics sidecar enriches abandonReason + regression", async () => {
    const rows = [dispatch({ cycleId: "cx", status: "merged", bucket: "merged" })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      readCycleMetrics: async () => ({ abandonReason: "auto-reverted", regressionIntroduced: "true" }),
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0].abandonReason, "auto-reverted");
    assert.equal(out[0].regressionIntroduced, true);
  });

  test("durable outcome record is the PRIMARY status backfill (cycle-hash not read)", async () => {
    let hashReads = 0;
    const outcomeByCycleId = new Map<string, DispatchOutcomeRecord>([
      ["c1", { cycleId: "c1", outcome: "failed" } as DispatchOutcomeRecord],
    ]);
    const rows = [dispatch({ cycleId: "c1", status: null, bucket: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      // The sidecar carries a terminal-shaped field so the candidate is confirmable.
      readCycleMetrics: async () => ({ abandonReason: "" }),
      outcomeByCycleId,
      readCycleHash: async () => {
        hashReads += 1;
        return { status: "failed" };
      },
    }));
    assert.equal(out[0].status, "failed", "status backfilled from the durable record");
    assert.equal(out[0].bucket, "failed");
    assert.equal(hashReads, 0, "the durable record short-circuits the cycle-hash read");
  });

  test("cycle-hash is the dark-tolerant fallback when no durable record exists", async () => {
    let hashReads = 0;
    const rows = [dispatch({ cycleId: "legacy", status: null, bucket: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      readCycleMetrics: async () => ({ abandonReason: "" }),
      outcomeByCycleId: new Map(),
      readCycleHash: async () => {
        hashReads += 1;
        return { status: "completed" };
      },
    }));
    assert.equal(out[0].status, "completed", "status backfilled from the cycle-hash fallback");
    assert.equal(hashReads, 1);
  });

  test("backfills anchorReference + prNumber from the sidecar only when the row left them null", async () => {
    const rows = [dispatch({ cycleId: "c1", status: "merged", anchorReference: null, prNumber: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      readCycleMetrics: async () => ({ anchorReference: "issue-999", prNumber: "1000" }),
    }));
    assert.equal(out[0].anchorReference, "issue-999");
    assert.equal(out[0].prNumber, "1000");
  });

  test("an action-carried anchor/PR wins over the sidecar (enrich-only)", async () => {
    const rows = [dispatch({ cycleId: "c1", status: "merged", anchorReference: "issue-action", prNumber: "42" })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      readCycleMetrics: async () => ({ anchorReference: "issue-sidecar", prNumber: "999" }),
    }));
    assert.equal(out[0].anchorReference, "issue-action", "action anchor is not overwritten");
    assert.equal(out[0].prNumber, "42", "action prNumber is not overwritten");
  });

  test("skips empty-cycleId rows entirely (no reader is called for them)", async () => {
    let metricsReads = 0;
    const rows = [dispatch({ cycleId: "", status: null, bucket: null, abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      termReason: "budget",
      readCycleMetrics: async () => {
        metricsReads += 1;
        return {};
      },
    }));
    assert.equal(metricsReads, 0, "an empty-cycleId row is never read");
    assert.equal(out[0].abandonReason, null, "no backfill on a clean stop");
  });
});

// ---------------------------------------------------------------------------
// Provisional-cycleId confirm-or-drop (issue #1352)
// ---------------------------------------------------------------------------

describe("enrichDispatchesWithCycleData — provisional confirm-or-drop (#1352)", () => {
  test("a confirmed provisional candidate (cycle-hash resolves) keeps its handle", async () => {
    const rows = [dispatch({ cycleId: "tid-completed", status: null, bucket: null, abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      termReason: "interrupted",
      readCycleMetrics: async () => ({ abandonReason: "verification-failure" }),
      readCycleHash: async () => ({ status: "failed" }),
    }));
    assert.equal(out[0].cycleId, "tid-completed", "confirmed candidate keeps its drillable handle");
    assert.equal(out[0].status, "failed");
    assert.equal(out[0].abandonReason, "verification-failure");
  });

  test("an unconfirmed provisional candidate (no terminal record) is dropped to '' and gets the run-<reason> backfill", async () => {
    const rows = [dispatch({ cycleId: "tid-inflight", status: null, bucket: null, abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      termReason: "interrupted",
      readCycleMetrics: async () => ({}), // no terminal-shaped field ⇒ not confirmed
      readCycleHash: async () => ({}),
    }));
    assert.equal(out[0].cycleId, "", "unconfirmed in-flight candidate reset to '' (undrillable)");
    assert.equal(out[0].abandonReason, "run-interrupted", "#1168 visibility backfill applied");
  });

  test("a NON-provisional (action-derived, resolved status) cycleId is never dropped", async () => {
    const rows = [dispatch({ cycleId: "real", status: "failed", bucket: "failed" })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      termReason: "interrupted",
      readCycleMetrics: async () => ({}),
      readCycleHash: async () => ({}),
    }));
    assert.equal(out[0].cycleId, "real", "an action-derived handle is never confirm-or-dropped");
  });
});

// ---------------------------------------------------------------------------
// Post-enrichment canonical-cycleId dedup (issue #1823)
// ---------------------------------------------------------------------------

describe("enrichDispatchesWithCycleData — post-enrichment dedup (#1823)", () => {
  test("two rows resolving to the same cycleId collapse into one (earliest turn canonical)", async () => {
    const TASK_ID = "aab08248";
    const rows = [
      dispatch({ cycleId: TASK_ID, turn_n: 3, status: null, bucket: null, prNumber: null, anchorReference: "A" }),
      dispatch({ cycleId: TASK_ID, turn_n: 2, status: null, bucket: null, prNumber: "1830", anchorReference: "A" }),
    ];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      termReason: "budget",
      readCycleMetrics: async (id) => (id === TASK_ID ? { anchorReference: "A" } : {}),
      readCycleHash: async (id) => (id === TASK_ID ? { status: "failed" } : {}),
    }));
    assert.equal(out.length, 1, "one real cycle → exactly one row");
    assert.equal(out[0].turn_n, 2, "earliest-turn row is canonical");
    assert.equal(out[0].prNumber, "1830", "non-null field from the dropped row is unioned in");
    assert.equal(out[0].status, "failed");
  });

  test("distinct cycleIds are never merged", async () => {
    const rows = [
      dispatch({ cycleId: "c1", turn_n: 1, status: "merged" }),
      dispatch({ cycleId: "c2", turn_n: 2, status: "merged" }),
    ];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps());
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((d) => d.cycleId), ["c1", "c2"]);
  });
});

// ---------------------------------------------------------------------------
// Crash-term-reason backfill (issue #975 / #1168)
// ---------------------------------------------------------------------------

describe("enrichDispatchesWithCycleData — crash-term-reason backfill (#975/#1168)", () => {
  for (const reason of [...CRASH_TERM_REASONS]) {
    test(`term_reason=${reason} stamps run-${reason} on a status-less, cycleId-less dispatch`, async () => {
      const rows = [dispatch({ cycleId: "", status: null, bucket: null, abandonReason: null })];
      const out = await enrichDispatchesWithCycleData(rows, baseDeps({ termReason: reason }));
      assert.equal(out[0].abandonReason, `run-${reason}`);
      // Never claims a positive outcome on a status that was never written.
      assert.equal(out[0].status, null, "status stays null (no false merged)");
    });
  }

  test("a clean stop (budget) does NOT fabricate a failure abandonReason", async () => {
    const rows = [dispatch({ cycleId: "", status: null, bucket: null, abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({ termReason: "budget" }));
    assert.equal(out[0].abandonReason, null, "no fabricated failure on a clean stop");
  });

  test("handoff (clean) does NOT backfill — an in-flight slot stays pending (#1903)", async () => {
    const rows = [dispatch({ cycleId: "", status: null, bucket: null, abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({ termReason: "handoff" }));
    assert.equal(out[0].abandonReason, null, "handoff is not in CRASH_TERM_REASONS — no run-handoff stamp");
  });

  test("the backfill only fills a status-less row — a resolved status keeps its abandonReason null", async () => {
    const rows = [dispatch({ cycleId: "cReal", status: "merged", bucket: "merged", abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({ termReason: "crash" }));
    assert.equal(out[0].abandonReason, null, "a dispatch that recorded a terminal status is not backfilled");
  });
});

// ---------------------------------------------------------------------------
// Never-throw contract
// ---------------------------------------------------------------------------

describe("enrichDispatchesWithCycleData — never-throw", () => {
  test("a rejecting cycle-metrics reader is caught via safeSource; enrichment still returns", async () => {
    const failed: string[] = [];
    const rows = [dispatch({ cycleId: "c1", status: "merged" })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      safeSource: makeSafeSource(failed),
      readCycleMetrics: async () => {
        throw new Error("metrics boom");
      },
    }));
    assert.equal(out.length, 1, "the bundle still assembles");
    assert.ok(failed.includes("cycle-metrics"), "the failed source is surfaced through safeSource");
  });

  test("a rejecting cycle-hash reader (in the fallback path) is caught; the row stays status-null", async () => {
    const failed: string[] = [];
    const rows = [dispatch({ cycleId: "legacy", status: null, bucket: null, abandonReason: null })];
    const out = await enrichDispatchesWithCycleData(rows, baseDeps({
      termReason: "budget",
      safeSource: makeSafeSource(failed),
      readCycleMetrics: async () => ({}),
      outcomeByCycleId: new Map(),
      readCycleHash: async () => {
        throw new Error("hash boom");
      },
    }));
    assert.equal(out[0].status, null, "the failed hash read leaves status unresolved (partial enrichment)");
    assert.ok(failed.includes("cycle-record"), "the cycle-record source is surfaced");
  });
});
