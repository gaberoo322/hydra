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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

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
// dev_orch anchor-shape frontier routing (issue #3798)
// ---------------------------------------------------------------------------
//
// PR #3795 demoted dev_orch to Sonnet on evidence. Issue #3798 adds a LEADING
// discriminator: a dev_orch dispatch whose anchor carries a fresh, APPROVED
// design-concept artifact routes to the frontier tier for that one dispatch;
// stale / absent / unapproved keep Sonnet. decide.py emits the routing as a
// `prompt_args.route_model` HINT — never a concrete `model` field (#1093) —
// that the playbook maps to the Agent model kwarg, parallel to the
// `escalate_model` cascade-routing override. Exercised at the decision-core
// level by invoking `decide.py decide` with constructed (state, candidates,
// events) triples, pinning the four artifact-shape combinations the issue's AC
// names plus the purity invariant and the pinned-dispatch path.

const DECIDE_PY = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

function devOrchBaseState(signals: Record<string, unknown> = {}): any {
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
    signals: { orch_work_available: true, ...signals },
    research_force_counter: {},
  };
}

function runDecidePy(state: any, candidates: any, events: any[] = []): any {
  const dir = mkdtempSync(join(tmpdir(), "dev-orch-gate-3798-"));
  const statePath = join(dir, "state.json");
  const candsPath = join(dir, "candidates.json");
  const eventsPath = join(dir, "events.json");
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(candsPath, JSON.stringify(candidates));
  writeFileSync(eventsPath, JSON.stringify(events));
  const r = spawnSync("python3", [DECIDE_PY, "decide", statePath, candsPath, eventsPath], {
    encoding: "utf-8",
    // Keep the CLI's run-end POST (#1352) off so a test can never reach a live
    // orchestrator from the suite.
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
  });
  // Always read output before tearing down so a failure leaves a usable message.
  const out = r.stdout ?? "";
  const err = r.stderr ?? "";
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) {
    throw new Error(`decide.py decide exited ${r.status}\nstdout: ${out}\nstderr: ${err}`);
  }
  return JSON.parse(out);
}

function devOrchDispatch(plan: any): any | undefined {
  return (plan.actions ?? []).find((a: any) => a.type === "dispatch" && a.slot === "dev_orch");
}

// A candidate feed whose top entry carries a `designConcept` block of the given
// shape. `best_candidate` returns candidates[0], so this block is the one
// `_candidate_design_concept` reads. The block mirrors the shape the
// `_candidate_design_concept` docstring documents and the golden candidates
// fixtures carry: { present, isFresh, status, gateOk }.
function candWith(designConcept: Record<string, unknown>): any {
  return {
    candidates: [
      { issue: 3798, anchorRef: "issue-3798", score: 0.9, designConcept },
    ],
    research_recommended: false,
  };
}

