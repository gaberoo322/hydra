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
 * The behavioural pins for the orphan predicate (both directions) moved with
 * the collector to test/turn-snapshot-orch-board.test.mts (ADR-0043 slice 2,
 * #4930); this file keeps the grill-walk and playbook pins below.
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

/**
 * Ratchet: collect-state.sh may not gain inline Python heredocs (ADR-0043
 * Decision 6). ADR-0043 strangles collect-state.sh into the typed Turn
 * Snapshot module (src/autopilot/turn-snapshot/), one collector per slice, and
 * a new signal is written as a TS collector even beside a still-bash one.
 *
 * HEREDOC_CEILING is shrink-only: a slice that deletes heredocs lowers it to
 * the new count in the same PR; raising it is not an escape hatch. The initial
 * 37 was master's 35 plus the two heredocs PR #4860 (#4812) added, which
 * predated the ADR; slice 1 (#4929) ported that collector with the PR-gate
 * classifier, deleting all three of their heredocs (37 → 34). A test rather
 * than a CI workflow: only checks inside the required `test` job can block a merge.
 * Slice 2 (#4930) moved the orch board collector, deleting its two (34 → 32).
 */
const HEREDOC_CEILING: number = 32;

/** A python heredoc opener: `<<PY`, `<<'PY'` or `<<"PY"`. */
function countPythonHeredocs(source: string): number {
  return source.match(/<<\s*['"]?PY['"]?/g)?.length ?? 0;
}

describe("collect-state.sh python-heredoc ratchet (ADR-0043 Decision 6)", () => {
  test("the counter recognises every quoting form (guards a vacuous pass)", () => {
    assert.equal(countPythonHeredocs(`a <<PY\nb <<'PY'\nc <<"PY"\nd << 'PY'\n`), 4);
    assert.equal(countPythonHeredocs("python3 scripts/autopilot/pr-refs.py --closing\n"), 0);
  });

  test("the heredoc count does not exceed the ceiling", () => {
    const count = countPythonHeredocs(readFileSync(join(SCRIPTS, "collect-state.sh"), "utf8"));
    assert.ok(count > 0 || HEREDOC_CEILING === 0, "collect-state.sh parsed to zero heredocs: lower HEREDOC_CEILING to 0 or check the path");
    assert.ok(
      count <= HEREDOC_CEILING,
      `collect-state.sh has ${count} python heredocs; the ceiling is ${HEREDOC_CEILING}.\n` +
        `ADR-0043 Decision 6: a new signal is a Turn Snapshot collector in src/autopilot/turn-snapshot/, ` +
        `not a new heredoc. Move the logic into TS instead of raising HEREDOC_CEILING.`,
    );
  });
});
