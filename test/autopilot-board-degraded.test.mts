/**
 * Regression test for issue #4130 — a GraphQL-only GitHub outage silently
 * degrades every board signal to zero/none, and the autopilot reads that as
 * "no work".
 *
 * Failure chain being pinned:
 *
 *   GraphQL 503 → every guarded `gh issue list --json` / `gh pr list --json`
 *   read in collect-state.sh exits non-zero with empty stdout → the
 *   best-effort guards (`2>/dev/null || true`, `|| echo ''`, `|| echo
 *   '{…zeros…}'`) laundered the failure into a legitimate-looking empty board
 *   → the model stitches zeros into state.signals → decide.py's idle
 *   termination (occupied==0 + idle_turns exhausted) called a BLIND drain a
 *   clean `idle`, and the ARCH emitter even computed `orch_backfill_idle=true`
 *   off manufactured zeros (the inverse hazard: an outage looked like an empty
 *   board worth backfilling).
 *
 * Detection design (why payload validation, not exit codes): a successful
 * `gh ... --json --jq` NEVER prints empty (jq emits at least `[]` / `{}`), so
 * "payload parses as JSON of the expected shape" separates failed reads
 * (empty / partial / error-fragment / wrong-shape stdout) from genuine results
 * under every observed failure shape. Exit-0-with-valid-`[]` is a genuinely
 * empty board and behaves exactly as before — AC (d).
 *
 * Coverage mirrors the issue's four AC groups:
 *   (a) a failed read never renders as 0/none — the validator + the
 *       zero-emitting fallback arms + the flag emission;
 *   (b) a degraded snapshot suppresses terminate:idle → `board_degraded`
 *       (decide.py's two idle sites + term-check.py's idle branch);
 *   (c) a degraded snapshot suppresses the orch_backfill_idle backfill
 *       classes (discover — including its #4114 staleness floor —
 *       architecture, cleanup, skill_prune);
 *   (d) a genuinely empty board behaves exactly as today (`[]` validates,
 *       idle stays `idle`, backfill still fires on a real idle board).
 *
 * decide.py / term-check.py are exercised through their real CLIs (the
 * subprocess pattern of test/autopilot-decide.test.mts /
 * test/autopilot-scripts.test.mts); collect-state.sh's validator and ARCH
 * emitter are extracted verbatim from the committed source and run through
 * real python3 (the #3728/#3817/#4025 extractor precedent).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const DECIDE = join(SCRIPTS, "decide.py");
const TERM_CHECK = join(SCRIPTS, "term-check.py");
const SRC = readFileSync(join(SCRIPTS, "collect-state.sh"), "utf-8");

// ---------------------------------------------------------------------------
// collect-state.sh: the payload validator, extracted verbatim
// ---------------------------------------------------------------------------

/** Extract the committed gh_payload_is() function body from the script. */
function extractValidator(): string {
  const start = SRC.indexOf("gh_payload_is() {");
  assert.ok(start >= 0, "gh_payload_is() missing from collect-state.sh");
  // The function body embeds a python heredoc whose dict closes with a
  // column-0 `}` — anchor the real function close on the `' "$@"` sentinel
  // line instead of the first `\n}`.
  const sentinel = SRC.indexOf("' \"$@\"", start);
  assert.ok(sentinel >= 0, "gh_payload_is() body is missing its argv pass-through");
  const end = SRC.indexOf("\n}", sentinel);
  assert.ok(end >= 0, "gh_payload_is() is never closed");
  return SRC.slice(start, end + 2);
}

function validate(input: string, shape: string): boolean {
  const r = spawnSync("bash", ["-c", extractValidator() + `; gh_payload_is ${shape}`], {
    input,
    encoding: "utf-8",
  });
  return r.status === 0;
}

