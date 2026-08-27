/**
 * Regression tests for issue #4130 — a GraphQL-only GitHub outage must not
 * masquerade as a quiet board.
 *
 * The outage shape (measured live 2026-08-17): `gh issue list` / `gh pr list`
 * ride the GraphQL API, so a GraphQL-only 503 takes out every board read while
 * REST and everything else stays up. collect-state.sh's documented fail-closed
 * fallbacks then rendered the whole board as zeros/`none`s — a legitimately
 * EMPTY-looking board — and decide.py read that as "no work": idle-terminated
 * runs and orch_backfill_idle-driven backfill dispatches against a board the
 * collector could not see (a true ready_for_agent of 34 rendered as 0).
 *
 * The fix has two halves, each pinned here:
 *
 *   1. collect-state.sh — every orch-lane board read folds a per-lane degraded
 *      counter (ORCH_BOARD_DEGRADED / TARGET_BOARD_DEGRADED), emitted as the
 *      aggregate `orch_board_signals_degraded` / (existing)
 *      `target_board_signals_degraded` flag lines; a FAILED read never renders
 *      a value that ACTIVATES a dispatch or an idle conclusion (the board-counts
 *      JSON and the four target_* counts are simply not emitted; the arch board
 *      read flips to orch_backfill_idle=false + both saturation caps true).
 *   2. decide.py — reads the pre-resolved `orch_board_signals_degraded` flag
 *      (pure, exactly like every other collect-state-owned signal) and declines
 *      to conclude idle on a flagged snapshot: no terminate:idle, no
 *      orch_backfill_idle-keyed backfill classes.
 *
 * The collect-state half runs the WHOLE script against a stub-bin PATH (a gh
 * stub that either fails outright or emulates `--json [--jq PROG]` over a fixed
 * `[]` payload by piping it through REAL jq — gh evaluates --jq client-side, so
 * the stub reproduces that contract and every read site gets its authentic
 * empty-board render). hydra/docker/curl/systemctl stubs fail in both modes so
 * the run needs no orchestrator, no Redis, and no network. The decide half
 * drives the `decide` CLI with hand-built state fixtures, mirroring
 * test/autopilot-decide.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// ---------------------------------------------------------------------------
// Part 1 — collect-state.sh end-to-end against a stub-bin PATH
// ---------------------------------------------------------------------------

/**
 * Build a stub bin dir. `mode`:
 *   - "fail"  — gh exits 1 with no output (the GraphQL-only outage), and the
 *               other network-touching binaries fail too.
 *   - "empty" — gh emulates a SUCCESSFUL read of a GENUINELY EMPTY board (the
 *               `[]` payload); hydra/docker/curl/systemctl still fail, which
 *               routes every read through the direct-gh fallback paths #4130
 *               touched — so the two modes are a clean A/B over those arms.
 */
function makeStubBin(mode: "fail" | "empty"): string {
  const bin = mkdtempSync(join(tmpdir(), "collect-state-stub-"));
  const ghBody =
    mode === "fail"
      ? "#!/usr/bin/env bash\n# issue #4130 stub: the GraphQL API is down.\nexit 1\n"
      : `#!/usr/bin/env bash
# issue #4130 stub: emulate \`gh <issue|pr> list --json FIELDSET [--jq PROG]\`
# over a fixed empty-board payload. gh evaluates --jq client-side over the JSON
# result, so the stub pipes the payload through REAL jq when the caller passed
# a program — every read site then gets its authentic empty-board render.
# \`-r\` matters: gh prints STRING jq results raw (unquoted), plain jq
# JSON-encodes them — without it the target-count lines would render as
# \`"target_ready_for_agent=0"\` and diverge from real gh.
payload="[]"
prog=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then prog="$a"; fi
  prev="$a"
done
if [ -n "$prog" ]; then
  printf '%s' "$payload" | jq -r "$prog"
else
  printf '%s\\n' "$payload"
fi
`;
  writeFileSync(join(bin, "gh"), ghBody, { mode: 0o755 });
  for (const name of ["hydra", "docker", "curl", "systemctl"]) {
    writeFileSync(join(bin, name), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  }
  return bin;
}

function runCollectState(bin: string): { status: number | null; lines: string[] } {
  const r = spawnSync("bash", [COLLECT], {
    encoding: "utf-8",
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // Deterministic direction-drift: no live Target checkout to compare
      // against, so the collector's fail-closed no-drift branch always wins.
      HYDRA_TARGET_REPO: "/nonexistent-collect-state-test-target",
      HYDRA_CONFIG_PATH: join(REPO_ROOT, "config"),
    },
  });
  assert.equal(r.status, 0, `collect-state.sh must stay best-effort (stderr: ${r.stderr})`);
  return { status: r.status, lines: (r.stdout ?? "").split("\n") };
}

