/**
 * Regression tests for the run-tree retro-bundle library (issue #918, epic
 * #917).
 *
 * The library (`src/autopilot/retro-bundle.ts`) is a never-throw, read-only
 * assembler. Every sub-source reader is injectable via the `deps` object, so
 * these tests pin behavior WITHOUT touching Redis — including the never-throw
 * contract, which is exercised by handing the assembler readers that reject.
 *
 * Coverage maps to the issue's acceptance criteria:
 *   AC1 — Given a run_id, returns a structured bundle covering the run
 *         record, dispatch decisions+reasons (turns), per-dispatch records,
 *         QA-verdict/why-it-failed reflections, stuck-signals, recs, and
 *         friction patterns.
 *   AC2 — `flagDispatchesForDrill` is a pure selector that picks the
 *         failed/regressed/errored subset and leaves the happy path out.
 *   AC3 — Never-throw: a rejecting sub-source yields a partial bundle plus a
 *         recorded `errors[]` entry, never a throw.
 *   (AC4 — the read endpoint + run_id validation — is covered by the route's
 *    schema/handler, exercised below at the library boundary.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assembleRetroBundle,
  flagDispatchesForDrill,
  projectDispatches,
  type RetroBundleDeps,
  type RetroDispatch,
} from "../src/autopilot/retro-bundle.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dispatch(over: Partial<RetroDispatch> = {}): RetroDispatch {
  return {
    cycleId: "c1",
    turn_n: 1,
    skill: "hydra-dev",
    anchorReference: "issue-918",
    prNumber: null,
    status: "merged",
    bucket: "merged",
    abandonReason: null,
    regressionIntroduced: false,
    ...over,
  };
}

/**
 * A `deps` object whose every reader is a benign stub. Individual tests
 * override the readers they care about.
 */