describe("collect-state.sh — gh_payload_is payload validation (AC a)", () => {
  test("a GraphQL-outage-shaped read (empty stdout) FAILS validation for every shape", () => {
    for (const shape of ["list", "board_counts", "target_counts", "arch_counts"]) {
      assert.ok(
        !validate("", shape),
        `empty payload must fail the ${shape} check — an outage is not a ${shape} result`,
      );
    }
  });

  test("an error fragment (non-JSON stdout) FAILS validation", () => {
    // gh can emit a partial/error line on some failure shapes; the old
    // `[ -n "$X" ]` gate passed it straight through.
    assert.ok(!validate("gh: GraphQL: HTTP 503", "list"));
    assert.ok(!validate("gh: Not Found", "list"));
  });

  test("valid JSON of the WRONG shape fails (a list is not a counts object)", () => {
    assert.ok(!validate("[]", "board_counts"));
    assert.ok(!validate("{}", "list"));
    assert.ok(!validate('{"ready_for_agent":0}', "board_counts"));
  });

  test("a genuinely empty board (`[]`) VALIDATES — empty is a real result, not a failure (AC d)", () => {
    assert.ok(validate("[]", "list"), "exit-0 with `[]` is a legitimately empty board");
  });

  test("the four committed shapes validate their canonical payloads", () => {
    assert.ok(validate('[{"number":1}]', "list"));
    assert.ok(
      validate(
        '{"needs_qa":0,"ready_for_agent":0,"needs_triage":0,"needs_research":0,' +
          '"in_progress":0,"blocked":0,"stale_in_progress":[],"stale_blocked":[]}',
        "board_counts",
      ),
    );
    assert.ok(
      validate(
        '{"target_ready_for_agent":0,"target_needs_qa":0,"target_needs_triage":0,"target_needs_research":0}',
        "target_counts",
      ),
    );
    assert.ok(
      validate(
        '{"ready_for_agent":0,"needs_research":0,"needs_triage":0,"arch_sourced":0,"cleanup_sourced":0}',
        "arch_counts",
      ),
    );
  });
});

