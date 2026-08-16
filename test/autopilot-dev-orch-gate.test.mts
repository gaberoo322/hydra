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
 * collector emitted by `scripts/autopilot/collect-state.sh` that
 * counts open PRs on a hydra-dev head branch updated within the last
 * 90 minutes. The branch-prefix list MUST match the three patterns
 * hydra-dev actually creates (verified against `git branch -r` on
 * 2026-05-14):
 *
 *   - `issue-<N>-<slug>`    (most common; from the playbook prose)
 *   - `hydra-dev/<...>`     (planned future namespace)
 *   - `worktree-agent-<h>`  (Claude Agent tool isolation=worktree)
 *
 * This test pins the filter behavior by feeding constructed PR lists
 * through the same jq expression the script uses, so a future edit
 * can't silently break the gate.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// The jq filter is the load-bearing part of the collector. Extract it
// from the script so any drift in the script is caught here.
function extractJqFilter(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  // The filter is the multi-line jq argument after `gh pr list ... --jq`.
  // We pull the content between the first `--jq '[` and its terminating
  // `] | length'`. The whole filter is committed verbatim in the script.
  const match = src.match(/--jq '(\[[\s\S]*?\] \| length)'/);
  assert.ok(match, "could not locate jq filter in collect-state.sh");
  return match[1];
}

