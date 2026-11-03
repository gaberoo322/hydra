/**
 * Review-findings retro mode (issue #5271, R2): the pure `review_retro_due`
 * planner in src/retro-inputs.ts and its decide.py wiring on `retro_orch`.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  capReviewRetroEmits,
  nextReviewRung,
  planReviewRetro,
  REVIEW_RETRO_MAX_ISSUES,
  REVIEW_RETRO_MAX_PRS,
  type ReviewRetroPriorEmit,
  type ReviewRetroTrip,
} from "../src/retro-inputs.ts";
import { withTurnSnapshot } from "./_helpers/turn-snapshot-state.mts";

const NOW = Date.parse("2026-11-01T00:00:00Z");
const AT = "2026-10-25T00:00:00Z";

function finding(pr: number, round: number, rule: string, file: string): unknown {
  return {
    kind: "finding",
    pr,
    round,
    sha: "abc",
    at: AT,
    source: "route",
    severity: "medium",
    axis: "standards",
    location: `${file}:1`,
    file,
    rule,
    finding: `${rule} violated`,
    reviewers: ["a"],
  };
}

/** A rule seen on three distinct PRs trips the rule-cross-pr arm. */
const threePrs = [10, 11, 12].map((pr) => finding(pr, 1, "STD-X", `src/f${pr}.ts`));

describe("planReviewRetro (review_retro_due derives from rows only)", () => {
  test("no rows: not due", () => {
    assert.equal(planReviewRetro([], [], { now: NOW }).due, false);
  });

  test("a rule on 3 distinct PRs is due, first emit is the check rung", () => {
    const plan = planReviewRetro(threePrs, [], { now: NOW });
    assert.equal(plan.due, true);
    assert.deepEqual(plan.trips, [{ armKey: "rule-cross-pr:STD-X", arm: "rule-cross-pr", rung: "check" }]);
  });

  test("re-trip only after the prior emit closes, one rung up", () => {
    const open: ReviewRetroPriorEmit[] = [{ armKey: "rule-cross-pr:STD-X", rung: "check", open: true }];
    assert.equal(planReviewRetro(threePrs, open, { now: NOW }).due, false);
    const closed = [{ ...open[0]!, open: false }];
    const plan = planReviewRetro(threePrs, closed, { now: NOW });
    assert.equal(plan.trips[0]?.rung, "standard");
  });

  test("ladder climbs check, standard, fence, then is exhausted", () => {
    const k = "k";
    const closed = (rung: "check" | "standard" | "fence"): ReviewRetroPriorEmit => ({ armKey: k, rung, open: false });
    assert.equal(nextReviewRung([], k), "check");
    assert.equal(nextReviewRung([closed("check")], k), "standard");
    assert.equal(nextReviewRung([closed("check"), closed("standard")], k), "fence");
    assert.equal(nextReviewRung([closed("fence")], k), null);
  });
});

describe("capReviewRetroEmits (2 issues, 1 PR)", () => {
  const trip = (n: number, rung: ReviewRetroTrip["rung"]): ReviewRetroTrip => ({
    armKey: `k${n}`,
    arm: "rule-cross-pr",
    rung,
  });

  test("caps are 2 issues and 1 PR", () => {
    assert.equal(REVIEW_RETRO_MAX_ISSUES, 2);
    assert.equal(REVIEW_RETRO_MAX_PRS, 1);
    const out = capReviewRetroEmits([
      trip(1, "check"),
      trip(2, "check"),
      trip(3, "check"),
      trip(4, "standard"),
      trip(5, "fence"),
    ]);
    assert.equal(out.issues.length, 2);
    assert.equal(out.pr?.armKey, "k4");
    assert.deepEqual(out.deferred.map((t) => t.armKey), ["k3", "k5"]);
  });
});

describe("decide.py: review_retro_due rides retro_orch (no new class)", () => {
  const DECIDE = join(resolve(import.meta.dirname, ".."), "scripts", "autopilot", "decide.py");

  function runDecide(signals: Record<string, unknown>): any {
    const dir = mkdtempSync(join(tmpdir(), "review-retro-due-"));
    try {
      const state = {
        started_epoch: Math.floor(Date.now() / 1000),
        limits: { token_budget: 2_000_000, wall_clock_max_sec: 28_800, idle_drain_turns: 5, scope: "all" },
        cumulative_tokens: 0,
        dispatches: 0,
        idle_turns: 0,
        turn: 0,
        burned_classes: [],
        reaped_task_ids: [],
        failure_log: [],
        slots: {
          dev_orch: null,
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
          design_concept_orch: null,
        },
        signal_last_fired: { health: 0, sweep_orch: 0, sweep_target: 0, discover_orch: 0, discover_target: 0 },
        signals,
        research_force_counter: {},
      };
      writeFileSync(join(dir, "s.json"), JSON.stringify(withTurnSnapshot(state)));
      writeFileSync(join(dir, "c.json"), "null");
      writeFileSync(join(dir, "e.json"), "[]");
      const r = spawnSync("python3", [DECIDE, "decide", join(dir, "s.json"), join(dir, "c.json"), join(dir, "e.json")], {
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const retro = (plan: any) => (plan.actions ?? []).find((a: any) => a.type === "dispatch" && a.slot === "retro_orch");

  test("review_retro_due alone dispatches a review-mode hydra-retro with apply", () => {
    const a = retro(runDecide({ review_retro_due: true }));
    assert.ok(a, "retro_orch must dispatch on review_retro_due");
    assert.equal(a.skill, "hydra-retro");
    assert.equal(a.prompt_args.mode, "review");
    assert.equal(a.prompt_args.apply, true);
  });

  test("review_retro_due plus a drillable run stamps review:true on the one dispatch", () => {
    const a = retro(runDecide({ review_retro_due: true, retro_run_available: true, retro_run_drillable: true }));
    assert.ok(a);
    assert.equal(a.prompt_args.review, true);
    assert.equal(a.prompt_args.apply, true);
  });

  test("no review signal: plain retro dispatch is unchanged", () => {
    const a = retro(runDecide({ retro_run_available: true, retro_run_drillable: true }));
    assert.ok(a);
    assert.equal(a.prompt_args.review, undefined);
    assert.equal(a.prompt_args.mode, undefined);
  });
});