describe("collect-state.sh — failed reads stamp degradation instead of laundering zeros (AC a/AC 2)", () => {
  test("the orch counts fallback validates its payload and stamps ORCH_COUNTS_DEGRADED on failure", () => {
    const arm = SRC.slice(SRC.indexOf("ORCH_COUNTS_FALLBACK="));
    assert.match(arm.slice(0, 1800), /gh_payload_is board_counts/, "the fallback payload must be validated");
    assert.match(arm.slice(0, 1800), /ORCH_COUNTS_DEGRADED=1/, "a failed read must stamp the degraded marker");
    // The zero-emit keeps the 8-key shape — consumers never see a missing key,
    // but the zeros are now attributable to an outage via the flag.
    assert.match(
      arm.slice(0, 1800),
      /\{"needs_qa":0,"ready_for_agent":0,"needs_triage":0,"needs_research":0,"in_progress":0,"blocked":0,"stale_in_progress":\[\],"stale_blocked":\[\]\}/,
      "a failed read emits the shape-preserving all-zero object",
    );
  });

  test("the target counts fallback no longer manufactures unattributable zeros", () => {
    const arm = SRC.slice(SRC.indexOf("TARGET_COUNTS_FALLBACK="));
    assert.match(arm.slice(0, 1800), /gh_payload_is target_counts/);
    assert.match(arm.slice(0, 1800), /TARGET_COUNTS_DEGRADED=1/);
    assert.match(arm.slice(0, 1800), /echo "target_ready_for_agent=0"/);
    assert.match(arm.slice(0, 1800), /echo "target_needs_research=0"/);
  });

  test("the in-flight PR read and the grill walk are validated (their failures yield false zeros/nones)", () => {
    assert.match(SRC, /ORCH_INFLIGHT_DEGRADED=0/, "in-flight read must carry a degraded marker");
    assert.match(SRC, /ORCH_GRILL_DEGRADED=0/, "grill walk must carry a degraded marker");
    const inflight = SRC.slice(SRC.indexOf("ORCH_INFLIGHT_PR_JSON="));
    assert.match(inflight.slice(0, 600), /gh_payload_is list/);
    const grill = SRC.slice(SRC.indexOf("ORCH_GRILL_LIST_JSON=$(gh issue list"));
    assert.match(grill.slice(0, 700), /gh_payload_is list/);
  });

  test("orch_board_signals_degraded is emitted on BOTH branches, folded from all four reads", () => {
    assert.match(SRC, /echo "orch_board_signals_degraded=true"/);
    assert.match(SRC, /echo "orch_board_signals_degraded=false"/);
    const emit = SRC.slice(SRC.indexOf('if [ "$ORCH_COUNTS_DEGRADED" = "1" ]'));
    const block = emit.slice(0, 1200);
    for (const marker of [
      "ORCH_COUNTS_DEGRADED",
      "ORCH_INFLIGHT_DEGRADED",
      "ORCH_GRILL_DEGRADED",
      "ARCH_BOARD_DEGRADED",
    ]) {
      assert.ok(
        block.includes(`"$${marker}"`),
        `${marker} must fold into the orch_board_signals_degraded emit`,
      );
    }
  });

  test("the ARCH board read no longer substitutes an all-zero board on failure (the inverse-hazard source)", () => {
    // The pre-#4130 arm was `|| echo '{"ready_for_agent":0,…}'` — a failed
    // read became a fully-idle board and the emitter computed
    // orch_backfill_idle=true off it. The manufactured-zeros fallback must be
    // gone; the degraded arm (validation + ARCH_BOARD_DEGRADED) replaced it.
    assert.doesNotMatch(
      SRC,
      /\|\| echo '\{"ready_for_agent":0,"needs_research":0,"needs_triage":0,"arch_sourced":0,"cleanup_sourced":0\}'\)/,
      "the || echo zeros arm manufactured a fake idle board on outage — removed by #4130",
    );
    const arm = SRC.slice(SRC.indexOf("ARCH_BOARD_JSON=$(gh issue list"));
    assert.match(arm.slice(0, 1200), /gh_payload_is arch_counts/);
    assert.match(arm.slice(0, 1600), /ARCH_BOARD_DEGRADED=1/);
  });

  test("the target lane gate validates the payload — a non-empty error fragment no longer passes as readable", () => {
    // The old gate was `[ -n "$TARGET_BOARD_ISSUES_JSON" ]`, which printed
    // target_board_signals_degraded=false BEFORE the python except arm could
    // react. The gate must now be shape validation.
    assert.doesNotMatch(SRC, /if \[ -n "\$TARGET_BOARD_ISSUES_JSON" \]/);
    const gate = SRC.slice(SRC.indexOf("TARGET_BOARD_ISSUES_JSON=$(gh issue list"));
    assert.match(gate.slice(0, 1200), /gh_payload_is list/);
  });

  test("target_board_signals_degraded flips true when the COUNTS fallback failed even if the lane read succeeded", () => {
    // AC 2: the flag must actually flip in the degraded scenario. The counts
    // read and the lane read are separate gh calls; either failing must flip
    // the lane flag, not just the lane read's own gate.
    const gate = SRC.slice(SRC.indexOf("TARGET_BOARD_ISSUES_JSON=$(gh issue list"));
    const head = gate.slice(0, 1500);
    assert.match(head, /TARGET_COUNTS_DEGRADED" = "1"/, "the counts-failure folds into the lane flag");
  });
});

// ---------------------------------------------------------------------------
// decide.py — degraded snapshot is never concluded idle (AC b), never
// backfilled (AC c), and a genuine empty board is unchanged (AC d)
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-board-degraded-test-"));
  return { dir, state: join(dir, "state.json"), cands: join(dir, "candidates.json"), events: join(dir, "events.json") };
}

function baseState(o: Record<string, unknown> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      context_compaction_turns: 0,
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
    signals: {},
    research_force_counter: {},
    ...o,
  };
}

function runDecide(state: any, events: any[] = []): any {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(null));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
      encoding: "utf-8",
      env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function terminateAction(plan: any): any | undefined {
  return (plan.actions ?? []).find((a: any) => a.type === "terminate");
}

function dispatchSkills(plan: any): string[] {
  return (plan.actions ?? []).filter((a: any) => a.type === "dispatch").map((a: any) => a.skill);
}

