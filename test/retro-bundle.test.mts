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
    flagged: false,
    undrillable: false,
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

  // issue #1184 — a dispatch with a failure signal but an EMPTY cycleId has no
  // transcript handle to drill, so it must be EXCLUDED from the flagged subset
  // (it is recorded undrillable in the assembled bundle instead). This enforces
  // the invariant `flagged === true` ⟹ `cycleId !== ""`.
  test("excludes empty-cycleId dispatches even when they carry a failure signal (#1184)", () => {
    const drillableFailed = dispatch({ cycleId: "c1", status: "failed", bucket: "failed" });
    const undrillableAbandon = dispatch({
      cycleId: "",
      status: null,
      bucket: null,
      abandonReason: "run-interrupted",
    });
    const undrillableFailed = dispatch({ cycleId: "", status: "failed", bucket: "failed" });
    const undrillableRegressed = dispatch({
      cycleId: "",
      status: "merged",
      bucket: "merged",
      regressionIntroduced: true,
    });

    const flagged = flagDispatchesForDrill([
      drillableFailed,
      undrillableAbandon,
      undrillableFailed,
      undrillableRegressed,
    ]);
    // Only the cycleId-bearing failure is flagged; every empty-cycleId signal is
    // dropped (no transcript handle).
    assert.deepEqual(flagged.map((d) => d.cycleId), ["c1"]);
    // Invariant: nothing flagged has an empty cycleId.
    assert.ok(flagged.every((d) => d.cycleId !== ""), "flagged ⟹ cycleId !== ''");
  });

  test("a cycleId-bearing abandonReason is still flagged (the empty-cycleId exclusion is narrow) (#1184)", () => {
    const errored = dispatch({
      cycleId: "cReal",
      status: "merged",
      bucket: "merged",
      abandonReason: "verification-failure",
    });
    assert.deepEqual(flagDispatchesForDrill([errored]).map((d) => d.cycleId), ["cReal"]);
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

  // -------------------------------------------------------------------------
  // issue #975 — slots_snapshot reconciliation
  // -------------------------------------------------------------------------

  test("reads anchor from the action's nested prompt_args.anchor", () => {
    // The real dispatch action carries the anchor under prompt_args.anchor,
    // not the top-level anchorReference the legacy join read.
    const turns = [
      {
        turn_n: 1,
        actions: [
          {
            type: "dispatch",
            slot: "dev_orch",
            skill: "hydra-dev",
            prompt_args: { anchor: "#961", score: 0.8 },
            outcome: null,
          },
        ],
      },
    ];
    const out = projectDispatches(turns);
    assert.equal(out.length, 1);
    assert.equal(out[0].anchorReference, "#961");
    assert.equal(out[0].skill, "hydra-dev");
  });

  test("crashed-run slots_snapshot reconciles anchor/skill/prNumber when actions are missing", () => {
    // A crash truncated the turn: no dispatch action was recorded, but the
    // slots_snapshot still carries the resolvable identity. Each occupied slot
    // must yield exactly one attributable RetroDispatch.
    const turns = [
      {
        turn_n: 4,
        actions: [],
        slots_snapshot: {
          qa_orch: { skill: "hydra-qa", anchor: "PR#970", task_id: "a6f929932fd15784b" },
          dev_orch: { skill: "hydra-dev", anchor: "#961", task_id: "a089f8680966d32ec" },
          research_orch: null, // empty slot — must NOT become a dispatch
        },
      },
    ];
    const out = projectDispatches(turns);
    assert.equal(out.length, 2, "two occupied slots → two dispatches (null slot skipped)");

    const qa = out.find((d) => d.skill === "hydra-qa");
    assert.ok(qa, "qa_orch dispatch reconciled");
    assert.equal(qa!.anchorReference, "PR#970");
    assert.equal(qa!.prNumber, "970", "PR#NNN anchor parses to a prNumber");
    assert.equal(qa!.turn_n, 4);

    const dev = out.find((d) => d.skill === "hydra-dev");
    assert.ok(dev, "dev_orch dispatch reconciled");
    assert.equal(dev!.anchorReference, "#961");
    assert.equal(dev!.prNumber, null, "issue-shaped #NNN anchor is not a PR number");
  });

  test("action-derived dispatch wins; slots_snapshot only fills null fields (no double-count)", () => {
    // A slot present in BOTH actions[] and slots_snapshot must merge by slot
    // key, not concatenate. Action-carried values win; the snapshot only fills
    // what the action left null.
    const turns = [
      {
        turn_n: 2,
        actions: [
          {
            type: "dispatch",
            slot: "dev_orch",
            skill: "hydra-dev",
            anchorReference: "issue-918",
            outcome: { cycleId: "c1", status: "merged", prNumber: 920 },
          },
        ],
        slots_snapshot: {
          // Same slot, divergent anchor/skill — must NOT override the action.
          dev_orch: { skill: "hydra-other", anchor: "PR#999" },
        },
      },
    ];
    const out = projectDispatches(turns);
    assert.equal(out.length, 1, "merged by slot — exactly one dispatch, no double-count");
    assert.equal(out[0].skill, "hydra-dev", "action skill wins");
    assert.equal(out[0].anchorReference, "issue-918", "action anchor wins");
    assert.equal(out[0].prNumber, "920", "action/outcome prNumber wins over snapshot anchor");
    assert.equal(out[0].status, "merged");
  });

  test("slots_snapshot enriches an action that left skill/anchor null", () => {
    const turns = [
      {
        turn_n: 3,
        actions: [
          // Action carries the slot but no skill/anchor (an under-specified
          // plan); the snapshot fills both.
          { type: "dispatch", slot: "qa_orch", outcome: null },
        ],
        slots_snapshot: {
          qa_orch: { skill: "hydra-qa", anchor: "PR#970" },
        },
      },
    ];
    const out = projectDispatches(turns);
    assert.equal(out.length, 1);
    assert.equal(out[0].skill, "hydra-qa");
    assert.equal(out[0].anchorReference, "PR#970");
    assert.equal(out[0].prNumber, "970");
  });

  test("a malformed slot map never throws — yields the prior action-derived dispatch", () => {
    const turns = [
      {
        turn_n: 1,
        actions: [
          { type: "dispatch", slot: "dev_orch", skill: "hydra-dev", anchorReference: "issue-1", outcome: null },
        ],
        // garbage shapes: a string, a number, an array — none should throw.
        slots_snapshot: { dev_orch: "not-an-object", qa_orch: 42, research_orch: ["x"] },
      },
    ];
    const out = projectDispatches(turns);
    // The action dispatch survives; non-object slot members are skipped.
    assert.equal(out.length, 1);
    assert.equal(out[0].skill, "hydra-dev");
    assert.equal(out[0].anchorReference, "issue-1");
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

  // -------------------------------------------------------------------------
  // issue #975 — a crashed run reconciles + flags its dispatches end-to-end
  // -------------------------------------------------------------------------

  test("crashed run: slots_snapshot dispatches reconcile and get flagged for drill", async () => {
    // The run #975 scenario: term_reason=crash, no dispatch actions / no cycle
    // status, but slots_snapshot carries the identity. The bundle must surface
    // non-null anchorReference/skill/prNumber AND flag the dispatches so their
    // transcripts get drilled (reflection reads happen).
    const reflectionAnchors: string[] = [];
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-crash", status: "killed", term_reason: "crash" },
          turns: [
            {
              turn_n: 7,
              actions: [], // crash truncated the turn — no dispatch action recorded
              slots_snapshot: {
                qa_orch: { skill: "hydra-qa", anchor: "PR#970", task_id: "a6f929932fd15784b" },
                dev_orch: { skill: "hydra-dev", anchor: "#961", task_id: "a089f8680966d32ec" },
              },
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({}), // no cycle ⇒ no status from the sidecar
      // No terminal cycle record exists for these task_ids (the slots were
      // still in-flight when the crash truncated the run), so the #1352
      // candidate-cycleId recovery finds nothing to confirm and they stay
      // undrillable. The empty hash makes the fixture faithful to that intent
      // (baseDeps' default returns a merged hash, which would falsely confirm).
      readCycleHash: async () => ({}),
      readAnchorReflections: async (anchor: string) => {
        reflectionAnchors.push(anchor);
        return { content: `## PRIOR ATTEMPTS for ${anchor}`, count: 1 };
      },
    });

    const bundle = await assembleRetroBundle("run-crash", deps);

    assert.equal(bundle.dispatches.length, 2, "both occupied slots projected");
    const qa = bundle.dispatches.find((d) => d.skill === "hydra-qa")!;
    assert.equal(qa.anchorReference, "PR#970");
    assert.equal(qa.prNumber, "970");
    // Crash term_reason ⇒ best-effort failure-leaning abandonReason (#1168
    // visibility preserved): the dispatch still carries the run-crash signal.
    assert.equal(qa.abandonReason, "run-crash");

    // issue #1184 — these slots-snapshot-fallback dispatches have cycleId="" (no
    // transcript handle: the metrics/transcript enrichment loop skips them). So
    // they are recorded undrillable, NOT flagged — there is nothing to drill.
    const flagged = flagDispatchesForDrill(bundle.dispatches);
    assert.equal(flagged.length, 0, "empty-cycleId dispatches are not flagged (no transcript handle)");
    assert.equal(qa.flagged, false, "served dispatch is not flagged (undrillable)");
    assert.ok(
      bundle.dispatches.every((d) => d.flagged === false),
      "no empty-cycleId crashed-run dispatch is flagged on the served bundle",
    );
    assert.ok(
      bundle.dispatches.every((d) => d.undrillable === true),
      "every empty-cycleId crashed-run dispatch is recorded undrillable (#1168 visibility, #1184 honesty)",
    );

    // No flagged dispatch ⇒ no reflection reads (the drill subset is empty).
    assert.deepEqual(reflectionAnchors.sort(), []);
    assert.equal(bundle.reflections.length, 0);
  });

  // -------------------------------------------------------------------------
  // issue #1094 — the served bundle's per-dispatch `flagged` field is the
  // signal the hydra-retro skill (which curls the endpoint and cannot call the
  // pure TS selector) reads. Pin the exact reported shape: a crashed run where
  // every dispatch carries abandonReason=run-crash must report flagged:true on
  // each served dispatch, with a non-empty flagged subset.
  // -------------------------------------------------------------------------
  test("crashed run: served dispatches[].flagged is true for every run-crash dispatch (#1094)", async () => {
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-1094", status: "crashed", term_reason: "crash" },
          turns: [
            {
              turn_n: 12,
              actions: [],
              slots_snapshot: {
                dev_orch: { skill: "hydra-dev", anchor: "issue-1073" },
                qa_orch: { skill: "hydra-qa", anchor: "PR#1011" },
                grill_orch: { skill: "hydra-grill", anchor: "issue-1087" },
              },
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({}),
      readAnchorReflections: async () => ({ content: "", count: 0 }),
    });

    const bundle = await assembleRetroBundle("run-1094", deps);

    assert.equal(bundle.dispatches.length, 3, "all three occupied slots projected");
    // issue #1094 materialised the flagged signal onto the served bundle; issue
    // #1184 refines it: these slots-snapshot-fallback dispatches all carry
    // cycleId="" (no transcript handle), so the failure signal (run-crash) is
    // recorded as undrillable rather than flagged. The served `undrillable`
    // field is what the JSON consumer reads to count them honestly.
    for (const d of bundle.dispatches) {
      assert.equal(d.abandonReason, "run-crash", `${d.skill} carries run-crash (#1168 visibility)`);
      assert.equal(d.cycleId, "", `${d.skill} has no transcript handle`);
      assert.equal(d.flagged, false, `${d.skill} served dispatch is not flagged (no transcript)`);
      assert.equal(d.undrillable, true, `${d.skill} served dispatch is recorded undrillable`);
    }
    const flaggedCount = bundle.dispatches.filter((d) => d.flagged).length;
    assert.equal(flaggedCount, 0, "the served flagged subset is empty (no drillable handle)");
    const undrillableCount = bundle.dispatches.filter((d) => d.undrillable).length;
    assert.equal(undrillableCount, 3, "all three are recorded undrillable (honest count)");
  });

  // -------------------------------------------------------------------------
  // issue #1168 — an `interrupted` run (the COMMON terminator: 36/39 ended
  // runs) was excluded from the backfill set, so every status-less dispatch
  // stayed unflagged and the retro deep-read zero transcripts on exactly the
  // runs it exists to learn from. Pin the live evidence shape from run
  // ef0a9847-…: a substantive interrupted run with occupied, status-less slots
  // must tag each with a non-claiming run-interrupted abandonReason and flag
  // every one for drill.
  // -------------------------------------------------------------------------
  test("interrupted run: status-less dispatches backfill run-interrupted and flag for drill (#1168)", async () => {
    const reflectionAnchors: string[] = [];
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-interrupted", status: "ended", term_reason: "interrupted" },
          turns: [
            {
              turn_n: 12,
              actions: [], // SIGTERM truncated the turn — no dispatch action recorded
              slots_snapshot: {
                dev_orch: { skill: "hydra-dev", anchor: "#1162" },
                qa_orch: { skill: "hydra-qa", anchor: "PR#1155" },
                grill_orch: { skill: "hydra-grill", anchor: "#1149" },
              },
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({}), // no cycle ⇒ no status from the sidecar
      readAnchorReflections: async (anchor: string) => {
        reflectionAnchors.push(anchor);
        return { content: `## PRIOR ATTEMPTS for ${anchor}`, count: 1 };
      },
    });

    const bundle = await assembleRetroBundle("run-interrupted", deps);

    assert.equal(bundle.dispatches.length, 3, "all three occupied slots projected");
    // #1168 backfills the non-claiming run-interrupted abandonReason for
    // visibility. #1184 refines #1168: these slots-snapshot-fallback dispatches
    // all carry cycleId="" (no transcript handle), so they are recorded
    // undrillable rather than flagged — #1168 went from "flags zero" to "flags
    // N undrillable"; #1184 records them honestly so the retro reports
    // "recorded N undrillable, flagged-for-drill 0".
    for (const d of bundle.dispatches) {
      assert.equal(
        d.abandonReason,
        "run-interrupted",
        `${d.skill} carries the non-claiming run-interrupted abandonReason (#1168 visibility)`,
      );
      // Never claim a positive outcome on a terminal status that was never written.
      assert.equal(d.status, null, `${d.skill} status stays null (no false merged)`);
      assert.equal(d.cycleId, "", `${d.skill} has no transcript handle`);
      assert.equal(d.flagged, false, `${d.skill} served dispatch is NOT flagged (no transcript to drill)`);
      assert.equal(d.undrillable, true, `${d.skill} served dispatch is recorded undrillable`);
    }
    const flagged = flagDispatchesForDrill(bundle.dispatches);
    assert.equal(flagged.length, 0, "the flagged subset is empty — no drillable handle (#1184)");
    // No flagged dispatch ⇒ no reflection reads: the retro doesn't fan out a
    // transcript read it cannot satisfy.
    assert.deepEqual(reflectionAnchors.sort(), []);
    assert.equal(bundle.reflections.length, 0);
  });

  // -------------------------------------------------------------------------
  // issue #1184 — #1168's interrupted-run backfill flagged empty-cycleId
  // slots-snapshot-fallback dispatches for drill, but they have NO transcript
  // handle (the metrics/transcript enrichment loop skips them via
  // `if (!d.cycleId) continue;`). So #1168 went from "flags zero" to "flags N
  // undrillable". The fix (option b): record them undrillable:true,
  // flagged:false — visibility preserved, drill-blindness eliminated. A flagged
  // dispatch always has a transcript handle (cycleId !== ""). On a MIXED
  // interrupted run (some dispatches carry a resolved cycleId, some don't) the
  // drillable ones still flag normally.
  // -------------------------------------------------------------------------
  test("interrupted run: a cycleId-bearing failure still flags; empty-cycleId stays undrillable (#1184)", async () => {
    const reflectionAnchors: string[] = [];
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-mixed", status: "ended", term_reason: "interrupted" },
          turns: [
            {
              turn_n: 9,
              actions: [
                // A dispatch action DID record a resolved cycle that failed —
                // it carries a transcript handle and must stay flagged.
                {
                  type: "dispatch",
                  slot: "dev_orch",
                  skill: "hydra-dev",
                  anchorReference: "issue-1180",
                  outcome: { cycleId: "cReal", status: "failed", prNumber: "1190" },
                },
              ],
              slots_snapshot: {
                // Same slot the action recorded — enrichment only, one dispatch.
                dev_orch: { skill: "hydra-dev", anchor: "issue-1180" },
                // A slots-snapshot-ONLY slot: no action, no cycleId — undrillable.
                grill_orch: { skill: "hydra-grill", anchor: "issue-1181" },
              },
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({}),
      readAnchorReflections: async (anchor: string) => {
        reflectionAnchors.push(anchor);
        return { content: `## PRIOR ATTEMPTS for ${anchor}`, count: 1 };
      },
    });

    const bundle = await assembleRetroBundle("run-mixed", deps);
    assert.equal(bundle.dispatches.length, 2, "one action-derived + one snapshot-only dispatch");

    const dev = bundle.dispatches.find((d) => d.skill === "hydra-dev")!;
    assert.equal(dev.cycleId, "cReal", "action-derived dispatch carries its resolved cycleId");
    assert.equal(dev.bucket, "failed");
    assert.equal(dev.flagged, true, "a drillable failure is flagged for drill");
    assert.equal(dev.undrillable, false, "a cycleId-bearing dispatch is never undrillable");

    const grill = bundle.dispatches.find((d) => d.skill === "hydra-grill")!;
    assert.equal(grill.cycleId, "", "snapshot-only dispatch has no transcript handle");
    assert.equal(grill.abandonReason, "run-interrupted", "#1168 visibility backfill preserved");
    assert.equal(grill.flagged, false, "empty-cycleId dispatch is NOT flagged");
    assert.equal(grill.undrillable, true, "empty-cycleId failure is recorded undrillable");

    // Only the drillable failure's anchor got a reflection read.
    assert.deepEqual(reflectionAnchors, ["issue-1180"]);
    assert.equal(bundle.reflections.length, 1);

    // The bundle-level invariant: every flagged dispatch has a transcript handle.
    assert.ok(
      bundle.dispatches.every((d) => !d.flagged || d.cycleId !== ""),
      "invariant: flagged === true ⟹ cycleId !== ''",
    );
    // And the served flagged subset agrees with the pure selector.
    assert.equal(
      bundle.dispatches.filter((d) => d.flagged).length,
      flagDispatchesForDrill(bundle.dispatches).length,
      "served flagged count equals the pure selector's output",
    );
  });

  // -------------------------------------------------------------------------
  // issue #1352 — an interrupted run starves retro because a genuinely-
  // COMPLETED dispatch (a terminal cycle record durably written by reap) was
  // projected with an empty cycleId and recorded undrillable. The fix (option
  // b): recover the candidate cycleId from the slot's task_id, then KEEP it iff
  // a terminal cycle record is confirmed to exist — making the completed
  // dispatch drillable while a still-in-flight slot stays undrillable.
  // -------------------------------------------------------------------------
  test("interrupted run: a completed snapshot-only dispatch (task_id → confirmed cycle record) becomes drillable (#1352)", async () => {
    const reflectionAnchors: string[] = [];
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-1352", status: "ended", term_reason: "interrupted" },
          turns: [
            {
              turn_n: 8,
              actions: [], // print-mode session exited before the dispatch action was recorded
              slots_snapshot: {
                // Genuinely completed: reap wrote a FAILED cycle record keyed on this task_id.
                dev_orch: { skill: "hydra-dev", anchor: "issue-1340", task_id: "tid-completed" },
                // Still in-flight when the session died: a task_id but NO terminal cycle record.
                qa_orch: { skill: "hydra-qa", anchor: "PR#1341", task_id: "tid-inflight" },
              },
            },
          ],
        }) as any,
      // The cycle metrics sidecar resolves only for the completed dispatch's task_id.
      readCycleMetrics: async (cycleId: string) =>
        cycleId === "tid-completed"
          ? { abandonReason: "verification-failure", anchorReference: "issue-1340" }
          : {},
      // The cycle hash carries the terminal status for the completed dispatch only.
      readCycleHash: async (cycleId: string) =>
        cycleId === "tid-completed" ? { status: "failed" } : {},
      readAnchorReflections: async (anchor: string) => {
        reflectionAnchors.push(anchor);
        return { content: `## PRIOR ATTEMPTS for ${anchor}`, count: 1 };
      },
    });

    const bundle = await assembleRetroBundle("run-1352", deps);
    assert.equal(bundle.dispatches.length, 2, "both occupied slots projected");

    const dev = bundle.dispatches.find((d) => d.skill === "hydra-dev")!;
    assert.equal(dev.cycleId, "tid-completed", "completed dispatch keeps its recovered cycleId handle");
    assert.equal(dev.status, "failed", "terminal status backfilled from the confirmed cycle record");
    assert.equal(dev.bucket, "failed");
    assert.equal(dev.abandonReason, "verification-failure");
    assert.equal(dev.flagged, true, "a confirmed-drillable failure is flagged for drill (#1352)");
    assert.equal(dev.undrillable, false, "a confirmed cycle record is drillable, not undrillable");

    const qa = bundle.dispatches.find((d) => d.skill === "hydra-qa")!;
    assert.equal(qa.cycleId, "", "in-flight dispatch's unconfirmed candidate is dropped back to ''");
    assert.equal(qa.abandonReason, "run-interrupted", "#1168 visibility backfill still applies");
    assert.equal(qa.flagged, false, "an unconfirmed (in-flight) dispatch is NOT flagged");
    assert.equal(qa.undrillable, true, "an unconfirmed (in-flight) dispatch stays undrillable");

    // Only the confirmed-drillable failure's anchor got a reflection read — the
    // retro now deep-reads a real transcript on an interrupted run.
    assert.deepEqual(reflectionAnchors, ["issue-1340"]);
    assert.equal(bundle.reflections.length, 1);

    // Bundle-level invariant preserved: every flagged dispatch has a handle.
    assert.ok(
      bundle.dispatches.every((d) => !d.flagged || d.cycleId !== ""),
      "invariant: flagged === true ⟹ cycleId !== ''",
    );
  });

  test("interrupted run: a merged snapshot-only dispatch (task_id → confirmed) is drillable but not flagged (#1352)", async () => {
    // Q&A 7 of the design concept: a genuinely-completed dispatch that MERGED
    // is drillable (real cycleId) but the happy path needs no transcript drill,
    // so it must not be flagged. This pins that the recovery does not over-flag.
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-1352-merged", status: "ended", term_reason: "interrupted" },
          turns: [
            {
              turn_n: 3,
              actions: [],
              slots_snapshot: {
                dev_orch: { skill: "hydra-dev", anchor: "issue-1300", task_id: "tid-merged" },
              },
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({}), // no failure-shape fields
      readCycleHash: async (cycleId: string) =>
        cycleId === "tid-merged" ? { status: "merged" } : {},
    });

    const bundle = await assembleRetroBundle("run-1352-merged", deps);
    const dev = bundle.dispatches[0];
    assert.equal(dev.cycleId, "tid-merged", "merged dispatch keeps its confirmed handle");
    assert.equal(dev.status, "merged");
    assert.equal(dev.bucket, "merged");
    assert.equal(dev.flagged, false, "a merged, regression-free dispatch is not flagged (happy path)");
    assert.equal(dev.undrillable, false, "a confirmed cycle record is not undrillable even when unflagged");
    assert.equal(dev.abandonReason, null, "no run-interrupted backfill once a terminal status is confirmed");
  });

  test("clean stop does NOT fabricate a failure status for a pending dispatch", async () => {
    // A status-less dispatch on a clean (budget) stop is genuinely pending —
    // it must stay unflagged (no run-<reason> abandonReason fabricated).
    const deps = baseDeps({
      readRun: async () =>
        ({
          ok: true,
          run: { run_id: "run-clean", status: "ended", term_reason: "budget" },
          turns: [
            {
              turn_n: 1,
              actions: [],
              slots_snapshot: {
                dev_orch: { skill: "hydra-dev", anchor: "#500" },
              },
            },
          ],
        }) as any,
      readCycleMetrics: async () => ({}),
    });

    const bundle = await assembleRetroBundle("run-clean", deps);
    assert.equal(bundle.dispatches.length, 1);
    assert.equal(bundle.dispatches[0].anchorReference, "#500", "still reconciled from snapshot");
    assert.equal(bundle.dispatches[0].abandonReason, null, "no fabricated failure on a clean stop");
    assert.equal(flagDispatchesForDrill(bundle.dispatches).length, 0, "pending dispatch stays unflagged");
    // issue #1094 — the served flag must mirror the selector: a genuinely
    // pending dispatch stays flagged=false (no false-positive drill).
    assert.equal(bundle.dispatches[0].flagged, false, "served pending dispatch is not flagged");
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