function baseDeps(over: Partial<RetroBundleDeps> = {}): RetroBundleDeps {
  return {
    now: new Date("2026-06-02T12:00:00.000Z"),
    readRun: async () =>
      ({
        ok: true,
        run: { run_id: "run-1", status: "ended", term_reason: "budget", turns: 2, dispatches: 1 },
        turns: [
          {
            turn_n: 2,
            reasons: ["dispatched dev_orch for issue-918"],
            actions: [
              {
                type: "dispatch",
                skill: "hydra-dev",
                anchorReference: "issue-918",
                outcome: { cycleId: "c1", status: "merged", prNumber: "920" },
              },
            ],
          },
        ],
      }) as any,
    readCycleHash: async () => ({ status: "merged" }),
    readCycleMetrics: async () => ({}),
    readRecommendations: async () => ({}),
    readAnchorReflections: async () => ({ content: "", count: 0 }),
    readFrictionPatterns: async () => [],
    readStuckSignals: async () => [],
    frictionSkills: ["hydra-dev"],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AC2 — flagDispatchesForDrill (pure)
// ---------------------------------------------------------------------------

describe("flagDispatchesForDrill", () => {
  test("flags failed, regressed, and errored dispatches; skips happy path", () => {
    const merged = dispatch({ cycleId: "ok", status: "merged", bucket: "merged" });
    const failed = dispatch({ cycleId: "fail", status: "failed", bucket: "failed" });
    const regressed = dispatch({
      cycleId: "regress",
      status: "merged",
      bucket: "merged",
      regressionIntroduced: true,
    });
    const errored = dispatch({
      cycleId: "err",
      status: "merged",
      bucket: "merged",
      abandonReason: "verification-failure",
    });

    const flagged = flagDispatchesForDrill([merged, failed, regressed, errored]);
    const ids = flagged.map((d) => d.cycleId);
    assert.deepEqual(ids, ["fail", "regress", "err"]);
  });

  test("does not flag a pending dispatch (status null)", () => {
    const pending = dispatch({ cycleId: "p", status: null, bucket: null });
    assert.deepEqual(flagDispatchesForDrill([pending]), []);
  });

  test("preserves input order in the flagged subset", () => {
    const a = dispatch({ cycleId: "a", status: "failed", bucket: "failed" });
    const b = dispatch({ cycleId: "b", status: "aborted", bucket: "failed" });
    const flagged = flagDispatchesForDrill([a, b]);
    assert.deepEqual(flagged.map((d) => d.cycleId), ["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// projectDispatches (pure)
// ---------------------------------------------------------------------------

describe("projectDispatches", () => {
  test("projects dispatch actions and joins outcome status/PR", () => {
    const turns = [
      {
        turn_n: 1,
        actions: [
          { type: "noop" },
          {
            type: "dispatch",
            skill: "hydra-dev",
            anchorReference: "issue-1",
            outcome: { cycleId: "c1", status: "merged", prNumber: 42 },
          },
        ],
      },
    ];
    const out = projectDispatches(turns);
    assert.equal(out.length, 1);
    assert.equal(out[0].cycleId, "c1");
    assert.equal(out[0].skill, "hydra-dev");
    assert.equal(out[0].anchorReference, "issue-1");
    assert.equal(out[0].status, "merged");
    assert.equal(out[0].bucket, "merged");
    assert.equal(out[0].prNumber, "42");
    assert.equal(out[0].turn_n, 1);
  });

  test("pending dispatch (outcome null) yields status null / bucket null", () => {
    const turns = [
      { turn_n: 3, actions: [{ type: "dispatch", cycleId: "c9", outcome: null }] },
    ];
    const out = projectDispatches(turns);
    assert.equal(out[0].cycleId, "c9");
    assert.equal(out[0].status, null);
    assert.equal(out[0].bucket, null);
  });
});

// ---------------------------------------------------------------------------
// AC1 — full bundle composition
// ---------------------------------------------------------------------------

describe("assembleRetroBundle — composition", () => {
  test("assembles every sub-source into the bundle", async () => {
    const deps = baseDeps({
      readCycleMetrics: async () => ({
        abandonReason: "",
        regressionIntroduced: "false",
        anchorReference: "issue-918",
        prNumber: "920",
      }),
      readRecommendations: async () => ({
        r1: JSON.stringify({ id: "r1", severity: "warn", text: "watch the churn" }),
      }),
      readStuckSignals: async () => [
        { type: "idle-streak", severity: "info", summary: "idle", evidence: {} },
      ],
      readFrictionPatterns: async () => [
        {
          category: "scope-check-trap",
          severity: "prevent",
          hitCount: 4,
          firstSeen: "2026-06-01",
          lastSeen: "2026-06-02",
          lastCycleId: "c1",
          action: "keep filenames plain text",
          examples: [],
          promoted: false,
        } as any,
      ],
    });

    const bundle = await assembleRetroBundle("run-1", deps);

    assert.equal(bundle.run_id, "run-1");
    assert.equal(bundle.runFound, true);
    assert.equal(bundle.generatedAt, "2026-06-02T12:00:00.000Z");
    assert.equal((bundle.run as any).status, "ended");
    assert.equal((bundle.run as any).term_reason, "budget");
    assert.equal(bundle.turns.length, 1);
    assert.deepEqual((bundle.turns[0] as any).reasons, ["dispatched dev_orch for issue-918"]);
    assert.equal(bundle.dispatches.length, 1);
    assert.equal(bundle.dispatches[0].cycleId, "c1");
    assert.equal(bundle.dispatches[0].prNumber, "920");
    assert.equal(bundle.recommendations.length, 1);
    assert.equal((bundle.recommendations[0] as any).id, "r1");
    assert.equal(bundle.stuckSignals.length, 1);
    assert.equal(bundle.frictionPatterns.length, 1);
    assert.equal(bundle.frictionPatterns[0].category, "scope-check-trap");
    assert.deepEqual(bundle.errors, []);
  });

  test("only the FLAGGED dispatches get reflection narratives", async () => {
    let reflectionCalls = 0;
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-1", status: "ended" },
          turns: [
            {
              turn_n: 2,
              actions: [
                {
                  type: "dispatch",
                  anchorReference: "issue-merged",
                  outcome: { cycleId: "ok", status: "merged" },
                },
                {
                  type: "dispatch",
                  anchorReference: "issue-failed",
                  outcome: { cycleId: "bad", status: "failed" },
                },
              ],
            },
          ],
        }) as any,
      readAnchorReflections: async (anchor: string) => {
        reflectionCalls += 1;
        return { content: `## PRIOR ATTEMPTS for ${anchor}`, count: 1 };
      },
    });

    const bundle = await assembleRetroBundle("run-1", deps);
    // Only the failed dispatch's anchor should have been read.
    assert.equal(reflectionCalls, 1);
    assert.equal(bundle.reflections.length, 1);
    assert.equal(bundle.reflections[0].anchorReference, "issue-failed");
    assert.equal(bundle.reflections[0].count, 1);
  });

  test("metrics sidecar enriches abandonReason + regression for the drill flag", async () => {
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-1", status: "ended" },
          turns: [
            {
              turn_n: 1,
              actions: [
                {
                  type: "dispatch",
                  anchorReference: "issue-x",
                  // status merged on the turn join, but the sidecar marks a regression
                  outcome: { cycleId: "cx", status: "merged" },
                },
              ],
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({
        regressionIntroduced: "true",
        abandonReason: "auto-reverted",
      }),
    });

    const bundle = await assembleRetroBundle("run-1", deps);
    assert.equal(bundle.dispatches[0].regressionIntroduced, true);
    assert.equal(bundle.dispatches[0].abandonReason, "auto-reverted");
    // A merged-but-regressed dispatch is drill-worthy → got a reflection read.
    assert.equal(bundle.reflections.length, 1);
    assert.equal(bundle.reflections[0].anchorReference, "issue-x");
  });
});

// ---------------------------------------------------------------------------
// AC3 — never-throw + partial bundle
// ---------------------------------------------------------------------------

describe("assembleRetroBundle — never-throw contract", () => {
  test("a rejecting run reader yields runFound=false, not a throw", async () => {
    const deps = baseDeps({
      readRun: async () => {
        throw new Error("redis down");
      },
    });
    const bundle = await assembleRetroBundle("run-1", deps);
    assert.equal(bundle.runFound, false);
    assert.equal(bundle.run, null);
    assert.deepEqual(bundle.turns, []);
    assert.ok(bundle.errors.some((e) => e.source === "run-record" && /redis down/.test(e.detail)));
  });

  test("a not-found run is a clean empty bundle, not an error", async () => {
    const deps = baseDeps({
      readRun: async () => ({ ok: false, code: "not-found", detail: "unknown run_id" }) as any,
    });
    const bundle = await assembleRetroBundle("nope", deps);
    assert.equal(bundle.runFound, false);
    // not-found is normal — no error entry for the run record.
    assert.equal(bundle.errors.filter((e) => e.source === "run-record").length, 0);
  });

  test("each failing sub-source records an error but the bundle still returns", async () => {
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-1" },
          turns: [
            {
              turn_n: 1,
              actions: [
                {
                  type: "dispatch",
                  anchorReference: "issue-failed",
                  outcome: { cycleId: "bad", status: "failed" },
                },
              ],
            },
          ],
        }) as any,
      readCycleMetrics: async () => {
        throw new Error("metrics boom");
      },
      readAnchorReflections: async () => {
        throw new Error("reflections boom");
      },
      readStuckSignals: async () => {
        throw new Error("signals boom");
      },
      readRecommendations: async () => {
        throw new Error("recs boom");
      },
      readFrictionPatterns: async () => {
        throw new Error("friction boom");
      },
    });

    const bundle = await assembleRetroBundle("run-1", deps);
    // Bundle still returns with safe fallbacks.
    assert.equal(bundle.stuckSignals.length, 0);
    assert.equal(bundle.recommendations.length, 0);
    assert.equal(bundle.frictionPatterns.length, 0);
    const sources = new Set(bundle.errors.map((e) => e.source));
    for (const s of ["cycle-metrics", "reflections", "stuck-signals", "recommendations", "friction"]) {
      assert.ok(sources.has(s), `expected an error entry for ${s}`);
    }
  });

  test("a corrupt (non-JSON) rec value is kept as a raw string, not dropped", async () => {
    const deps = baseDeps({
      readRecommendations: async () => ({ good: JSON.stringify({ id: "g" }), bad: "{not json" }),
    });
    const bundle = await assembleRetroBundle("run-1", deps);
    assert.equal(bundle.recommendations.length, 2);
  });
});
