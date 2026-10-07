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
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createTurnSnapshotGithub } from "../src/autopilot/turn-snapshot/github-port.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const PLAYBOOKS = join(REPO_ROOT, "docs", "operator-playbooks");

const SRC = readFileSync(join(SCRIPTS, "collect-state.sh"), "utf-8");

describe("collect-state.sh grill walk NOT widened by #4096 (design-concept INV-5)", () => {
  test("the grill-candidate list still sources ONLY --label ready-for-agent", async () => {
    // The issue's explicit 'Not in scope': widening design_concept_orch's
    // dispatch surface to a second label set needs its own design concept.
    // Pin the walk's single-label sourcing so the orphan-side fix cannot
    // silently become a selector-side widening. Since ADR-0043 slice 3 (#4931)
    // the walk's read is the Turn Snapshot port's listReadyForAgentIssues:
    // assert the exact gh argv it issues.
    const seen: string[][] = [];
    const port = createTurnSnapshotGithub({
      repo: "owner/repo",
      transport: async (args) => {
        seen.push(args);
        return { ok: true, stdout: "[]", stderr: "" };
      },
    });
    await port.listReadyForAgentIssues(100);
    assert.equal(seen.length, 1);
    const labels = seen[0].flatMap((a, i) => (a === "--label" ? [seen[0][i + 1]] : []));
    assert.deepEqual(labels, ["ready-for-agent"], "the grill-candidate walk must keep sourcing candidates exclusively from the ready-for-agent label (#4096 'Not in scope')");
    assert.ok(
      !seen[0].join(" ").includes("needs-design-concept"),
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

  test("defines a main function plus at least 9 collect_ functions", () => {
    // The #4266 floor guards against re-inlining the collectors into one
    // monolith. ADR-0043 strangles collect-state.sh into the Turn Snapshot CLI,
    // and each slice folds several collect_* functions into one wrapper, so the
    // floor is LOWERED to the measured count as slices land (slice 5B #4933:
    // 12 → 10; slice 4 #4932 folded the three Target collectors into two
    // wrappers: 10 → 9) — never raised to force bash back in.
    assert.match(SRC, /^main\(\) \{$/m, "collect-state.sh must define main()");
    assert.ok(
      definedCollectors.length >= 9,
      `expected >= 9 collect_* functions, found ${definedCollectors.length}`,
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
        'source "$1" && declare -F collect_turn_snapshot_health collect_turn_snapshot_passthrough main',
        "_",
        SCRIPT_PATH,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );
    // The list once carried the orch_glm_withheld helper to prove it was
    // top-level (design-concept INV-2); that helper moved into the typed picks
    // collector with ADR-0043 slice 3 (#4931), so only the collectors remain.
    assert.equal(r.status, 0, `sourcing failed (or a helper is not top-level): ${r.stderr}`);
    assert.deepEqual(
      (r.stdout ?? "").trim().split("\n"),
      ["collect_turn_snapshot_health", "collect_turn_snapshot_passthrough", "main"],
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
 * classifier, deleting all three of their heredocs (37 → 34); slice 3 (#4931)
 * moved the grill/dev-ready picks, Candidate Exclusions, merged-PR set and
 * active_dev_orch collectors, deleting ten more (34 → 24); slice
 * 5B (#4933) ported the last seven collectors it owned (redis queues, scout,
 * arch/cleanup boards, hitl-grill, retro, wayfinder, tickets), deleting six
 * more (15 → 9) — the rest belonged to slice 4 (#4932), which ported the
 * Target board family (target board, scan boards, risk surface) and deleted
 * the last nine (9 → 0). A test rather
 * than a CI workflow: only checks inside the required `test` job can block a merge.
 * Slice 2 (#4930) moved the orch board collector, deleting its two (24 → 22
 * once merged after slice 3). Slice 5 PR A (#4933) moved the HTTP-passthrough
 * collectors (health, scout alerts, realm share, capacity, scheduler,
 * recommendations), deleting seven more (22 → 15).
 */
const HEREDOC_CEILING: number = 0;

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