describe("decide.py — idle-shaped termination under a degraded board (AC b)", () => {
  test("idle_turns exhausted + degraded flag → terminate cause board_degraded, NEVER idle", () => {
    // The motivating scenario: GraphQL outage → every board read failed →
    // occupied slots read 0 (in-flight read failed) → idle drain reached.
    const plan = runDecide(
      baseState({ idle_turns: 5, signals: { orch_board_signals_degraded: true } }),
    );
    const term = terminateAction(plan);
    assert.ok(term, "the turn must still terminate — a wait-only print-mode turn cannot wait (#1352)");
    assert.equal(term.cause, "board_degraded");
    assert.notEqual(term.cause, "idle", "a blind drain must never be recorded as a clean idle");
    assert.match(term.reason, /degraded/);
  });

  test("wait-only idle fallback (issue #1352 path) re-causes to board_degraded when degraded", () => {
    // Fresh state, no idle_turns: the #1352 wait-only terminate site.
    const plan = runDecide(
      baseState({ signals: { orch_board_signals_degraded: true } }),
    );
    const term = terminateAction(plan);
    assert.ok(term);
    assert.equal(term.cause, "board_degraded");
    assert.equal(plan.debug?.idle_fallback, "terminate");
    assert.equal(plan.debug?.board_degraded, true);
  });

  test("the flag is read from the events seam too (purity: either pre-resolved source)", () => {
    const plan = runDecide(baseState({ idle_turns: 5 }), [
      { type: "signal", name: "orch_board_signals_degraded", value: true },
    ]);
    const term = terminateAction(plan);
    assert.ok(term);
    assert.equal(term.cause, "board_degraded");
  });

  test("flag=false (explicitly healthy) keeps the historical clean idle — AC d", () => {
    const plan = runDecide(
      baseState({ idle_turns: 5, signals: { orch_board_signals_degraded: false } }),
    );
    const term = terminateAction(plan);
    assert.ok(term);
    assert.equal(term.cause, "idle", "a genuinely read empty board still drains as a clean idle");
  });

  test("flag ABSENT keeps the pre-#4130 behaviour exactly — AC d", () => {
    const plan = runDecide(baseState({ idle_turns: 5 }));
    const term = terminateAction(plan);
    assert.ok(term);
    assert.equal(term.cause, "idle");
    assert.equal(term.reason, "idle_turns=5");
  });

  test("a budget trip on a degraded turn still reports budget (cause precedence unchanged)", () => {
    // quota/budget/wall_clock stay ahead of the idle check: the degraded
    // re-causing must not swallow a more diagnostic cause.
    const plan = runDecide(
      baseState({
        cumulative_tokens: 2_000_001,
        idle_turns: 5,
        signals: { orch_board_signals_degraded: true },
      }),
    );
    const term = terminateAction(plan);
    assert.ok(term);
    assert.equal(term.cause, "budget");
  });
});

describe("decide.py — degraded board suppresses the orch_backfill_idle classes (AC c)", () => {
  // A board that genuinely reads idle, with cooldowns elapsed so every
  // backfill class is eligible — the ONLY difference between the paired
  // cases is the degraded flag.
  const idleSignals = { orch_backfill_idle: true };
  const now = Math.floor(Date.now() / 1000);
  const cooledState = (signals: Record<string, unknown>) =>
    baseState({
      signals,
      signal_last_fired: {
        discover_orch: 0,
        architecture_orch: 0,
        cleanup_orch: 0,
        skill_prune: 0,
        health: 0, sweep_orch: 0, sweep_target: 0, discover_target: 0,
      },
      started_epoch: now - 3600,
    });

  test("healthy idle board still dispatches the backfill set — AC d", () => {
    const plan = runDecide(cooledState(idleSignals));
    const skills = dispatchSkills(plan);
    assert.ok(
      skills.includes("hydra-discover") || skills.includes("hydra-architecture-scan"),
      `an idle-but-read board must still backfill (got: ${skills.join(", ")})`,
    );
  });

  test("degraded + orch_backfill_idle=true dispatches NONE of the four backfill classes", () => {
    const plan = runDecide(cooledState({ ...idleSignals, orch_board_signals_degraded: true }));
    const skills = dispatchSkills(plan);
    for (const skill of ["hydra-discover", "hydra-architecture-scan", "hydra-cleanup", "hydra-skill-prune"]) {
      assert.ok(
        !skills.includes(skill),
        `${skill} must not fire off a degraded board — orch_backfill_idle=true there means UNREAD, not idle`,
      );
    }
  });

  test("degraded also suppresses discover_orch's #4114 staleness-floor path", () => {
    // discover_orch has a second trigger (dark > 7d) that would otherwise
    // fire while blind. Discover has never fired (signal_last_fired=0), so
    // the floor is trivially past — only the degraded flag holds it back.
    const plan = runDecide(
      cooledState({ orch_board_signals_degraded: true }),
    );
    const skills = dispatchSkills(plan);
    assert.ok(
      !skills.includes("hydra-discover"),
      "discovery must not file speculative work against a board it could not read",
    );
  });
});

