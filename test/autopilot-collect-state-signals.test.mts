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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // (Post-#4130 the read routes through `_gh_capture orch gh issue list ...`
    // with the result assigned from $GH_CAPTURE_OUT, so the anchors follow
    // that shape — the sourcing label itself is unchanged.)
    assert.ok(
      SRC.includes(
        '_gh_capture orch gh issue list --repo gaberoo322/hydra --state open --label ready-for-agent',
      ),
      "the grill-candidate walk must keep sourcing candidates exclusively from the ready-for-agent label (#4096 'Not in scope')",
    );
    // And the walk's gh call must not ALSO filter for the parking label.
    const walkStart = SRC.indexOf(
      "_gh_capture orch gh issue list --repo gaberoo322/hydra --state open --label ready-for-agent",
    );
    const walkEnd = SRC.indexOf('ORCH_GRILL_LIST_JSON="$GH_CAPTURE_OUT"', walkStart);
    assert.ok(walkEnd >= 0, "grill-walk capture assignment missing");
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

/**
 * Issue #4130 — the `_gh_capture` lane-degraded helper + the OR-composed
 * lane-flag emission.
 *
 * A GraphQL-only GitHub outage (REST healthy, GraphQL 503 — run 161d9642,
 * 2026-08-17) used to silently render every gh-derived board signal as a
 * legitimate-looking `0`/`none`, because every call site folded gh's exit
 * code into its fallback via `2>/dev/null || <zero>`. The one flag that
 * existed to advertise a degraded read (`target_board_signals_degraded`)
 * covered a single block and reported healthy throughout the outage.
 *
 * The fix routes EVERY gh call through one shared bash helper that captures
 * gh's REAL exit code: only a nonzero exit sets the lane's degraded
 * accumulator (a legitimately EMPTY payload with exit 0 is a quiet board,
 * never a degraded one — conflating the two would make a genuinely idle
 * board read permanently degraded), and the two accumulators are emitted
 * once, OR-composed across the whole turn, at the end of the script.
 *
 * These cases extract and run the COMMITTED helper through real bash with a
 * stubbed `gh` on PATH — the same run-the-shipped-logic discipline as the
 * sibling jq-extraction suites above.
 */
