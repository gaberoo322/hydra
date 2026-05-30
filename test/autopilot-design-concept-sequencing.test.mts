/**
 * Regression tests for `scripts/autopilot/decide.py` design-concept
 * sequencing (issue #466 — Phase B of #437).
 *
 * Phase B contract — warn-only:
 *
 *   - When the best `/api/anchor/candidates` entry carries a
 *     `designConcept` block AND that block reports the artifact is
 *     missing or stale, decide.py MUST emit a `dispatch:design_concept_orch`
 *     using the `hydra-grill` skill, and MUST suppress any
 *     `dispatch:dev_orch` for the same turn. Both gates require the
 *     `orch_work_available` signal.
 *
 *   - When the block reports a fresh artifact (even draft / warn-only —
 *     `present:true && isFresh:true`, regardless of `gateOk`), decide.py
 *     MUST emit `dispatch:dev_orch` normally and MUST NOT re-grill.
 *     Phase B's warn-only semantics intentionally treat a `gateOk:false`
 *     artifact as fresh; Phase C will flip to require `gateOk:true`.
 *
 *   - When no candidate carries a `designConcept` block at all (e.g.
 *     before the candidates API is extended in a follow-up sub-issue),
 *     Phase B is a no-op: `dev_orch` proceeds as before, the
 *     `design_concept_orch` selector returns None.
 *
 * ISSUE #751 — legacy fallback removed:
 *
 *   - The original Phase B fallback read `best` from
 *     `/api/anchor/candidates` and grilled it when its `designConcept`
 *     block was missing/stale. Post-#458 that feed is structurally
 *     target-product work (item-<N>), so under orch scope the fallback
 *     could only misfire — grilling a target candidate as an orch design
 *     concept. It has been removed. `state.signals.orch_pending_grill_anchor`
 *     (set by collect-state.sh scanning the orch GH board) is now the
 *     SINGLE source of truth for orch grill anchors. When that signal is
 *     absent or "none", `design_concept_orch` returns None and dev_orch
 *     proceeds — regardless of any candidate's designConcept block.
 *
 * Counters consumed by the future B-4 dashboard are written elsewhere
 * (saveDesignConcept in src/design-concept.ts; reap.py for grill
 * timeout/crash) — those have their own unit tests.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const DECIDE = join(SCRIPTS, "decide.py");

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dc-seq-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

function baseState(signals: Record<string, unknown> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
    },
    signals,
  };
}

function runDecide(state: any, candidates: any | null, events: any[] = []): any {
  const tmp = makeTmp();
  try {
    writeFileSync(tmp.state, JSON.stringify(state));
    writeFileSync(tmp.cands, JSON.stringify(candidates ?? { candidates: [], research_recommended: false }));
    writeFileSync(tmp.events, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", tmp.state, tmp.cands, tmp.events], { encoding: "utf-8" });
    assert.equal(r.status, 0, `decide.py exited non-zero: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

describe("decide.py — design_concept_orch sequencing (issue #466, Phase B)", () => {
  // ISSUE #751: the legacy `best.designConcept` fallback was REMOVED.
  // It read `best` from /api/anchor/candidates, which post-#458 is
  // structurally target-product work, so under orch scope it could only
  // ever misfire — grilling a target candidate as an orch design concept.
  // The pre-#751 tests below used orch-shaped anchorRefs ("issue-NNN") and
  // so asserted the buggy path fired; they now assert it does NOT.
  test("does NOT grill via legacy best.designConcept path when artifact missing (#751)", () => {
    const state = baseState({ orch_work_available: true });
    const cands = {
      candidates: [
        {
          issue: 999,
          anchorRef: "issue-999",
          score: 0.85,
          designConcept: { present: false, isFresh: false, status: null, gateOk: false },
        },
      ],
      research_recommended: false,
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined,
      "legacy best.designConcept fallback removed (#751): no grill without an orch_pending_grill_anchor signal");
    assert.ok(dev,
      "dev_orch must proceed when no orch grill is pending");
  });

  test("does NOT grill via legacy path when artifact is stale (#751)", () => {
    const state = baseState({ orch_work_available: true });
    const cands = {
      candidates: [
        {
          anchorRef: "issue-stale",
          score: 0.75,
          designConcept: { present: true, isFresh: false, status: "stale", gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined,
      "stale best.designConcept must NOT trigger a grill after the #751 fallback removal");
    assert.ok(dev, "dev_orch proceeds");
  });

  test("dispatches dev_orch (not grill) when artifact is fresh AND approved", () => {
    const state = baseState({ orch_work_available: true });
    const cands = {
      candidates: [
        {
          anchorRef: "issue-fresh-approved",
          score: 0.85,
          designConcept: { present: true, isFresh: true, status: "approved", gateOk: true },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined, "fresh approved artifact must not re-grill");
    assert.ok(dev, "dev_orch should dispatch when a fresh approved artifact exists");
  });

  test("warn-only: dispatches dev_orch even when artifact gateOk:false (Phase B)", () => {
    // Phase B intentionally treats a draft / warn-only artifact (gateOk:false
    // but present + fresh) as "fresh present". Phase C will flip this to
    // require gateOk:true.
    const state = baseState({ orch_work_available: true });
    const cands = {
      candidates: [
        {
          anchorRef: "issue-warn-only",
          score: 0.85,
          designConcept: { present: true, isFresh: true, status: "draft", gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined,
      "Phase B warn-only: a fresh draft artifact must NOT re-grill");
    assert.ok(dev,
      "Phase B warn-only: dev_orch proceeds even when gateOk:false (the handoff was filed by hydra-grill)");
  });

  test("legacy candidates without designConcept field are no-ops (additive Phase B)", () => {
    // Before the candidates API is extended to surface artifact metadata,
    // Phase B must remain a no-op so this PR can land independently.
    const state = baseState({ orch_work_available: true });
    const cands = {
      candidates: [{ anchorRef: "issue-legacy", score: 0.85 }],  // no designConcept block
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined,
      "missing designConcept block must NOT trigger a grill (no signal to act on)");
    assert.ok(dev,
      "dev_orch must proceed when designConcept block is absent (legacy candidates path)");
  });

  test("does NOT fire grill when orch_work_available is absent (gating signal missing)", () => {
    // No orch_work_available signal — nothing for hydra-dev to pick up,
    // so there's no point in grilling either.
    const state = baseState();  // no signals
    const cands = {
      candidates: [
        {
          anchorRef: "issue-no-signal",
          score: 0.85,
          designConcept: { present: false, isFresh: false, status: null, gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.equal(grill, undefined,
      "design_concept_orch must require the same orch_work_available signal as dev_orch");
  });

  test("does NOT fire grill when slot is busy (INV-002)", () => {
    const state = baseState({ orch_work_available: true });
    state.slots.design_concept_orch = { skill: "hydra-grill", started: "t0", partial_tokens: 1000 };
    const cands = {
      candidates: [
        {
          anchorRef: "issue-busy-slot",
          score: 0.85,
          designConcept: { present: false, isFresh: false, status: null, gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.equal(grill, undefined, "busy slot must not receive a new dispatch");
  });

  test("scope=target-only excludes design_concept_orch (orch-scope class)", () => {
    const state = baseState({ orch_work_available: true });
    state.limits.scope = "target-only";
    const cands = {
      candidates: [
        {
          anchorRef: "issue-scope",
          score: 0.85,
          designConcept: { present: false, isFresh: false, status: null, gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.equal(grill, undefined,
      "design_concept_orch is orch-scope; target-only scope must exclude it");
  });
});

describe("decide.py — pipeline_slots contract includes design_concept_orch (#466)", () => {
  test("smoke catalog mentions design_concept_orch", () => {
    const r = spawnSync("python3", [DECIDE, "smoke"], { encoding: "utf-8" });
    assert.equal(r.status, 0, `decide.py smoke failed: ${r.stderr}`);
    assert.match(r.stdout, /design_concept_orch/,
      "smoke catalog must list design_concept_orch as a pipeline slot");
  });
});

describe("decide.py — orch_pending_grill_anchor signal path (issue #628)", () => {
  test("dispatches hydra-grill on the named anchor when signal is set", () => {
    // The new orch-scope signal path: collect-state.sh emits the first
    // orch-board ready-for-agent issue that lacks a fresh DC artifact,
    // and decide.py grills it directly. This is the path that lets the
    // gate fire on real orch work post-#458; pre-#628 it never could.
    const state = baseState({
      orch_work_available: true,
      orch_pending_grill_anchor: "issue-628",
    });
    const cands = { candidates: [] }; // intentionally empty — signal alone must suffice
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.ok(grill, "orch_pending_grill_anchor signal must trigger a grill dispatch");
    assert.equal(grill.skill, "hydra-grill");
    assert.equal(grill.prompt_args.scope, "orch");
    assert.equal(grill.prompt_args.anchor, "issue-628");
  });

  test("dev_orch yields the same turn the grill fires (sequencing rule)", () => {
    // INV: design_concept_orch and dev_orch must not co-fire on the
    // same anchor. The signal path must enforce this exactly the way
    // the legacy `best.designConcept` path does.
    const state = baseState({
      orch_work_available: true,
      orch_pending_grill_anchor: "issue-628",
    });
    const cands = { candidates: [] };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(grill, "grill should dispatch");
    assert.equal(dev, undefined,
      "dev_orch must NOT co-fire when orch_pending_grill_anchor is set");
  });

  test("signal=\"none\" is treated as absent (no grill, dev_orch proceeds)", () => {
    // collect-state.sh emits the literal string "none" when no orch
    // anchor needs grilling. decide.py MUST treat this as "no signal".
    const state = baseState({
      orch_work_available: true,
      orch_pending_grill_anchor: "none",
    });
    const cands = { candidates: [{ anchorRef: "item-target", score: 0.9 }] };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined, "\"none\" must NOT trigger a grill");
    assert.ok(dev, "dev_orch must proceed when no grill is pending");
  });

  test("signal absent → NO grill (legacy best.designConcept fallback removed, #751)", () => {
    // ISSUE #751: the legacy best.designConcept fallback was removed.
    // orch_pending_grill_anchor is now the SINGLE source of truth for
    // orch grill anchors. When the signal is absent, design_concept_orch
    // returns None (no grill) and dev_orch proceeds — even when the best
    // candidate carries a missing/stale designConcept block (that block
    // describes target-product work, never an orch-scope grill anchor).
    const state = baseState({ orch_work_available: true });
    const cands = {
      candidates: [
        {
          anchorRef: "issue-fallback",
          score: 0.85,
          designConcept: { present: false, isFresh: false, status: null, gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined,
      "missing orch_pending_grill_anchor signal → no grill (legacy path removed in #751)");
    assert.ok(dev, "dev_orch proceeds when no orch grill is pending");
  });

  test("orch_work_available absent → no grill even when signal points to an anchor", () => {
    // The orch_work_available gate is sacred — if the orch board is
    // empty there's no point grilling for downstream dev_orch work
    // that won't happen anyway.
    const state = baseState({ orch_pending_grill_anchor: "issue-999" });
    const cands = { candidates: [] };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.equal(grill, undefined,
      "orch_pending_grill_anchor requires orch_work_available to fire");
  });

  test("scope=target-only still excludes design_concept_orch (orch-scope class)", () => {
    // The new signal path must not bypass the scope filter.
    const state = baseState({
      orch_work_available: true,
      orch_pending_grill_anchor: "issue-628",
    });
    state.limits.scope = "target-only";
    const cands = { candidates: [] };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.equal(grill, undefined,
      "design_concept_orch is orch-scope; target-only scope must exclude it");
  });
});

describe("decide.py — design_concept_orch never grills a target candidate under orch scope (issue #751)", () => {
  // The exact repro from issue #751: orch_pending_grill_anchor is UNSET,
  // and /api/anchor/candidates carries a target-shaped best candidate
  // (item-<N>, a hydra-betting feature) with a missing/stale designConcept
  // block. Pre-#751, the legacy fallback grabbed that target candidate and
  // dispatched hydra-grill with scope=orch + anchor=<target feature title>,
  // wasting a subagent and persisting a cross-scope artifact. The fix
  // removes the fallback: no orch grill fires, and dev_orch proceeds.
  test("target-shaped best candidate (item-<N>) + missing artifact → NO orch grill", () => {
    const state = baseState({ orch_work_available: true });
    // orch_pending_grill_anchor intentionally UNSET.
    const cands = {
      candidates: [
        {
          issue: "item-313",
          anchorRef: "Add distributed execution-pair-lock via pg_advisory_lock or Redis SETNX",
          score: 0.85,
          designConcept: { present: false, isFresh: false, status: null, gateOk: false },
        },
      ],
      research_recommended: false,
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    assert.equal(grill, undefined,
      "design_concept_orch must NOT grill a target-side candidate under orch scope (#751 repro)");
    // Belt-and-braces: even if some future dispatch were emitted, its anchor
    // must never be the target feature string.
    const anyTargetAnchorGrill = findAction(
      plan,
      (a) =>
        a.type === "dispatch" &&
        a.slot === "design_concept_orch" &&
        a.prompt_args?.anchor ===
          "Add distributed execution-pair-lock via pg_advisory_lock or Redis SETNX",
    );
    assert.equal(anyTargetAnchorGrill, undefined,
      "no orch grill may carry a target candidate string as its anchor");
  });

  test("target-shaped best candidate + 'none' signal → NO orch grill, dev_orch proceeds", () => {
    // collect-state.sh emits the literal "none" when the orch board has no
    // grill-pending anchor. Combined with a target best candidate, this is
    // the steady-state repro: must be a no-op for the grill, dev_orch fires.
    const state = baseState({
      orch_work_available: true,
      orch_pending_grill_anchor: "none",
    });
    const cands = {
      candidates: [
        {
          issue: "item-271",
          anchorRef: "Persist settlement audit trail to ledger table",
          score: 0.78,
          designConcept: { present: true, isFresh: false, status: "stale", gateOk: false },
        },
      ],
    };
    const plan = runDecide(state, cands);
    const grill = findAction(plan, (a) => a.type === "dispatch" && a.slot === "design_concept_orch");
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(grill, undefined,
      "'none' signal + target best candidate must not produce an orch grill (#751)");
    assert.ok(dev, "dev_orch must proceed when no orch grill is pending");
  });
});