describe("decide.py — dev_orch anchor-shape frontier routing (issue #3798)", () => {
  const FRESH_APPROVED = { present: true, isFresh: true, status: "approved", gateOk: true };
  const STALE = { present: true, isFresh: false, status: "approved", gateOk: true };
  const ABSENT = { present: false, isFresh: false, status: null, gateOk: false };
  const UNAPPROVED = { present: true, isFresh: true, status: "draft", gateOk: false };

  test("fresh + approved artifact -> route_model HINT set to the frontier alias", () => {
    const plan = runDecidePy(devOrchBaseState(), candWith(FRESH_APPROVED));
    const d = devOrchDispatch(plan);
    assert.ok(d, "expected a dev_orch dispatch on orch_work_available");
    assert.equal(
      d.prompt_args.route_model,
      "fable",
      "a fresh+approved artifact routes dev_orch to the frontier tier (route_model HINT, resolved to Opus by the playbook fallback while fable is unentitled)",
    );
  });

  test("stale artifact -> NO route_model (stays Sonnet)", () => {
    // Staleness reuses the existing `_design_concept_is_fresh` predicate — the
    // issue's "do not invent a second staleness rule" constraint. A stale
    // artifact is grill-clear enough to build, but not the population this
    // routing escalates.
    const plan = runDecidePy(devOrchBaseState(), candWith(STALE));
    const d = devOrchDispatch(plan);
    assert.ok(d);
    assert.equal(
      d.prompt_args.route_model,
      undefined,
      "a stale artifact reuses the existing freshness predicate and stays Sonnet",
    );
  });

  test("absent artifact -> NO route_model (stays Sonnet)", () => {
    const plan = runDecidePy(devOrchBaseState(), candWith(ABSENT));
    const d = devOrchDispatch(plan);
    assert.ok(d);
    assert.equal(
      d.prompt_args.route_model,
      undefined,
      "an anchor with no artifact stays Sonnet",
    );
  });

  test("unapproved (draft) artifact -> NO route_model (stays Sonnet)", () => {
    // Approval is its own dimension, orthogonal to freshness. A fresh-but-draft
    // (warn-only) artifact proceeds (Phase B) but does NOT trigger frontier
    // routing — only an APPROVED artifact does.
    const plan = runDecidePy(devOrchBaseState(), candWith(UNAPPROVED));
    const d = devOrchDispatch(plan);
    assert.ok(d);
    assert.equal(
      d.prompt_args.route_model,
      undefined,
      "a fresh-but-unapproved (draft) artifact stays Sonnet",
    );
  });

  test("no candidate feed -> NO route_model (conservative Sonnet default)", () => {
    // The candidate feed is the discriminator's carrier. An absent/empty feed
    // carries no artifact information, so dev_orch stays on the measured Sonnet
    // tier (today's behaviour) rather than speculatively routing frontier.
    const plan = runDecidePy(
      devOrchBaseState(),
      { candidates: [], research_recommended: false },
    );
    const d = devOrchDispatch(plan);
    assert.ok(d);
    assert.equal(d.prompt_args.route_model, undefined);
  });

  test("#1093 purity: route_model is a HINT in prompt_args, never a concrete model field", () => {
    const plan = runDecidePy(devOrchBaseState(), candWith(FRESH_APPROVED));
    const d = devOrchDispatch(plan);
    assert.ok(d);
    assert.equal(d.prompt_args.route_model, "fable");
    assert.equal(
      d.model,
      undefined,
      "decide.py must NOT stamp a concrete `model` field — only the route_model HINT (the lever lives in the playbook)",
    );
  });

  test("route_model HINT rides the PINNED dispatch too (grill-clear anchor while another awaits grill, #3711)", () => {
    // Per-anchor gate: a grill pending on one anchor pins dev_orch to a
    // different grill-clear anchor. The frontier routing must apply on this
    // pinned dispatch path as well, not only the unpinned one.
    const state = devOrchBaseState({
      orch_pending_grill_anchor: "issue-9999",
      orch_dev_ready_anchor: "issue-3798",
    });
    const plan = runDecidePy(state, candWith(FRESH_APPROVED));
    const d = devOrchDispatch(plan);
    assert.ok(d, "expected a pinned dev_orch dispatch");
    assert.equal(
      d.prompt_args.anchor,
      "issue-3798",
      "pinned dispatch names the grill-clear anchor",
    );
    assert.equal(
      d.prompt_args.route_model,
      "fable",
      "the frontier routing HINT rides the pinned dispatch path too",
    );
  });

  test("route_model is a distinct channel from the subagent_failure escalation HINT", () => {
    // The two frontier levers attach to DIFFERENT dispatches and never collide
    // on one action: route_model rides the INITIAL dispatch (anchor shape);
    // escalate_model/attempt/prior_attempt_status ride the cascade re-dispatch
    // (capability failure, pinned independently by decide-cascade-escalation).
    const plan = runDecidePy(devOrchBaseState(), candWith(FRESH_APPROVED));
    const d = devOrchDispatch(plan);
    assert.ok(d);
    assert.equal(d.prompt_args.route_model, "fable");
    assert.equal(
      d.prompt_args.escalate_model,
      undefined,
      "the initial-dispatch frontier HINT is not the escalation HINT",
    );
    assert.equal(
      d.prompt_args.attempt,
      undefined,
      "attempt / prior_attempt_status belong to the subagent_failure re-dispatch, not the initial routing",
    );
  });

  test("decide.py wires the discriminator via the existing design-concept helpers", () => {
    // Belt-and-braces: the issue directs reuse of `_candidate_design_concept`
    // and `_design_concept_is_fresh` (no second staleness rule). Pin that the
    // routing predicate and both helpers are present and named as documented,
    // so a future edit can't silently invent a parallel staleness path.
    const src = readFileSync(DECIDE_PY, "utf-8");
    assert.match(src, /def _candidate_design_concept\(/);
    assert.match(src, /def _design_concept_is_fresh\(/);
    assert.match(src, /def _design_concept_is_approved\(/);
    assert.match(src, /def _design_concept_routes_frontier\(/);
    assert.match(
      src,
      /return _design_concept_is_fresh\(dc\) and _design_concept_is_approved\(dc\)/,
      "the frontier discriminator must compose the existing freshness predicate with approval",
    );
    // The dev_orch selector turns the verdict into a route_model HINT.
    assert.match(src, /route_model = "fable" if _design_concept_routes_frontier\(dc\) else None/);
  });
});