describe("collect-state.sh — _gh_capture lane-degraded helper (issue #4130)", () => {
  /** Extract the accumulators + helper function verbatim from the script. */
  function extractHelper(): string {
    const m = SRC.match(
      /ORCH_BOARD_SIGNALS_DEGRADED=false\n[\s\S]*?\n_gh_capture\(\) \{[\s\S]*?\n\}/,
    );
    assert.ok(m, "could not locate the _gh_capture helper in collect-state.sh");
    return m![0];
  }

  type StubMode = "fail" | "ok-empty" | "ok-array" | "fail-on-marker";

  /**
   * Run a bash scenario with the committed helper sourced and a stubbed `gh`
   * on PATH. `fail-on-marker` exits 1 only when the args contain
   * `--fail-marker` (for OR-composition scenarios mixing failures and
   * successes); the other modes are uniform.
   */
  function runScenario(script: string, mode: StubMode): string {
    const dir = mkdtempSync(join(tmpdir(), "gh-capture-4130-"));
    try {
      const bin = join(dir, "bin");
      spawnSync("mkdir", ["-p", bin]);
      const body =
        mode === "fail"
          ? 'echo "HTTP 503: No server is currently available" >&2\nexit 1'
          : mode === "ok-empty"
            ? "exit 0"
            : mode === "ok-array"
              ? 'echo "[]"\nexit 0'
              : 'for a in "$@"; do if [ "$a" = "--fail-marker" ]; then echo "HTTP 503" >&2; exit 1; fi; done\necho "[]"\nexit 0';
      writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, "gh"), 0o755);
      const r = spawnSync(
        "bash",
        ["-c", `set -uo pipefail\n${extractHelper()}\n${script}`],
        {
          encoding: "utf-8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      assert.equal(r.status, 0, `scenario exited non-zero: ${r.stderr}`);
      return (r.stdout ?? "").trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const REPORT =
    'echo "rc=$rc out=\'$GH_CAPTURE_OUT\' orch=$ORCH_BOARD_SIGNALS_DEGRADED target=$TARGET_BOARD_SIGNALS_DEGRADED"';

  test("a nonzero gh exit flips the orch lane flag and returns 1 with empty output", () => {
    const out = runScenario(
      `rc=0\n_gh_capture orch gh issue list --repo x --json number || rc=$?\n${REPORT}`,
      "fail",
    );
    assert.equal(out, "rc=1 out='' orch=true target=false");
  });

  test("a legitimately EMPTY payload with exit 0 never degrades (quiet board != failed read)", () => {
    const out = runScenario(
      `rc=0\n_gh_capture orch gh issue list --repo x --json number || rc=$?\n${REPORT}`,
      "ok-empty",
    );
    assert.equal(out, "rc=0 out='' orch=false target=false");
  });

  test("a successful read captures stdout verbatim and stays healthy", () => {
    const out = runScenario(
      `rc=0\n_gh_capture orch gh issue list --repo x --json number || rc=$?\n${REPORT}`,
      "ok-array",
    );
    assert.equal(out, "rc=0 out='[]' orch=false target=false");
  });

  test("a target-lane failure flips ONLY the target flag", () => {
    const out = runScenario(
      `rc=0\n_gh_capture target gh pr list --repo x || rc=$?\n${REPORT}`,
      "fail",
    );
    assert.equal(out, "rc=1 out='' orch=false target=true");
  });

  test("the lane flag OR-composes: one failed call degrades the turn even when a later call succeeds", () => {
    const out = runScenario(
      [
        "rc=0",
        "_gh_capture orch gh issue list --fail-marker || true",
        "_gh_capture orch gh issue list --repo x || rc=$?",
        REPORT,
      ].join("\n"),
      "fail-on-marker",
    );
    // The second (successful) call must not reset the accumulator, and its
    // output is still captured normally.
    assert.equal(out, "rc=0 out='[]' orch=true target=false");
  });

  test("both lane flags are emitted exactly once, AFTER the last gh call site", () => {
    const orchEmits = SRC.match(
      /^echo "orch_board_signals_degraded=\$\{ORCH_BOARD_SIGNALS_DEGRADED\}"$/gm,
    );
    const targetEmits = SRC.match(
      /^echo "target_board_signals_degraded=\$\{TARGET_BOARD_SIGNALS_DEGRADED\}"$/gm,
    );
    assert.equal(orchEmits?.length, 1, "orch_board_signals_degraded must be emitted exactly once");
    assert.equal(
      targetEmits?.length,
      1,
      "target_board_signals_degraded must be emitted exactly once (the pre-#4130 inline per-block emissions are retired)",
    );
    const emitAt = SRC.indexOf('echo "orch_board_signals_degraded=');
    const lastCall = SRC.lastIndexOf("_gh_capture ");
    assert.ok(
      emitAt > lastCall,
      "the lane-flag emission must come after the last _gh_capture call site, or a late failure would be missed",
    );
  });

  test("no gh board read bypasses the helper (the 10th-call-site drift guard)", () => {
    // A future `gh issue list ...` added bare (command position, not routed
    // through _gh_capture) would silently reintroduce the #4130 defect class.
    // Command positions are: a line starting with `gh `, a `$(gh ...)`
    // substitution, or a pipe into a capture. Comments and jq/string mentions
    // don't match these shapes.
    const lines = SRC.split("\n");
    const offenders = lines.filter((l) => {
      const t = l.trim();
      if (t.startsWith("#")) return false;
      return /^gh (issue|pr|api)\b/.test(t) || /\$\(gh (issue|pr|api)\b/.test(l);
    });
    assert.deepEqual(
      offenders,
      [],
      `every gh board read must route through _gh_capture; found bare call(s): ${offenders.join(" | ")}`,
    );
  });

  test("decide.py consumes the flags via _signal_present in BOTH idle-conclusion sites", () => {
    const decide = readFileSync(join(SCRIPTS, "decide.py"), "utf-8");
    const sites = decide.match(
      /_signal_present\(state, \[\], "orch_board_signals_degraded"\)/g,
    );
    assert.equal(
      sites?.length,
      2,
      "both _check_termination and _rule_idle_fallback must gate on the orch flag",
    );
    const targetSites = decide.match(
      /_signal_present\(\s*state, \[\], "target_board_signals_degraded"\s*\)/g,
    );
    assert.equal(
      targetSites?.length,
      2,
      "both idle-conclusion sites must OR in the target flag (idle_turns is one global counter fed by both lanes)",
    );
  });
});
