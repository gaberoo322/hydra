/**
 * Regression test for issue #412 — dev_orch gate uses a fresh PR signal,
 * not the stale `in-progress` label.
 *
 * The /hydra-autopilot Phase 4 `dev_orch` rule used to gate on
 * `in_progress == 0`. That signal is stored in a GitHub label and can
 * survive a dispatch that died before producing a PR — observed in
 * the 2026-05-14 autopilot session where issue #377 carried a stale
 * `in_progress` label all night and blocked every `dev_orch` dispatch.
 *
 * The fix replaces the label check with `active_dev_orch == 0`, a
 * collector emitted by the Turn Snapshot collectors (`src/autopilot/turn-snapshot/`) that
 * counts open PRs on a hydra-dev head branch updated within the last
 * 90 minutes. The branch-prefix list MUST match the three patterns
 * hydra-dev actually creates (verified against `git branch -r` on
 * 2026-05-14):
 *
 *   - `issue-<N>-<slug>`    (most common; from the playbook prose)
 *   - `hydra-dev/<...>`     (planned future namespace)
 *   - `worktree-agent-<h>`  (Claude Agent tool isolation=worktree)
 *
 * The filter's behaviour is pinned in test/turn-snapshot-picks.test.mts
 * since the collector became the typed Turn Snapshot picks collector
 * (ADR-0043 slice 3, #4931); this file keeps the wiring + decide.py rules.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { brainFunctionSource, readBrainSource } from "../scripts/ci/brain-source.ts";
import { withTurnSnapshot } from "./_helpers/turn-snapshot-state.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// The active_dev_orch filter's behavioural cases (#412 branch prefixes, the
// 90-minute window, the #3687 / #4048 GLM partition) moved with the collector
// into the typed Turn Snapshot picks collector (ADR-0043 slice 3, #4931):
// see test/turn-snapshot-picks.test.mts. What stays here is the wiring.

describe("hydra-autopilot dev_orch rule (issue #412)", () => {
  // Post-#426 the decision logic moved out of the playbook prose and
  // into `scripts/autopilot/decide.py`. The #412 invariant — dev_orch
  // gates on the live PR signal, not the stale `in-progress` label —
  // is now expressed in code: the dev_orch slot is only filled when
  // the slot is free (i.e. no in-flight dispatch) AND the best
  // candidate score meets the threshold. We pin both the busy-slot
  // guard in decide.py and the PR-signal field of the Turn Snapshot
  // (ADR-0043; collect-state.sh was retired in #4934) so a future edit
  // can't silently re-introduce the label-based gate.
  // The whole brain corpus (#4511): the dev_orch handler body now lives in
  // decide_selectors/dev.py, so the negative pin below must cover it there.
  const decide = readBrainSource().joined;
  const snapshotBuilder = readFileSync(
    join(REPO_ROOT, "src", "autopilot", "turn-snapshot", "json-snapshot.ts"),
    "utf-8",
  );

  test("decide.py gates dev_orch on the live PR signal, not the in-progress label", () => {
    // The dev_orch selector is its own handler, registered in _SLOT_SELECTORS
    // (issue #4265 — per-class handler extraction).
    assert.match(decide, /"dev_orch": _select_slot_dev_orch/);
    // The dev_orch slot is only filled when the slot is free; that's
    // INV-002 (already pinned). The legacy `in_progress == 0` guard
    // must not appear anywhere in the decision module.
    assert.doesNotMatch(
      decide,
      /in_progress\s*==\s*0/,
      "decide.py must NOT gate dev_orch on the stale `in_progress == 0` label",
    );
  });

  test("the Turn Snapshot still carries active_dev_orch (the live-PR count) in its observability section", () => {
    assert.match(
      snapshotBuilder,
      /active_dev_orch: v\.picks\.activeDevOrch/,
      "the Turn Snapshot must keep carrying the live-PR count (observability.active_dev_orch) — the picks collector computes it, #412",
    );
  });
});

// ---------------------------------------------------------------------------
// First-attempt dev_orch dispatches stay on the static per-class model map
// (issue #4821 — supersedes the #3798 frontier-routing hint).
//
// #3798 routed a pinned dev_orch anchor to the frontier tier whenever its
// grill-clearness came from an APPROVED design-concept artifact, via a
// `prompt_args.route_model` HINT. It was sized on a board sample where 24% of
// anchors carried an artifact. In steady state every non-exempt anchor is
// grilled before dev_orch may pin it, so the discriminator stopped
// discriminating: 11 of 22 first-attempt dispatches (every pinned one) went
// frontier, 36% of dev_orch tokens, with no better first-pass QA rate.
//
// The hint and its Turn Snapshot signal
// (`orch_dev_ready_anchor_design_concept_status`) are removed. The pin itself
// (#3711) is untouched, and so is the `subagent_failure` escalation row —
// `ESCALATION_POLICY["dev_orch"]` is still the one path to the frontier tier
// (pinned by test/decide-cascade-escalation.test.mts).
// ---------------------------------------------------------------------------

interface DecideStateOverrides {
  signals?: Record<string, unknown>;
}

function decideBaseState(o: DecideStateOverrides = {}): any {
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
    signals: o.signals ?? {},
  };
}

function runDecide(state: any, candidates: any | null = null, events: any[] = []): any {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dev-orch-route-"));
  try {
    const statePath = join(dir, "state.json");
    const candsPath = join(dir, "candidates.json");
    const eventsPath = join(dir, "events.json");
    writeFileSync(statePath, JSON.stringify(withTurnSnapshot(state)));
    writeFileSync(candsPath, JSON.stringify(candidates ?? { candidates: [], research_recommended: false }));
    writeFileSync(eventsPath, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", statePath, candsPath, eventsPath], { encoding: "utf-8" });
    assert.equal(r.status, 0, `decide.py exited non-zero: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function findDevDispatch(plan: any): any | undefined {
  return (plan.actions ?? []).find((a: any) => a.type === "dispatch" && a.slot === "dev_orch");
}

describe("decide.py — first-attempt dev_orch dispatches carry no frontier routing hint (issue #4821)", () => {
  // A state.json written by an older Turn Snapshot (or hand-merged by the
  // parent session) may still carry the retired status signal. Whatever it
  // says, decide.py must ignore it.
  const RETIRED_STATUS_VALUES: Array<[string, unknown]> = [
    ["approved", "approved"],
    ["draft", "draft"],
    ["none", "none"],
    ["non-string", 1],
  ];

  for (const [label, value] of RETIRED_STATUS_VALUES) {
    test(`pinned anchor + retired status signal (${label}) → pinned dispatch, NO route_model`, () => {
      const state = decideBaseState({
        signals: {
          orch_work_available: true,
          orch_pending_grill_anchor: "issue-3730",
          orch_dev_ready_anchor: "issue-3707",
          orch_dev_ready_anchor_design_concept_status: value,
        },
      });
      const dev = findDevDispatch(runDecide(state));
      assert.ok(dev, "dev_orch must still be pinned to the grill-clear anchor (#3711)");
      assert.equal(dev.prompt_args.anchor, "issue-3707");
      assert.equal(
        dev.prompt_args.route_model,
        undefined,
        "a first-attempt dev_orch dispatch must resolve its model from the static per-class map",
      );
    });
  }

  test("pinned anchor without the retired signal → prompt_args is exactly the anchor pin", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
      },
    });
    const dev = findDevDispatch(runDecide(state));
    assert.ok(dev);
    assert.deepEqual(dev.prompt_args, { anchor: "issue-3707" });
  });

  test("UNPINNED dev_orch dispatch carries neither an anchor nor route_model", () => {
    // No grill pending → dev_orch dispatches unpinned (hydra-dev self-selects
    // per #458).
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "none",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: "approved",
      },
    });
    const dev = findDevDispatch(runDecide(state));
    assert.ok(dev, "dev_orch dispatches when no grill is pending");
    assert.equal(dev.prompt_args?.anchor, undefined, "no grill pending → no pin");
    assert.equal(dev.prompt_args?.route_model, undefined);
  });

  test("#1093 purity — the pinned dispatch emits NO concrete `model` field", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
      },
    });
    const dev = findDevDispatch(runDecide(state));
    assert.ok(dev);
    assert.equal(dev.model, undefined, "decide.py must never emit a concrete model field (#1093)");
  });

  test("decide.py has no first-attempt routing channel left to re-arm by accident", () => {
    // Issue #4511: the dev_orch selector lives in decide_selectors/dev.py, so
    // scan the whole brain corpus, not decide.py alone.
    const src = readBrainSource().joined;
    for (const retired of [
      "route_model",
      "design_concept_permits_frontier",
      "orch_dev_ready_anchor_design_concept_status",
    ]) {
      assert.equal(src.includes(retired), false,
        `the decide brain source must not mention the retired "${retired}" (issue #4821)`);
    }
  });

  test("decision core does not consult the retired candidate-feed design-concept path (#751, #3455)", () => {
    // `_candidate_design_concept` / `_design_concept_is_fresh` read
    // `best.designConcept` from the RETIRED /api/anchor/candidates feed and
    // were removed from the decision path by #751. The dev_orch selector
    // reads only the pre-resolved Turn Snapshot anchor signals.
    // Issue #4265: the dev_orch branch is its own `_select_slot_dev_orch`
    // handler — slice from its `def` to the next top-level `def`. Issue #4511:
    // the handler lives in a selector module, so slice it out of the brain
    // corpus (per file) rather than decide.py.
    const found = brainFunctionSource(readBrainSource(), "_select_slot_dev_orch");
    assert.ok(found, "could not locate the dev_orch selector handler in the brain source corpus");
    const body = found.body;
    assert.match(body, /_orch_anchor_signal\(state, "orch_dev_ready_anchor"\)/,
      "sanity: the sliced region must be the branch that reads the dev-ready pin");
    for (const forbidden of ["_candidate_design_concept(", "_design_concept_is_fresh(", 'best.get("designConcept")']) {
      assert.equal(body.includes(forbidden), false,
        `dev_orch selector must not consult the retired candidate feed — found "${forbidden}"`);
    }
  });
});