describe("collect-state.sh — GraphQL-only outage (issue #4130)", () => {
  test("a total gh failure still completes and flags BOTH lanes degraded", () => {
    const { lines } = runCollectState(makeStubBin("fail"));
    assert.ok(
      lines.includes("orch_board_signals_degraded=true"),
      "the orch lane's aggregate degraded flag must flip true (the orch lane had no target_board_signals_degraded equivalent before #4130)",
    );
    assert.ok(
      lines.includes("target_board_signals_degraded=true"),
      "the target lane's aggregate degraded flag must actually flip true in this scenario",
    );
  });

  test("a failed board read emits NO activating zero renders (AC 1)", () => {
    const { lines } = runCollectState(makeStubBin("fail"));
    // The orch board-counts JSON line (needs_qa / ready_for_agent / ...) is the
    // idle-inference feed — on a failed read it must be absent, not zeroed.
    assert.ok(
      !lines.some((l) => l.includes('"needs_qa":')),
      "the board-counts JSON must not render on a failed read",
    );
    // The four target_* counts: target_ready_for_agent=0 is the board-empty
    // condition that sets target_board_research_due — the measured 34→0
    // phantom-research dispatch. None of the four may render.
    for (const key of [
      "target_ready_for_agent",
      "target_needs_qa",
      "target_needs_triage",
      "target_needs_research",
    ]) {
      assert.ok(
        !lines.some((l) => l.startsWith(`${key}=`)),
        `a failed read must not emit ${key}=0 — the count is unknown, not zero`,
      );
    }
    // The arch board read fails closed in the NON-acting direction: no
    // backfill-idle, both anti-flood caps saturated.
    assert.ok(lines.includes("orch_backfill_idle=false"));
    assert.ok(lines.includes("arch_board_saturated=true"));
    assert.ok(lines.includes("cleanup_board_saturated=true"));
  });

  test("a failed read keeps its documented fail-closed suppressing emits — now flag-qualified (AC 2)", () => {
    const { lines } = runCollectState(makeStubBin("fail"));
    // These zeros never activate anything (documented fail-closed shapes) and
    // stay, so the render contract for consumers of the suppressing direction
    // is unchanged — the degraded flag is what distinguishes them from a
    // genuinely clean board.
    assert.ok(lines.includes("untriaged_orphans=0"));
    assert.ok(lines.includes("active_dev_orch=0"));
    assert.ok(lines.includes("orch_board_signals_degraded=true"));
    // The anchors keep their fail-closed `none` renders.
    assert.ok(lines.includes("orch_dev_ready_anchor=none"));
  });

  test("a genuinely empty board behaves exactly as today (AC 5d)", () => {
    const { lines } = runCollectState(makeStubBin("empty"));
    const out = lines.join("\n");
    // Healthy flags in BOTH lanes.
    assert.ok(lines.includes("orch_board_signals_degraded=false"));
    assert.ok(lines.includes("target_board_signals_degraded=false"));
    // The genuinely-empty board renders its zeros — the board-counts JSON line
    // IS emitted (jq pretty-prints it multi-line with `": "` separators, the
    // historical inline-gh shape), and the target counts render 0.
    assert.ok(
      out.includes('"ready_for_agent": 0'),
      "an empty-but-successful read still emits the board-counts JSON",
    );
    assert.ok(lines.includes("target_ready_for_agent=0"));
    assert.ok(lines.includes("untriaged_orphans=0"));
    // And the canonical board-empty signal computes true from a real read —
    // the backfill path a failed read must never fake.
    assert.ok(lines.includes("orch_backfill_idle=true"));
    assert.ok(lines.includes("arch_board_saturated=false"));
  });
});

// ---------------------------------------------------------------------------
// Part 2 — decide.py on a flagged snapshot (issue #4130 AC 3 / AC 4)
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "board-degraded-decide-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

function baseState(o: { idle_turns?: number; signals?: Record<string, unknown> } = {}): any {
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
    idle_turns: o.idle_turns ?? 0,
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {},
    signals: o.signals ?? {},
    research_force_counter: {},
  };
}

