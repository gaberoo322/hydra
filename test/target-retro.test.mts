/**
 * Regression tests for the pure Target-retro caps / dedup / routing core
 * (issue #1058, parent epic #1052).
 *
 * Pins the contract the `/hydra-target-retro` skill depends on: surviving
 * observations are deduped against the seen-list, then fill a SINGLE shared
 * ≤2 proposal budget across both lanes (feedback-file instructions + Redis
 * backlog items), with the overflow recorded artifact-only (never silently
 * dropped). Subagent friction reports are a first-class input folded into the
 * same observation list, competing on the same cue key — there is NO separate
 * friction mechanism and NO gated-PR lane (the Target does not mirror the
 * Modification-Tier machinery).
 *
 * Pure tests — no Redis, no network, no spawn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROPOSALS_PER_RUN,
  parseArgs,
  planTargetRetro,
  validateObservations,
  type RetroObservation,
} from "../scripts/target/target-retro.ts";

const emptyLedger = () => ({ seenCues: new Set<string>() });

const obs = (
  cue: string,
  lane: "feedback" | "backlog",
  source: "transcript" | "friction" = "transcript",
): RetroObservation => ({ cue, lane, title: `fix ${cue}`, source });

describe("planTargetRetro — routing + shared cap", () => {
  test("routes feedback and backlog observations to their lanes", () => {
    const plan = planTargetRetro(
      [obs("a-cue", "feedback"), obs("b-cue", "backlog")],
      emptyLedger(),
    );
    assert.equal(plan.feedback.length, 1);
    assert.equal(plan.feedback[0].cue, "a-cue");
    assert.equal(plan.backlog.length, 1);
    assert.equal(plan.backlog[0].cue, "b-cue");
    assert.deepEqual(plan.artifactOnly, []);
    assert.deepEqual(plan.skipped, []);
  });

  test("cap is shared across BOTH lanes, not per-lane", () => {
    // 2 feedback + 2 backlog = 4 candidates; only 2 may emit total.
    const plan = planTargetRetro(
      [
        obs("f1", "feedback"),
        obs("f2", "feedback"),
        obs("b1", "backlog"),
        obs("b2", "backlog"),
      ],
      emptyLedger(),
    );
    const totalEmitted = plan.feedback.length + plan.backlog.length;
    assert.equal(totalEmitted, MAX_PROPOSALS_PER_RUN);
    // Input order fills the budget: f1, f2 take both slots.
    assert.deepEqual(plan.feedback.map((p) => p.cue), ["f1", "f2"]);
    assert.deepEqual(plan.backlog, []);
    // The overflow is artifact-only, not dropped.
    assert.deepEqual(
      plan.artifactOnly.map((s) => ({ cue: s.cue, reason: s.reason })),
      [
        { cue: "b1", reason: "proposal-cap-reached" },
        { cue: "b2", reason: "proposal-cap-reached" },
      ],
    );
  });

  test("input order determines which lane wins the shared budget", () => {
    const plan = planTargetRetro(
      [obs("b1", "backlog"), obs("f1", "feedback"), obs("b2", "backlog")],
      emptyLedger(),
    );
    assert.deepEqual(plan.backlog.map((p) => p.cue), ["b1"]);
    assert.deepEqual(plan.feedback.map((p) => p.cue), ["f1"]);
    assert.deepEqual(plan.artifactOnly.map((s) => s.cue), ["b2"]);
  });

  test("friction-sourced observations compete identically (no priority)", () => {
    const plan = planTargetRetro(
      [obs("fric", "feedback", "friction"), obs("trans", "backlog", "transcript")],
      emptyLedger(),
    );
    assert.equal(plan.feedback[0].source, "friction");
    assert.equal(plan.backlog[0].source, "transcript");
  });
});

describe("planTargetRetro — dedup against the seen-list", () => {
  test("a seen cue is hard-skipped regardless of lane", () => {
    const ledger = { seenCues: new Set(["a-cue"]) };
    const plan = planTargetRetro([obs("a-cue", "feedback"), obs("b-cue", "backlog")], ledger);
    assert.deepEqual(plan.feedback, []);
    assert.equal(plan.backlog.length, 1);
    assert.equal(plan.backlog[0].cue, "b-cue");
    assert.deepEqual(
      plan.skipped.map((s) => ({ cue: s.cue, reason: s.reason })),
      [{ cue: "a-cue", reason: "duplicate-seen-list" }],
    );
  });

  test("a deduped finding does NOT consume the proposal budget", () => {
    // a-cue is seen → skipped, leaving the full ≤2 budget for the rest.
    const ledger = { seenCues: new Set(["a-cue"]) };
    const plan = planTargetRetro(
      [obs("a-cue", "feedback"), obs("b-cue", "backlog"), obs("c-cue", "feedback")],
      ledger,
    );
    assert.equal(plan.backlog.length + plan.feedback.length, 2);
    assert.deepEqual(plan.artifactOnly, []);
  });

  test("empty observation list yields an empty plan", () => {
    const plan = planTargetRetro([], emptyLedger());
    assert.deepEqual(plan, { feedback: [], backlog: [], artifactOnly: [], skipped: [] });
  });
});

describe("validateObservations", () => {
  test("valid observations produce no errors", () => {
    assert.deepEqual(
      validateObservations([obs("good-cue", "feedback"), obs("other-cue", "backlog", "friction")]),
      [],
    );
  });

  test("non-array input is a hard stop", () => {
    // @ts-expect-error — exercising the runtime guard.
    const errors = validateObservations("nope");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, "observations");
  });

  test("rejects non-kebab cue, bad lane, bad source, empty title", () => {
    const bad: RetroObservation[] = [
      { cue: "Not Kebab", lane: "feedback", title: "t", source: "transcript" },
      // @ts-expect-error — exercising the runtime lane guard.
      { cue: "ok-cue", lane: "pr", title: "t", source: "transcript" },
      // @ts-expect-error — exercising the runtime source guard.
      { cue: "ok-cue2", lane: "backlog", title: "t", source: "guess" },
      { cue: "ok-cue3", lane: "backlog", title: "  ", source: "friction" },
    ];
    const errors = validateObservations(bad);
    assert.ok(errors.some((e) => e.index === 0 && e.field === "cue"));
    assert.ok(errors.some((e) => e.index === 1 && e.field === "lane"));
    assert.ok(errors.some((e) => e.index === 2 && e.field === "source"));
    assert.ok(errors.some((e) => e.index === 3 && e.field === "title"));
  });
});

describe("parseArgs — audit is the default", () => {
  test("no args ⇒ apply:false, no runId key", () => {
    assert.deepEqual(parseArgs(""), { apply: false });
    assert.deepEqual(parseArgs(null), { apply: false });
    assert.deepEqual(parseArgs(undefined), { apply: false });
  });

  test("--apply opts in to mutation", () => {
    assert.deepEqual(parseArgs("--apply"), { apply: true });
  });

  test("positional run id is captured; --audit forces dry-run", () => {
    assert.deepEqual(parseArgs("run-123"), { apply: false, runId: "run-123" });
    assert.deepEqual(parseArgs("run-123 --apply"), { apply: true, runId: "run-123" });
    assert.deepEqual(parseArgs("run-123 --audit"), { apply: false, runId: "run-123" });
  });

  test("unknown flags are ignored, not misparsed as the run id", () => {
    assert.deepEqual(parseArgs("--frobnicate run-9"), { apply: false, runId: "run-9" });
  });
});
