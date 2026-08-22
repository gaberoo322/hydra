/**
 * Regression test for issue #4096 — `needs-design-concept` without
 * `ready-for-agent` is an unreachable lane; the `untriaged_orphans` backstop
 * is its consumer.
 *
 * The label is an override INSIDE the grill selector's walk (it forces
 * TRIVIAL=0 in collect-state.sh's trivial gate), not an entry point INTO it:
 * `orch_pending_grill_anchor` is resolved by iterating the `ready-for-agent`
 * candidate list, so an issue that is NOT `ready-for-agent` can never become
 * a grill anchor and `design_concept_orch` never fires on it. No HITL surface
 * lists it either (`/hydra-review` has no bucket for it, and #4096's design
 * concept deliberately adds none). #3817 excluded the label from the orphan
 * backstop unconditionally, which composed the three into a sink: promoted
 * out of `needs-triage` (observed on #4093, run bdbf82c8), invisible to the
 * grill walk, and exempt from the backstop — silently unreachable.
 *
 * Resolution (design-concept issue-4096, INV-6): the orphan-backstop route
 * ONLY. The label is removed from the untriaged_orphans exclusion array, so:
 *   - `needs-design-concept` WITHOUT `ready-for-agent` counts as an orphan →
 *     sweep_orch recovers it by ADDING `ready-for-agent` (through the #772
 *     Open-PR pre-promotion gate, never stripping the label — the grill
 *     obligation it records is still owed), which puts the issue in the grill
 *     walk;
 *   - `needs-design-concept` WITH `ready-for-agent` stays excluded via the
 *     `ready-for-agent` entry itself — #3817's no-churn property holds for
 *     the parked-and-routed state.
 *
 * These cases run the COMMITTED jq filter through real `jq` (extracted
 * verbatim from the script, the #3728/#3817/#4025 precedent), NOT a
 * TypeScript re-derivation — design-concept INV-7. Both directions of the
 * predicate are pinned so a partial regression cannot slip through.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const PLAYBOOKS = join(REPO_ROOT, "docs", "operator-playbooks");

const SRC = readFileSync(join(SCRIPTS, "collect-state.sh"), "utf-8");

/** Extract the committed untriaged_orphans jq filter verbatim from the script
 *  (same extractor shape as the #3817/#4025 blocks in autopilot-scripts.test.mts). */
function extractFilter(): string {
  const start = SRC.indexOf('echo -n "untriaged_orphans="');
  assert.ok(start >= 0, "untriaged_orphans emitter missing from collect-state.sh");
  const jqOpen = SRC.indexOf("--jq '", start);
  assert.ok(jqOpen >= 0, "untriaged_orphans gh read missing its --jq filter");
  const filterStart = jqOpen + "--jq '".length;
  const filterEnd = SRC.indexOf("'", filterStart);
  assert.ok(filterEnd >= 0, "untriaged_orphans --jq filter is never closed");
  return SRC.slice(filterStart, filterEnd);
}

