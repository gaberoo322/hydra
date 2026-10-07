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
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        'source "$1" && declare -F collect_turn_snapshot_health collect_turn_snapshot_passthrough main orch_glm_withheld',
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
      ["collect_turn_snapshot_health", "collect_turn_snapshot_passthrough", "main", "orch_glm_withheld"],
      "sourcing must not run main (no key=value lines may be emitted)",
    );
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
 * classifier, deleting all three of their heredocs (37 → 34); slice 5 (#4933)
 * ported the HTTP-passthrough collectors, deleting seven more (34 → 27); slice
 * 5B (#4933) ported the last seven collectors it owned (redis queues, scout,
 * arch/cleanup boards, hitl-grill, retro, wayfinder, tickets), deleting six
 * more (27 → 21) — the rest belong to slices 2 and 4. A test rather
 * than a CI workflow: only checks inside the required `test` job can block a merge.
 */
const HEREDOC_CEILING: number = 21;

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

/**
 * ADR-0043 slice 5 (#4933): the health/direction-drift and data-plane
 * passthrough collectors run through the Turn Snapshot CLI. When the CLI
 * cannot run, each wrapper prints a literal fallback that must equal what the
 * strangled bash printed with every read failed — pinned by the golden files
 * test/turn-snapshot-passthrough.test.mts replays.
 */
describe("collect-state.sh Turn Snapshot passthrough wrappers — CLI-failure fallback (#4933)", () => {
  const GOLDEN = join(REPO_ROOT, "test", "fixtures", "turn-snapshot", "passthrough");
  const goldenStdout = (name: string): string =>
    (JSON.parse(readFileSync(join(GOLDEN, `passthrough-${name}.json`), "utf-8")) as { expected: { stdout: string } }).expected.stdout;

  test("node absent from PATH → the all-reads-failed lines plus one note per wrapper, exit 0", () => {
    const bin = mkdtempSync(join(tmpdir(), "ts5-nonode-"));
    try {
      symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
      const r = spawnSync(
        "/usr/bin/bash",
        ["-c", 'source "$1"; collect_turn_snapshot_health; collect_turn_snapshot_passthrough', "_", join(SCRIPTS, "collect-state.sh")],
        { env: { PATH: bin }, encoding: "utf-8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, goldenStdout("group-head-all-failed") + goldenStdout("group-tail-all-failed"));
      assert.match(r.stderr, /orch turn-snapshot health\/direction-drift CLI failed/);
      assert.match(r.stderr, /orch turn-snapshot passthrough CLI failed/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  // Slice 5B (#4933): the boards and retro/wayfinder/tickets wrappers, against
  // the all-reads-failed goldens test/turn-snapshot-remaining.test.mts replays.
  test("slice 5B wrappers: node absent → the all-reads-failed lines, a note each, and the orch lane flagged degraded", () => {
    const remaining = (name: string): string =>
      (JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "turn-snapshot", "remaining", `remaining-${name}.json`), "utf-8")) as {
        expected: { stdout: string };
      }).expected.stdout;
    const bin = mkdtempSync(join(tmpdir(), "ts5b-nonode-"));
    try {
      symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
      const r = spawnSync(
        "/usr/bin/bash",
        [
          "-c",
          'source "$1"; collect_turn_snapshot_boards; collect_turn_snapshot_afk_frontier; echo "ARCH_WORK_QUEUE=$ARCH_WORK_QUEUE ORCH_BOARD_DEGRADED=$ORCH_BOARD_DEGRADED"',
          "_",
          join(SCRIPTS, "collect-state.sh"),
        ],
        { env: { PATH: bin }, encoding: "utf-8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stdout,
        remaining("group-a-all-failed") + remaining("group-b-all-failed") + "ARCH_WORK_QUEUE=1 ORCH_BOARD_DEGRADED=1\n",
      );
      assert.match(r.stderr, /orch turn-snapshot boards CLI failed/);
      assert.match(r.stderr, /orch turn-snapshot retro\/wayfinder\/tickets CLI failed/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("slice 5B boards wrapper: CLI succeeds but the exports file is empty → globals fail CLOSED with a note each", () => {
    // A fake `node` that prints kv lines but never writes --exports-file.
    const bin = mkdtempSync(join(tmpdir(), "ts5b-noexports-"));
    try {
      for (const tool of ["dirname", "mktemp", "rm"]) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
      writeFileSync(join(bin, "node"), "#!/usr/bin/bash\necho work_queue=0\n");
      chmodSync(join(bin, "node"), 0o755);
      const r = spawnSync(
        "/usr/bin/bash",
        ["-c", 'source "$1"; ORCH_BOARD_DEGRADED=0; collect_turn_snapshot_boards; echo "ARCH_WORK_QUEUE=$ARCH_WORK_QUEUE ORCH_BOARD_DEGRADED=$ORCH_BOARD_DEGRADED"', "_", join(SCRIPTS, "collect-state.sh")],
        { env: { PATH: bin }, encoding: "utf-8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "work_queue=0\nARCH_WORK_QUEUE=1 ORCH_BOARD_DEGRADED=1\n", "a non-zero work queue keeps target_backfill_idle from firing");
      assert.match(r.stderr, /carried no ARCH_WORK_QUEUE/);
      assert.match(r.stderr, /carried no ORCH_BOARD_DEGRADED/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
