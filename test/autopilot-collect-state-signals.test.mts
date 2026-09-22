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
    const walkStart = SRC.indexOf("ORCH_GRILL_LIST_JSON=$(gh issue list");
    const walkEnd = SRC.indexOf("2>/dev/null || true)", walkStart);
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

describe("collect-state.sh function decomposition ratchet (#4266)", () => {
  // Design-concept issue-4266 INV-2/INV-3/INV-8: the script was a 2.5k-line flat
  // body. Every collector is now a named `collect_*` function, `main` calls them
  // in the emit order, and `main` runs only when executed (never when sourced).
  // These pin that shape so the script cannot silently regress to a flat body.
  const SCRIPT_PATH = join(SCRIPTS, "collect-state.sh");
  const definedCollectors = [...SRC.matchAll(/^(collect_[a-z0-9_]+)\(\) \{$/gm)].map((m) => m[1]);

  test("defines a main function plus at least 12 collect_ functions", () => {
    assert.match(SRC, /^main\(\) \{$/m, "collect-state.sh must define main()");
    assert.ok(
      definedCollectors.length >= 12,
      `expected >= 12 collect_* functions, found ${definedCollectors.length}`,
    );
  });

  test("ends with the BASH_SOURCE-guarded main call", () => {
    assert.ok(
      SRC.trimEnd().endsWith('if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then\n  main "$@"\nfi'),
      "collect-state.sh must end with the BASH_SOURCE-guarded `main \"$@\"` invocation",
    );
  });

  test("main calls every defined collector exactly once, in definition order", () => {
    const mainBody = SRC.match(/^main\(\) \{\n([\s\S]*?)\n\}$/m);
    assert.ok(mainBody, "could not locate the main() body");
    const calls = mainBody[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    assert.deepEqual(calls, definedCollectors, "a collector that main never calls emits nothing");
  });

  test("sourcing the script defines the collectors but emits no signal lines", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$1" && declare -F collect_health collect_slot_events main orch_glm_withheld',
        "_",
        SCRIPT_PATH,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );
    // orch_glm_withheld is in the list on purpose: a helper NESTED inside a
    // collector only exists after that collector runs, so `declare -F` finding
    // it right after sourcing (no collector called) proves it is top-level
    // (design-concept INV-2).
    assert.equal(r.status, 0, `sourcing failed (or a helper is not top-level): ${r.stderr}`);
    assert.deepEqual(
      (r.stdout ?? "").trim().split("\n"),
      ["collect_health", "collect_slot_events", "main", "orch_glm_withheld"],
      "sourcing must not run main (no key=value lines may be emitted)",
    );
  });
});

// ---------------------------------------------------------------------------
// issue #4584 — retro_run_drillable reads the bundle's run-level `runFlagged`
// ---------------------------------------------------------------------------

/** Extract the committed retro_run_drillable python predicate verbatim. */
function extractDrillablePredicate(): string {
  const anchor = SRC.indexOf("/autopilot/runs/${RETRO_CANDIDATE_RUN_ID}/retro");
  assert.ok(anchor >= 0, "retro_run_drillable bundle read missing from collect-state.sh");
  const open = SRC.indexOf("<<'PY'\n", anchor);
  assert.ok(open >= 0, "retro_run_drillable python heredoc missing");
  const start = open + "<<'PY'\n".length;
  const end = SRC.indexOf("\nPY\n", start);
  assert.ok(end >= 0, "retro_run_drillable python heredoc never closed");
  return SRC.slice(start, end);
}

/** Run the committed predicate on a bundle through real python3. */
function drillable(bundle: unknown): string {
  const r = spawnSync("python3", ["-c", extractDrillablePredicate()], {
    input: JSON.stringify(bundle),
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `drillable predicate failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** A run-found crash bundle with every legacy drill trigger empty. */
function emptyBundle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runFound: true,
    run: { run_id: "run-4584", term_reason: "crash", crash_detail: { exit_code: 1 } },
    dispatches: [{ cycleId: "", flagged: false, undrillable: true, abandonReason: "run-crash" }],
    reflections: [],
    stuckSignals: [],
    recommendations: [],
    ...over,
  };
}

describe("collect-state.sh retro_run_drillable reads runFlagged (#4584)", () => {
  test("runFlagged=true with everything else empty -> true", () => {
    assert.equal(drillable(emptyBundle({ runFlagged: true, runFlagReason: "crash" })), "true");
  });

  test("runFlagged absent with everything else empty -> false (older server; no shell re-derivation)", () => {
    // The run view says crash — but the shell must NOT inspect term_reason /
    // crash_detail itself; only the TS-computed runFlagged counts.
    assert.equal(drillable(emptyBundle()), "false");
  });

  test("runFlagged=false with everything else empty -> false", () => {
    assert.equal(drillable(emptyBundle({ runFlagged: false, runFlagReason: null })), "false");
  });

  test("runFlagged truthy-but-not-true (string) -> false", () => {
    assert.equal(drillable(emptyBundle({ runFlagged: "true" })), "false");
  });

  test("runFound=false still degrades to true (#4244 regression)", () => {
    assert.equal(drillable(emptyBundle({ runFound: false, runFlagged: false })), "true");
  });

  test("the predicate never reads term_reason or crash_detail directly", () => {
    const py = extractDrillablePredicate();
    assert.ok(!py.includes("term_reason"), "shell predicate must not re-derive from term_reason");
    assert.ok(!py.includes("crash_detail"), "shell predicate must not re-derive from crash_detail");
    assert.ok(py.includes("b.get('runFlagged') is True"), "predicate reads the bundle's runFlagged");
  });
});