/** Run the committed filter against synthetic issues through real jq. */
function count(issues: readonly { labels: string[] }[]): string {
  const input = JSON.stringify(
    issues.map((i) => ({ labels: i.labels.map((name) => ({ name })) })),
  );
  const r = spawnSync("jq", [extractFilter()], { input, encoding: "utf-8" });
  assert.equal(r.status, 0, `untriaged_orphans jq failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

describe("collect-state.sh untriaged_orphans needs-design-concept reachability (#4096)", () => {
  test("INV-1: [bug, needs-design-concept] (the #4093 label state) IS an untriaged orphan", () => {
    // The exact fixture the issue describes: an issue promoted OUT of
    // needs-triage by sweep_orch onto needs-design-concept, keeping only its
    // category label. No lifecycle label remains, so nothing else excludes it.
    assert.equal(
      count([{ labels: ["bug", "needs-design-concept"] }]),
      "1",
      "needs-design-concept without ready-for-agent has no consumer — the grill walk sources ONLY --label ready-for-agent, so the orphan backstop must count it and dispatch the sweep that restores reachability",
    );
  });

  test("INV-1: needs-design-concept alone IS an untriaged orphan", () => {
    assert.equal(count([{ labels: ["needs-design-concept"] }]), "1");
  });

  test("INV-2: [needs-design-concept, ready-for-agent] is NOT an untriaged orphan (parked-and-routed state)", () => {
    assert.equal(
      count([{ labels: ["needs-design-concept", "ready-for-agent"] }]),
      "0",
      "paired with ready-for-agent the issue is reachable via design_concept_orch's grill walk (#3817's rationale) — counting it would re-fire sweep_orch churn against an issue sweep has no action on",
    );
  });

  test("INV-2: category labels alongside the pair change nothing", () => {
    assert.equal(
      count([{ labels: ["enhancement", "needs-design-concept", "ready-for-agent"] }]),
      "0",
    );
  });

  test("INV-3: needs-tickets alone stays excluded (its consumer is tickets_orch, #4014)", () => {
    assert.equal(
      count([{ labels: ["needs-tickets"] }]),
      "0",
      "the #4096 narrowing scopes ONLY needs-design-concept — needs-tickets is a genuine standalone parking lane with no ready-for-agent precondition",
    );
  });

  test("INV-3: hitl-grill alone stays excluded (terminal park state, #4025)", () => {
    assert.equal(count([{ labels: ["hitl-grill"] }]), "0");
  });

  test("backstop intact: a genuinely label-less issue IS still an orphan", () => {
    assert.equal(count([{ labels: [] }]), "1");
  });

  test("backstop intact: a meta-friction-only issue IS still an orphan (motivating example)", () => {
    assert.equal(count([{ labels: ["meta-friction"] }]), "1");
  });

  test("mixed board: the recovered lane counts alongside the genuine orphans", () => {
    assert.equal(
      count([
        { labels: ["bug", "needs-design-concept"] }, // recovered orphan (#4096)
        { labels: ["needs-design-concept", "ready-for-agent"] }, // excluded (INV-2)
        { labels: ["needs-tickets"] }, // excluded (INV-3)
        { labels: ["meta-friction"] }, // genuine orphan
        { labels: [] }, // genuine orphan
      ]),
      "3",
    );
  });
});

describe("collect-state.sh grill walk NOT widened by #4096 (design-concept INV-5)", () => {
  test("the grill-candidate list still sources ONLY --label ready-for-agent", () => {
    // The issue's explicit 'Not in scope': widening design_concept_orch's
    // dispatch surface to a second label set needs its own design concept.
    // Pin the walk's single-label sourcing so the orphan-side fix cannot
    // silently become a selector-side widening.
    assert.ok(
      SRC.includes(
        'ORCH_GRILL_LIST_JSON=$(gh issue list --repo gaberoo322/hydra --state open --label ready-for-agent',
      ),
      "the grill-candidate walk must keep sourcing candidates exclusively from the ready-for-agent label (#4096 'Not in scope')",
    );
    // And the walk's gh call must not ALSO filter for the parking label.
    // (#4130 note: the walk's terminator is now a bare `' 2>/dev/null)` — the
    // read is captured for a failure guard, so the old `|| true)` is gone.)
    const walkStart = SRC.indexOf("ORCH_GRILL_LIST_JSON=$(gh issue list");
    const walkEnd = SRC.indexOf("' 2>/dev/null)", walkStart);
    const walk = SRC.slice(walkStart, walkEnd);
    assert.ok(
      !walk.includes("needs-design-concept"),
      "the grill-candidate walk must not gain a needs-design-concept label source (#4096 'Not in scope')",
    );
  });
});

describe("hydra-sweep.md documents the needs-design-concept lane (#4096)", () => {
  const sweep = readFileSync(join(PLAYBOOKS, "hydra-sweep.md"), "utf-8");

  test("the lane exists and states the ready-for-agent co-label rule", () => {
    assert.ok(
      sweep.includes("needs-design-concept"),
      "hydra-sweep.md must document the needs-design-concept lane (issue AC 3: the playbook says the label is only valid alongside ready-for-agent)",
    );
    // The recovery action: additive only — add ready-for-agent, never strip.
    assert.ok(
      /MUST NOT strip `?needs-design-concept`?/.test(sweep),
      "the sweep's recovery action must be additive (design-concept INV-4): it may add ready-for-agent but must not strip needs-design-concept",
    );
  });

  test("hydra-review.md gains no needs-design-concept bucket (INV-6: pick ONE consumer)", () => {
    const review = readFileSync(join(PLAYBOOKS, "hydra-review.md"), "utf-8");
    assert.ok(
      !review.includes("needs-design-concept"),
      "the chosen resolution is the orphan-backstop route EXCLUSIVELY — /hydra-review must not gain a needs-design-concept bucket (issue: 'do not do both silently')",
    );
  });
});