function runJq(filter: string, input: unknown): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("jq", [filter], {
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

function iso(secondsAgo: number): string {
  // GitHub's `updatedAt` is whole-second ISO-8601 (e.g. "2026-05-14T15:30:55Z").
  // jq's fromdateiso8601 rejects fractional seconds — Date#toISOString returns
  // ms precision and would break the filter. Strip the `.NNN` segment so the
  // test fixture matches the live API shape.
  const d = new Date(Date.now() - secondsAgo * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("scripts/autopilot/collect-state.sh — active_dev_orch collector (issue #412)", () => {
  const filter = extractJqFilter();

  test("stale in-progress label + no active PR → dispatch allowed (active_dev_orch=0)", () => {
    // The exact scenario from the issue #412 motivation: the live PR
    // list is empty even though some board issue carries the label.
    // The collector only looks at PRs — labels don't matter here.
    const prs: unknown[] = [];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0", "no PRs → count must be 0 (gate open)");
  });

  test("fresh PR on issue-<N> head → dispatch blocked (active_dev_orch=1)", () => {
    const prs = [
      { headRefName: "issue-412-dev-orch-gate", updatedAt: iso(60) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "one fresh PR on issue- prefix → count=1 (gate closed)");
  });

  test("fresh PR on hydra-dev/ head → dispatch blocked (active_dev_orch=1)", () => {
    const prs = [
      { headRefName: "hydra-dev/some-feature", updatedAt: iso(120) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "one fresh PR on hydra-dev/ prefix → count=1");
  });

  test("fresh PR on worktree-agent- head → dispatch blocked (active_dev_orch=1)", () => {
    // Claude Agent tool with isolation=worktree creates branches named
    // worktree-agent-<hash>. These are still hydra-dev work and MUST be
    // counted, otherwise the gate would dispatch a second dev_orch on
    // top of an active one — defeating the purpose of the gate.
    const prs = [
      { headRefName: "worktree-agent-ab3a8b01c3f11f366", updatedAt: iso(300) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "one fresh worktree-agent PR → count=1");
  });

  test("no label + no PR → dispatch allowed (active_dev_orch=0)", () => {
    const prs: unknown[] = [];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0");
  });

  test("old PR (>90 min stale) → dispatch allowed (active_dev_orch=0)", () => {
    // 91 minutes old — past the 5400s freshness window.
    const prs = [
      { headRefName: "issue-377-stale-dev", updatedAt: iso(91 * 60) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      "0",
      "PR older than 90 min must NOT count — that's the bug we're fixing",
    );
  });

  test("PR with non-hydra-dev branch prefix is ignored", () => {
    // Branches like `fix/foo` or `feat/bar` are not hydra-dev work.
    // They shouldn't gate the dev_orch slot.
    const prs = [
      { headRefName: "fix/priorities-unstick-planner-loop", updatedAt: iso(60) },
      { headRefName: "feat/issue-407-hydra-pr-rebase-skill", updatedAt: iso(60) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0", "non-hydra-dev branches must be ignored");
  });

  test("boundary: PR exactly at 90 min is NOT counted", () => {
    // The filter is `< 5400` (strict less-than). A PR exactly at the
    // boundary should be treated as stale and not gate the slot.
    const prs = [
      { headRefName: "issue-100-foo", updatedAt: iso(5400) },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "0", "PR exactly at boundary is stale (filter is < 5400)");
  });

  test("mixed fresh + stale + foreign → only fresh hydra-dev counted", () => {
    const prs = [
      { headRefName: "issue-1-fresh", updatedAt: iso(60) },           // counts
      { headRefName: "issue-2-stale", updatedAt: iso(99 * 60) },      // stale → no
      { headRefName: "hydra-dev/x", updatedAt: iso(1000) },           // counts
      { headRefName: "worktree-agent-deadbeef", updatedAt: iso(10) }, // counts
      { headRefName: "fix/foreign", updatedAt: iso(10) },             // foreign → no
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "3", "three fresh hydra-dev PRs out of five total");
  });

  // --- GLM dev-drainer partition (ADR-0032 / issue #3687) -------------------
  // The drainer authors in a git worktree, so its PR head branch carries the
  // SAME `worktree-agent-*` prefix as an Opus dev_orch PR. Provenance is
  // therefore a LABEL, not a branch name (ADR-0032 Decision 5 / invariant 9),
  // and the collector must subtract `glm-authored` PRs — otherwise an open
  // drainer PR inflates `active_dev_orch` and idles the Opus dev_orch slot on
  // quota the drainer isn't spending.

  test("fresh glm-authored PR on worktree-agent- head is NOT counted (#3687)", () => {
    const prs = [
      {
        headRefName: "worktree-agent-ab3a8b01c3f11f366",
        updatedAt: iso(60),
        labels: [{ name: "glm-authored" }],
      },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      "0",
      "a glm-authored drainer PR must not gate the Opus dev_orch slot",
    );
  });

  test("glm-authored is subtracted while a sibling Opus PR still counts (#3687)", () => {
    const prs = [
      // drainer PR — same branch prefix, discriminated only by the label
      {
        headRefName: "worktree-agent-deadbeef",
        updatedAt: iso(60),
        labels: [{ name: "glm-authored" }, { name: "enhancement" }],
      },
      // genuine Opus dev_orch PR — still counts
      {
        headRefName: "worktree-agent-cafebabe",
        updatedAt: iso(60),
        labels: [{ name: "enhancement" }],
      },
    ];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      "1",
      "only the non-glm-authored PR counts — the branch prefix is identical",
    );
  });

  test("PR row with no labels field is not treated as glm-authored (#3687)", () => {
    // Totality guard: `.labels // []` must keep the filter safe on a row that
    // omits `labels` entirely, rather than erroring or dropping the PR.
    const prs = [{ headRefName: "issue-412-no-labels-field", updatedAt: iso(60) }];
    const r = runJq(filter, prs);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "1", "missing labels ⇒ not glm-authored ⇒ still counted");
  });

  test("collector script is executable and emits active_dev_orch line", () => {
    // Belt-and-braces: confirm the line is actually printed when the
    // script runs. We don't assert the value (it depends on live
    // GitHub state) — only that the key is present, so the playbook's
    // Phase 4 dev_orch rule can read it.
    const r = spawnSync(SCRIPT, [], { encoding: "utf-8", timeout: 30_000 });
    // Script exits non-zero in some hostile environments (no `hydra`
    // CLI on PATH, etc.); we only care about the active_dev_orch line.
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.match(
      out,
      /^active_dev_orch=\d+$/m,
      "collector must emit a parseable active_dev_orch=<count> line",
    );
  });
});

describe("hydra-autopilot dev_orch rule (issue #412)", () => {
  // Post-#426 the decision logic moved out of the playbook prose and
  // into `scripts/autopilot/decide.py`. The #412 invariant — dev_orch
  // gates on the live PR signal, not the stale `in-progress` label —
  // is now expressed in code: the dev_orch slot is only filled when
  // the slot is free (i.e. no in-flight dispatch) AND the best
  // candidate score meets the threshold. We pin both the busy-slot
  // guard in decide.py and the PR-signal collector in collect-state.sh
  // so a future edit can't silently re-introduce the label-based gate.
  const decide = readFileSync(
    join(REPO_ROOT, "scripts", "autopilot", "decide.py"),
    "utf-8",
  );
  const collector = readFileSync(
    join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh"),
    "utf-8",
  );

  test("decide.py gates dev_orch on the live PR signal, not the in-progress label", () => {
    // Find the dev_orch branch in _select_for_slot.
    assert.match(decide, /cls == "dev_orch"/);
    // The dev_orch slot is only filled when the slot is free; that's
    // INV-002 (already pinned). The legacy `in_progress == 0` guard
    // must not appear anywhere in the decision module.
    assert.doesNotMatch(
      decide,
      /in_progress\s*==\s*0/,
      "decide.py must NOT gate dev_orch on the stale `in_progress == 0` label",
    );
  });

  test("collect-state.sh still emits active_dev_orch=<count> for the model", () => {
    assert.match(
      collector,
      /active_dev_orch/,
      "Phase 1 collector must emit the live-PR signal so the model can set signals.active_dev_orch",
    );
  });

  test("active_dev_orch gh query requests labels so the glm filter can see them (#3687)", () => {
    // The `glm-authored` exclusion is invisible unless `labels` is in the
    // --json field list: `gh` would omit the key, `.labels // []` would yield
    // `[]`, and EVERY drainer PR would silently re-inflate the counter. Pin
    // the field list so dropping it fails loudly here instead of in prod.
    assert.match(
      collector,
      /gh pr list --repo gaberoo322\/hydra --state open --json [^\n]*\blabels\b/,
      "active_dev_orch collector must request `labels` from gh",
    );
  });
});

// ---------------------------------------------------------------------------
// Frontier-tier routing hint on a pinned dev_orch anchor (issue #3798,
// #3795 follow-up).
//
// dev_orch was demoted to Sonnet in PR #3795. Its only escalation net was
// `ESCALATION_POLICY["dev_orch"]` — a capability-failure retry triggered by
// `subagent_failure` — which cannot catch a PR that compiles, passes tests
// and CI, but is architecturally weak. This closes the LEADING half of that
// gap: a pinned dev_orch anchor (the per-anchor gate, #3711) whose
// grill-clearness came from a genuine, APPROVED design-concept artifact is
// architecturally consequential enough to route to the frontier tier for
// that one dispatch, via a `prompt_args.route_model` HINT the playbook maps
// to the Agent model kwarg. An anchor that is grill-clear ONLY via the
// mechanical (#1230) or trivial (#1088) exemption — the opposite of
// architecturally consequential — must NEVER receive the hint, and neither
// must the (far more common) unpinned dispatch, which has no anchor known to
// decide.py at dispatch time.
//
// `orch_dev_ready_anchor_design_concept_status` (collect-state.sh) is the
// pre-resolved discriminator: "approved"/"draft" only in the fresh-artifact
// branch, "none" in both exemption branches. decide.py performs no I/O to
// compute it — this stays a pure function of (state, events, now), per #3711.
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
    writeFileSync(statePath, JSON.stringify(state));
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

describe("decide.py — dev_orch route_model frontier hint on a pinned anchor (issue #3798)", () => {
  test("genuine fresh (approved) artifact on the pinned anchor → route_model hint attached", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: "approved",
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev, "dev_orch must still be pinned to the grill-clear anchor");
    assert.equal(dev.prompt_args.anchor, "issue-3707");
    assert.equal(
      dev.prompt_args.route_model,
      "fable",
      "an approved design-concept artifact must route the pinned dispatch to the frontier tier",
    );
  });

  test("mechanical/trivial exemption (status=none) on the pinned anchor → NO route_model hint", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: "none",
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev, "dev_orch must still be pinned to the grill-clear anchor");
    assert.equal(
      dev.prompt_args.route_model,
      undefined,
      "the mechanical/trivial exemption is the OPPOSITE of architecturally consequential — must stay on Sonnet",
    );
  });

  test("draft (not yet approved) artifact on the pinned anchor → NO route_model hint", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: "draft",
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev);
    assert.equal(
      dev.prompt_args.route_model,
      undefined,
      "only an APPROVED artifact permits frontier routing — draft stays on Sonnet",
    );
  });

  test("absent design-concept status signal on the pinned anchor → NO route_model hint (conservative default)", () => {
    // An older autopilot turn, or a collect-state.sh emitting only the first
    // two signals — the new key is simply missing from state.signals.
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev);
    assert.equal(
      dev.prompt_args.route_model,
      undefined,
      "an absent signal must never fail OPEN to the frontier tier",
    );
  });

  test("malformed (non-string) design-concept status signal → NO route_model hint", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: 1,
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev);
    assert.equal(dev.prompt_args.route_model, undefined,
      "a non-string signal must never be mistaken for 'approved'");
  });

  test("UNPINNED dev_orch dispatch never carries route_model, even with an approved status signal", () => {
    // No grill pending → dev_orch dispatches unpinned (hydra-dev self-selects
    // per #458). The routing hint is scoped to the pinned-dispatch branch
    // ONLY (design-concept artifact rejected-alternatives: widening it to the
    // unpinned path is a separate, larger #3711-scoped decision).
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "none",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: "approved",
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev, "dev_orch dispatches when no grill is pending");
    assert.equal(dev.prompt_args?.anchor, undefined, "no grill pending → no pin");
    assert.equal(
      dev.prompt_args?.route_model,
      undefined,
      "the unpinned self-select path must never receive the frontier hint",
    );
  });

  test("#1093 purity — decide.py emits NO concrete `model` field, only the route_model HINT", () => {
    const state = decideBaseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-3730",
        orch_dev_ready_anchor: "issue-3707",
        orch_dev_ready_anchor_design_concept_status: "approved",
      },
    });
    const plan = runDecide(state);
    const dev = findDevDispatch(plan);
    assert.ok(dev);
    assert.equal(dev.model, undefined, "decide.py must never emit a concrete model field (#1093)");
    assert.equal(typeof dev.prompt_args.route_model, "string",
      "route_model must be a plain string alias, not a resolved model object");
  });

  test("decision core does not consult the retired candidate-feed design-concept path (#751, #3455)", () => {
    // The issue's operator correction (2026-08-13): `_candidate_design_concept`
    // / `_design_concept_is_fresh` read `best.designConcept` from the RETIRED
    // /api/anchor/candidates feed and were removed from the decision path by
    // #751. The dev_orch pinned-dispatch branch below must source the routing
    // discriminator ONLY from the pre-resolved collect-state.sh signal, never
    // from those dead-code helpers.
    const src = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");
    const start = src.indexOf('if cls == "dev_orch":');
    assert.ok(start > 0, "could not locate the dev_orch selector branch in decide.py");
    const after = src.indexOf('\n    if cls == "dev_target":', start);
    assert.ok(after > start, "could not locate the end of the dev_orch selector branch");
    const body = src.slice(start, after);
    assert.match(body, /_orch_dev_ready_design_concept_status\(/,
      "sanity: the sliced region must be the branch that reads the new signal");
    for (const forbidden of ["_candidate_design_concept(", "_design_concept_is_fresh(", 'best.get("designConcept")']) {
      assert.equal(body.includes(forbidden), false,
        `dev_orch selector must not consult the retired candidate feed — found "${forbidden}"`);
    }
  });

  test("route_model is sourced live from ESCALATION_POLICY, never a duplicated literal", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");
    assert.match(
      src,
      /prompt_args\["route_model"\]\s*=\s*ESCALATION_POLICY\["dev_orch"\]\["model"\]/,
      "route_model must read ESCALATION_POLICY live so the two channels (route_model / escalate_model) never drift apart",
    );
  });
});