// ---------------------------------------------------------------------------
// term-check.py — the Phase-3 mirror (AC b)
// ---------------------------------------------------------------------------

describe("term-check.py — idle branch re-caused under degradation (AC b)", () => {
  function runTermCheck(state: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-term-degraded-"));
    try {
      const statePath = join(dir, "state.json");
      writeFileSync(statePath, JSON.stringify({
        started_epoch: Math.floor(Date.now() / 1000) - 60,
        limits: {
          token_budget: 2_000_000,
          wall_clock_max_sec: 28_800,
          idle_drain_turns: 5,
          scope: "all",
          subagent_max_tokens: 400_000,
          subagent_hard_max_tokens: 800_000,
        },
        cumulative_tokens: 0,
        idle_turns: 5,
        slots: {
          dev_orch: null, qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
        signal_last_fired: {},
        failure_log: [],
        ...state,
      }));
      const r = spawnSync(TERM_CHECK, [], {
        env: { ...process.env, HYDRA_AUTOPILOT_STATE: statePath, HYDRA_API_BASE: "http://127.0.0.1:1" },
        encoding: "utf-8",
      });
      return (r.stdout ?? "").trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("idle drain reached + degraded flag → TERM:board_degraded, not TERM:idle", () => {
    const out = runTermCheck({ signals: { orch_board_signals_degraded: true } });
    assert.match(out, /^TERM:board_degraded /);
    assert.notEqual(out.slice(0, 10), "TERM:idle", "the Phase-3 pre-check must not call a blind drain clean either");
  });

  test("idle drain reached without the flag → TERM:idle unchanged — AC d", () => {
    const out = runTermCheck({});
    assert.match(out, /^TERM:idle /);
  });
});

// ---------------------------------------------------------------------------
// The cause is a first-class citizen end-to-end
// ---------------------------------------------------------------------------

describe("board_degraded cause wiring (AC 4: visible in the run record)", () => {
  test("src/autopilot/runs.ts accepts board_degraded as a valid term_reason (not normalised to unknown)", () => {
    const runs = readFileSync(join(REPO_ROOT, "src", "autopilot", "runs.ts"), "utf-8");
    assert.match(
      runs,
      /"board_degraded",/,
      "VALID_TERM_REASONS must whitelist board_degraded or recordRunEnd silently renames it to unknown",
    );
    // It is a CLEAN stop, not a crash-adjacent one — no crash_detail noise.
    const crashSet = runs.slice(runs.indexOf("CRASH_TERM_REASONS"), runs.indexOf("]", runs.indexOf("CRASH_TERM_REASONS")));
    assert.ok(
      !crashSet.includes("board_degraded"),
      "a board_degraded drain is clean (like idle) — it must not join the crash-detail set",
    );
  });

  test("the playbook documents the signal row and the termination cause", () => {
    const playbook = readFileSync(join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md"), "utf-8");
    assert.match(playbook, /orch_board_signals_degraded/, "the Signal wiring table must document the new flag");
    assert.match(playbook, /board_degraded/, "the termination section must name the new cause");
  });
});
