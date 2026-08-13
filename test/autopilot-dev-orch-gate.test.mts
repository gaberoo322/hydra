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
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

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
// dev_orch per-anchor frontier-routing override (issue #3798)
// ---------------------------------------------------------------------------
//
// PR #3795 demoted dev_orch to Sonnet. The subagent_failure escalation net
// (ESCALATION_POLICY["dev_orch"]) rescues a CAPABILITY failure only — a
// dispatch that succeeds and produces green CI but is architecturally weak
// triggers nothing (QA is advisory-only and cannot block merge). #3798 adds
// a second, independent, LEADING lever: a dev_orch dispatch PINNED to a
// grill-clear anchor (issue #3711) routes to the frontier tier when that
// anchor's grill-clear status was earned by a genuine, APPROVED
// design-concept artifact — never a merely-fresh draft, and never the
// mechanical (#1230) / trivial (#1088) exemption (the opposite of
// "architecturally consequential").
//
// collect-state.sh pre-resolves the discriminator as
// `orch_dev_ready_anchor_design_concept_status` (one of "approved" / "draft"
// / "none") in the SAME loop pass that resolves `orch_dev_ready_anchor`
// itself — decide.py stays pure (no I/O) and reads the pre-qualified string
// verbatim, exactly like `orch_dev_ready_anchor`. A prior attempt (PR #3882)
// wired the WRONG source (`_candidate_design_concept` / the retired
// `/api/anchor/candidates` feed — dead code for dev_orch since issue #751)
// and failed adversarial QA twice for it; these tests pin both the correct
// wiring and the absence of the wrong one.