function runDecide(state: any): any {
  const t = makeTmp();
  writeFileSync(t.state, JSON.stringify(state));
  writeFileSync(t.cands, JSON.stringify(null));
  writeFileSync(t.events, JSON.stringify([]));
  const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
    encoding: "utf-8",
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
  });
  rmSync(t.dir, { recursive: true, force: true });
  if (r.status !== 0) {
    throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

const BACKFILL_KEYED = ["discover_orch", "architecture_orch", "cleanup_orch", "skill_prune"];

describe("decide.py — degraded orch board read (issue #4130)", () => {
  test("a degraded snapshot suppresses terminate:idle even at idle_drain_turns (AC 3)", () => {
    const plan = runDecide(
      baseState({ idle_turns: 5, signals: { orch_board_signals_degraded: true } }),
    );
    const idleTerm = (plan.actions ?? []).find(
      (a: any) => a.type === "terminate" && a.cause === "idle",
    );
    assert.equal(idleTerm, undefined, "must not conclude idle on a board it could not read");
    // The turn is carried by the heartbeat wait instead, and the suppression
    // is visible in the turn record (AC 4).
    assert.ok((plan.actions ?? []).some((a: any) => a.type === "wait"));
    assert.equal(plan.debug?.idle_fallback, "suppressed-degraded-board");
    assert.equal(plan.debug?.orch_board_signals_degraded, true);
  });

  test("control: an UNFLAGGED drained board still terminates idle exactly as before", () => {
    const plan = runDecide(baseState({ idle_turns: 5 }));
    assert.ok(
      (plan.actions ?? []).some((a: any) => a.type === "terminate" && a.cause === "idle"),
      "the clean idle-drain terminate (issue #1352) is unchanged without the flag",
    );
  });

  test("a degraded snapshot suppresses every orch_backfill_idle-keyed backfill class (AC 3)", () => {
    const plan = runDecide(
      baseState({
        signals: { orch_backfill_idle: true, orch_board_signals_degraded: true },
      }),
    );
    const dispatched = (plan.actions ?? []).filter(
      (a: any) => a.type === "dispatch" && BACKFILL_KEYED.includes(a.slot),
    );
    assert.equal(dispatched.length, 0, "no backfill class may dispatch against an unread board");
    // Observability (AC 4): one idle dispatch_decision per keyed class, with a
    // reason that names the outage — distinguishable from cadence cooldowns.
    const decisions = (plan.events ?? []).filter(
      (e: any) =>
        e.event === "dispatch_decision" &&
        BACKFILL_KEYED.includes(e.class) &&
        e.reason.includes("degraded"),
    );
    assert.equal(
      decisions.length,
      BACKFILL_KEYED.length,
      "every keyed class records a degraded-suppression dispatch_decision",
    );
    for (const d of decisions) {
      assert.equal(d.outcome, "idle");
    }
  });

  test("control: an UNFLAGGED idle board still dispatches backfill exactly as before", () => {
    const plan = runDecide(baseState({ signals: { orch_backfill_idle: true } }));
    const dispatched = (plan.actions ?? []).filter(
      (a: any) => a.type === "dispatch" && BACKFILL_KEYED.includes(a.slot),
    );
    assert.ok(
      dispatched.length >= 1,
      "the discover/architecture backfill path (issue #959) is unchanged without the flag",
    );
  });

  test("decide.py stays pure: the flag is read, never derived (no board-read logic of its own)", () => {
    // The signal-seam discipline pin: the flag arrives PRE-RESOLVED through
    // state.signals / a signal event, exactly like every other collect-state
    // signal — the helper must delegate to `_signal_present` and contain no
    // process/board-read machinery of its own. (decide.py as a whole DOES
    // shell out for the env-gated turn-event XADD in main()'s plumbing; the
    // purity constraint is about the DECISION seam, so the guard scopes to
    // the helper body.)
    const src = readFileSync(DECIDE, "utf-8");
    const start = src.indexOf("def _orch_board_degraded");
    assert.ok(start >= 0, "_orch_board_degraded must exist");
    const nextDef = src.indexOf("\ndef ", start);
    const body = src.slice(start, nextDef < 0 ? undefined : nextDef);
    assert.ok(
      body.includes("_signal_present("),
      "the flag lookup must reuse the _signal_present seam (events over state.signals)",
    );
    assert.ok(body.includes('"orch_board_signals_degraded"'));
    // Process-spawning primitives only — "gh" itself appears in the helper's
    // PROSE (documenting what collect-state.sh does), so it is not a banned
    // token; the primitives cannot appear in prose.
    for (const banned of ["subprocess", "os.system", "spawn", "popen"]) {
      assert.ok(!body.includes(banned), `the helper must not contain ${banned}`);
    }
  });
});