describe("decide.py — dev_orch per-anchor frontier-routing override (issue #3798)", () => {
  const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

  function makeDecideTmp() {
    const dir = mkdtempSync(join(tmpdir(), "decide-dev-orch-frontier-test-"));
    return { dir, state: join(dir, "state.json"), cands: join(dir, "cands.json"), events: join(dir, "events.json") };
  }

  function baseState(signals: Record<string, unknown>): any {
    return {
      started_epoch: Math.floor(Date.now() / 1000),
      limits: {
        token_budget: 2_000_000,
        wall_clock_max_sec: 28_800,
        idle_drain_turns: 5,
        scope: "all",
      },
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
      signal_last_fired: {
        health: 0,
        sweep_orch: 0,
        sweep_target: 0,
        discover_orch: 0,
        discover_target: 0,
      },
      signals,
      research_force_counter: {},
    };
  }

  // Both the pending-grill anchor and the dev-ready anchor must be set (and
  // DIFFERENT) for decide.py to take the PINNED dispatch branch this feature
  // lives in — see the #3711 gate in `_select_for_slot`. `orch_work_available`
  // is the outer gate the dev_orch branch checks first.
  function pinnedSignals(dcStatus?: string): Record<string, unknown> {
    const s: Record<string, unknown> = {
      orch_work_available: true,
      orch_pending_grill_anchor: "issue-100",
      orch_dev_ready_anchor: "issue-200",
    };
    if (dcStatus !== undefined) {
      s.orch_dev_ready_anchor_design_concept_status = dcStatus;
    }
    return s;
  }

  function runDecide(state: any): any {
    const t = makeDecideTmp();
    try {
      writeFileSync(t.state, JSON.stringify(state));
      writeFileSync(t.cands, JSON.stringify(null));
      writeFileSync(t.events, JSON.stringify([]));
      const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], { encoding: "utf-8" });
      if (r.status !== 0) {
        throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
      }
      return JSON.parse(r.stdout);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  }

  function findDevOrch(plan: any): any | undefined {
    return (plan.actions ?? []).find((a: any) => a.type === "dispatch" && a.slot === "dev_orch");
  }

  test("approved artifact -> pinned dev_orch dispatch carries prompt_args.route_model", () => {
    const plan = runDecide(baseState(pinnedSignals("approved")));
    const a = findDevOrch(plan);
    assert.ok(a, "expected a pinned dev_orch dispatch");
    assert.equal(a.prompt_args.anchor, "issue-200");
    assert.equal(
      a.prompt_args.route_model,
      "fable",
      "an approved artifact must route to ESCALATION_POLICY['dev_orch']['model'] (fable), read live not duplicated",
    );
  });

  test("fresh but unapproved (draft) artifact -> no route_model (stays Sonnet)", () => {
    const plan = runDecide(baseState(pinnedSignals("draft")));
    const a = findDevOrch(plan);
    assert.ok(a, "expected a pinned dev_orch dispatch");
    assert.equal(a.prompt_args.anchor, "issue-200");
    assert.equal(
      a.prompt_args.route_model,
      undefined,
      "a fresh-but-unapproved draft must NOT route to frontier",
    );
  });

  test("mechanical/trivial exemption (status=none) -> no route_model (stays Sonnet)", () => {
    // orch_dev_ready_anchor was won by the #1230/#1088 exemption branch in
    // collect-state.sh, which never sets an artifact status — "none" is the
    // opposite of "architecturally consequential" and must not spend Opus.
    const plan = runDecide(baseState(pinnedSignals("none")));
    const a = findDevOrch(plan);
    assert.ok(a, "expected a pinned dev_orch dispatch");
    assert.equal(
      a.prompt_args.route_model,
      undefined,
      "the mechanical/trivial exemption must NOT route to frontier",
    );
  });

  test("signal key entirely absent -> conservative default, no route_model", () => {
    // An older autopilot turn (collect-state.sh not yet redeployed) simply
    // omits the key. decide.py must never fail OPEN to frontier on absence.
    const plan = runDecide(baseState(pinnedSignals(undefined)));
    const a = findDevOrch(plan);
    assert.ok(a, "expected a pinned dev_orch dispatch");
    assert.equal(
      a.prompt_args.route_model,
      undefined,
      "an absent status signal must default to NOT routing frontier",
    );
  });

  test("malformed signal (non-string / unexpected value) -> conservative default, no route_model", () => {
    const s = pinnedSignals();
    (s as any).orch_dev_ready_anchor_design_concept_status = 42; // malformed: not a string
    const plan = runDecide(baseState(s));
    const a = findDevOrch(plan);
    assert.ok(a, "expected a pinned dev_orch dispatch");
    assert.equal(
      a.prompt_args.route_model,
      undefined,
      "a malformed (non-string) status signal must default to NOT routing frontier",
    );
  });

  test("purity (#1093): decide.py never emits a concrete top-level `model` field on the dispatch action", () => {
    const plan = runDecide(baseState(pinnedSignals("approved")));
    const a = findDevOrch(plan);
    assert.ok(a);
    assert.equal(
      a.model,
      undefined,
      "decide.py must emit only the prompt_args.route_model HINT, never a concrete `model` field (#1093)",
    );
  });

  test("channel independence: route_model never appears alongside escalate_model on the same action", () => {
    const plan = runDecide(baseState(pinnedSignals("approved")));
    const a = findDevOrch(plan);
    assert.ok(a);
    assert.equal(a.prompt_args.route_model, "fable");
    assert.equal(
      a.prompt_args.escalate_model,
      undefined,
      "route_model (first-attempt, dispatch-time) must never be conflated with escalate_model (retry telemetry)",
    );
  });

  test("unpinned dev_orch dispatch (no grill pending) never carries route_model", () => {
    // The common case: hydra-dev self-selects, no anchor is knowable at
    // dispatch time, so there is nothing for the predicate to evaluate —
    // even if a design-concept status signal happens to be present (it
    // shouldn't be, but the dispatch must not key off it either way).
    const state = baseState({
      orch_work_available: true,
      orch_dev_ready_anchor_design_concept_status: "approved",
    } as Record<string, unknown>);
    const plan = runDecide(state);
    const a = findDevOrch(plan);
    assert.ok(a, "expected an unpinned dev_orch dispatch");
    assert.equal(a.prompt_args.anchor, undefined, "unpinned dispatch carries no anchor");
    assert.equal(
      a.prompt_args.route_model,
      undefined,
      "the unpinned self-select path must never carry route_model — no anchor is knowable at dispatch time",
    );
  });

  test("structural: decide.py never CALLS _candidate_design_concept — only its (dead-code) definition may reference the name", () => {
    // Issue #751 removed the only call sites; PR #3882's first attempt
    // re-introduced a call and failed adversarial QA twice for it. Pin the
    // absence structurally so a future edit can't silently regress it.
    const decide = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");
    const callSites = decide.match(/_candidate_design_concept\(/g) ?? [];
    assert.equal(
      callSites.length,
      1,
      "_candidate_design_concept( must appear exactly once in decide.py — its own `def` line — and never be called",
    );
    assert.match(
      decide,
      /^def _candidate_design_concept\(/m,
      "the sole occurrence must be the function definition",
    );
  });

  test("structural: the #3798 discriminator reads orch_dev_ready_anchor_design_concept_status, not the candidate feed", () => {
    const decide = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");
    assert.match(decide, /design_concept_permits_frontier/);
    assert.match(decide, /orch_dev_ready_anchor_design_concept_status/);
  });

  test("structural: ESCALATION_POLICY['dev_orch'] subagent_failure trigger is untouched by this routing", () => {
    // Zero-edit guarantee: the capability-escalation net's trigger set and
    // max_attempts cap must still read exactly as before this feature.
    const decide = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");
    const m = decide.match(/"dev_orch":\s*\{\s*"triggers":\s*\(([^)]*)\),\s*"model":\s*"([^"]+)",\s*"max_attempts":\s*(\d+),/);
    assert.ok(m, "could not locate ESCALATION_POLICY['dev_orch'] row");
    assert.match(m![1], /"subagent_failure"/);
    assert.doesNotMatch(m![1], /"subagent_noop"/, "dev_orch must still trigger on subagent_failure ONLY");
    assert.equal(m![2], "fable", "escalate_model / route_model share the same live-sourced literal");
    assert.equal(m![3], "2", "max_attempts cap (invariant 4) unchanged");
  });
});
