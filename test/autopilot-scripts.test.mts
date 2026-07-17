/**
 * Regression test for issue #409 — scripts/autopilot/* extraction.
 *
 * The /hydra-autopilot playbook used to inline ~574 lines of bash and
 * python heredocs. Issue #409 extracted the deterministic phases into
 * standalone scripts under scripts/autopilot/. These tests pin the
 * BEHAVIOR each script must preserve so a future edit to one of the
 * scripts can't silently break the autopilot loop.
 *
 * Each script is invoked directly (no harness), with state files
 * redirected to a tempdir so the live autopilot run isn't disturbed.
 *
 *   bootstrap.sh       — initializes state.json + heartbeat + run log
 *   collect-state.sh   — read-only state collectors (NOT exercised here;
 *                        depends on a live hydra service)
 *   recover-stale.sh   — gh-driven label fixes (NOT exercised here;
 *                        depends on gh + GitHub)
 *   reap.py            — hard-cap trip clears slot + marks burned
 *   term-check.py      — prints TERM:budget / TERM:wall_clock /
 *                        TERM:idle / OK based on state
 *   dispatch.sh log    — appends one line to the run log
 *   drain.sh           — prints the final summary line
 *
 * Network-dependent scripts (collect-state, recover-stale, dispatch's
 * capacity-writeback subcommand) are NOT smoke-tested at the bash
 * level — they're shell-pure plumbing around `gh` / `hydra raw` and
 * would only test those CLIs.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");

function makeTempState(): { dir: string; state: string; heartbeat: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
    log: join(dir, "nightly.log"),
  };
}

/**
 * Issue #2715 — write an executable stub that impersonates `redis-cli` for the
 * bootstrap Redis-seed fallback. The stub answers exactly the two read shapes
 * bootstrap issues:
 *   - `HGET hydra:autopilot:signal-last-fired <class>` → the class's epoch
 *     from `signalHash` (empty output when absent, mirroring a missing field).
 *   - `GET hydra:autopilot:research-force-counter` → the canonical JSON string
 *     from `researchForce` (empty output when null).
 * Any other command echoes nothing (best-effort no-op). Injected via
 * HYDRA_AUTOPILOT_REDIS_CLI so the seed logic is exercised without a live Redis.
 */
function makeRedisStub(
  dir: string,
  opts: { signalHash?: Record<string, number>; researchForce?: unknown },
): string {
  const stubPath = join(dir, "redis-stub.sh");
  const signal = JSON.stringify(opts.signalHash ?? {});
  const research =
    opts.researchForce === undefined ? "" : JSON.stringify(opts.researchForce);
  // POSIX sh; reads argv the way `redis-cli <cmd> <key> [field]` is invoked.
  const script = `#!/usr/bin/env bash
cmd="$1"; key="$2"; field="$3"
if [ "$cmd" = "HGET" ] && [ "$key" = "hydra:autopilot:signal-last-fired" ]; then
  # Emit the field's value, or empty string when the field is absent (mirrors
  # a real HGET miss). jq -e distinguishes present-vs-null so an absent field
  # prints nothing rather than the literal "null".
  printf '%s' ${JSON.stringify(signal)} | jq -er --arg f "$field" '.[$f] | tostring' 2>/dev/null || true
  exit 0
fi
if [ "$cmd" = "GET" ] && [ "$key" = "hydra:autopilot:research-force-counter" ]; then
  printf '%s' ${JSON.stringify(research)}
  exit 0
fi
exit 0
`;
  writeFileSync(stubPath, script, { mode: 0o755 });
  return stubPath;
}

function runBootstrap(env: Record<string, string>, tmp: { state: string; heartbeat: string; log: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  // bootstrap.sh honors HYDRA_AUTOPILOT_STATE/HEARTBEAT/LOG so each
  // test gets its own paths and never stomps the live /tmp/...
  // state.json or POSTs a fake run to the live /api/autopilot/run-start
  // endpoint (root cause of 2026-05-26 dashboard ghost-outage).
  const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), [], {
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_STATE: tmp.state,
      HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      HYDRA_AUTOPILOT_LOG: tmp.log,
      ...env,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Invoke `bootstrap.sh --reap-derive-cause` with a simulated systemd
 * ExecStopPost environment ($EXIT_CODE / $EXIT_STATUS) and return the
 * derived `cause=… exit_code=…` line. This dry-run runs ONLY the
 * EXIT_CODE/EXIT_STATUS → (cause, exit_code) mapping that the live --reap
 * path shares — no state read, no run-end POST — so the mapping can be
 * pinned without touching a prod surface (issue #898 / AC2).
 */
function deriveReapCause(exitCode: string, exitStatus: string, slotsOccupied?: string): {
  status: number;
  cause: string;
  exitCodeNum: string;
  stdout: string;
} {
  const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), ["--reap-derive-cause"], {
    env: {
      ...process.env,
      EXIT_CODE: exitCode,
      EXIT_STATUS: exitStatus,
      // Issue #1903: the slots-occupied count the live --reap path derives from
      // state.json, injected directly for the dry-run. Default unset → 0.
      ...(slotsOccupied !== undefined ? { REAP_SLOTS_OCCUPIED: slotsOccupied } : {}),
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
  });
  const stdout = result.stdout ?? "";
  const m = stdout.match(/cause=(\S+)\s+exit_code=(\S+)/);
  return {
    status: result.status ?? -1,
    cause: m?.[1] ?? "",
    exitCodeNum: m?.[2] ?? "",
    stdout,
  };
}

/**
 * Invoke `bootstrap.sh --reap-count-slots <state>` (issue #2030) and return the
 * integer slots-occupied count it derives from a crafted state.json. This dry-run
 * runs ONLY `__reap_count_slots_occupied` (pipeline slots + background classes
 * fired this run) so the background-only handoff case can be pinned without a
 * live run-end POST. Writes `state` into a tempdir and cleans it up.
 */
function reapCountSlots(stateObj: Record<string, unknown>): number {
  const tmp = makeTempState();
  try {
    writeFileSync(tmp.state, JSON.stringify(stateObj));
    const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), ["--reap-count-slots", tmp.state], {
      env: { ...process.env, PATH: process.env.PATH ?? "" },
      encoding: "utf-8",
    });
    return Number.parseInt((result.stdout ?? "").trim(), 10);
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

/**
 * Invoke `bootstrap.sh --reap-session-decision` (issue #1130) with a simulated
 * exit environment + an injected session-limit line, returning the cause-gated
 * arming decision (`cause=… post=yes|no`). This pins the guard that stops a
 * PHANTOM session block: only a `crash` (the code=1 session-limit exit) with a
 * line may arm a block; a clean exit never does, so a stale line from a prior
 * run cannot re-arm a block on a clean exit.
 */
function reapSessionDecision(exitCode: string, exitStatus: string, sessionLine: string): {
  cause: string;
  post: string;
  stdout: string;
} {
  const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), ["--reap-session-decision"], {
    env: {
      ...process.env,
      EXIT_CODE: exitCode,
      EXIT_STATUS: exitStatus,
      HYDRA_AUTOPILOT_REAP_SESSION_LINE: sessionLine,
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
  });
  const stdout = result.stdout ?? "";
  const m = stdout.match(/cause=(\S+)\s+post=(\S+)/);
  return { cause: m?.[1] ?? "", post: m?.[2] ?? "", stdout };
}

/**
 * Invoke `bootstrap.sh --reap-crash-detail` (issue #2479) with a simulated exit
 * environment + an injected run-log path and journal-tail fallback, returning the
 * parsed crash_detail JSON the live --reap path would POST. This pins the
 * log_tail capture+fallback: the run log is read first, and when it yields
 * nothing the unit journal tail (injected here) fills log_tail — the startup-crash
 * case #1079's writer never covered (the run landed as `{exit_code: N}` with the
 * real API error only in journald). A clean exit echoes the literal `null`.
 *
 * Sets HYDRA_AUTOPILOT_REAP_JOURNAL_TAIL empty by default so the dry-run never
 * shells out to a real journalctl during tests.
 */
function reapCrashDetail(
  exitCode: string,
  exitStatus: string,
  opts: { logContents?: string; journalTail?: string } = {},
): { status: number; detail: unknown; stdout: string } {
  const tmp = makeTempState();
  try {
    const logPath = join(tmp.dir, "nightly.log");
    // Always create the log file; empty contents simulate the startup-crash
    // (session died before writing the run log) that forces the journal fallback.
    writeFileSync(logPath, opts.logContents ?? "");
    const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), ["--reap-crash-detail"], {
      env: {
        ...process.env,
        EXIT_CODE: exitCode,
        EXIT_STATUS: exitStatus,
        HYDRA_AUTOPILOT_LOG: logPath,
        // Inject the journal tail directly — the test harness can't poke a real
        // journal, mirroring HYDRA_AUTOPILOT_REAP_SESSION_LINE. Empty string =>
        // no journal fallback content available.
        HYDRA_AUTOPILOT_REAP_JOURNAL_TAIL: opts.journalTail ?? "",
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const stdout = (result.stdout ?? "").trim();
    let detail: unknown = null;
    try {
      detail = JSON.parse(stdout);
    } catch {
      detail = stdout; // surface raw text on a parse failure so the assertion is legible
    }
    return { status: result.status ?? -1, detail, stdout };
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

const SESSION_LIMIT_LINE =
  "You've hit your session limit · resets 7:50pm (America/Los_Angeles)";

describe("scripts/autopilot/bootstrap.sh", () => {
  test("initializes state.json with default limits", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.limits.token_budget, 10000000);
      assert.equal(s.limits.wall_clock_max_sec, 28800);
      assert.equal(s.limits.idle_drain_turns, 5);
      assert.equal(s.limits.subagent_max_tokens, 400000);
      assert.equal(s.limits.subagent_hard_max_tokens, 800000);
      assert.equal(s.limits.scope, "all");
      assert.deepEqual(s.burned_classes, []);
      assert.equal(s.cumulative_tokens, 0);
      assert.equal(s.idle_turns, 0);
      // The 7 fixed pipeline slots: the 6 from the #426 decision-brain
      // rewrite plus `design_concept_orch` added in #466 (Phase B of
      // #437). Signal-driven classes (health / sweep_* / discover_*) no
      // longer occupy slots; they live under `signal_last_fired` instead.
      const expectedSlots = [
        "dev_orch", "qa_orch", "research_orch",
        "dev_target", "qa_target", "research_target",
        "design_concept_orch",
      ];
      assert.equal(Object.keys(s.slots).length, expectedSlots.length, "slots schema has 7 entries");
      for (const cls of expectedSlots) {
        assert.equal(s.slots[cls], null, `slot ${cls} should be null`);
      }
      // 12 signal classes (issue #2575 + #2722 + #2739 + #2949): the 5 always-on
      // classes seeded at 0 (re-armed each run) plus the 7 long-cooldown classes
      // that, with no prior state file, also default to 0. The carry-forward
      // behaviour for the cooldown classes is pinned separately below. #2722 added
      // `wire_or_retire_target` (24h); #2739 added `design_qa_target` (7d); #2949
      // added `skill_prune` (7d) — all the same #2575 bootstrap bug class.
      const expectedSignals = [
        "health", "sweep_orch", "sweep_target", "discover_orch", "discover_target",
        "retro_orch", "architecture_orch", "cleanup_orch", "scout_orch",
        "wire_or_retire_target", "design_qa_target", "skill_prune",
      ];
      for (const sig of expectedSignals) {
        assert.equal(s.signal_last_fired[sig], 0, `signal ${sig} should start at 0`);
      }
      assert.deepEqual(s.failure_log, [], "failure_log seeded empty (issue #426)");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Regression for 2026-05-27 dashboard ghost-outage: bootstrap.sh stamped
   * its own bash $$ pid into state.json + the /api/autopilot/run-start
   * payload. That pid dies within seconds of Phase 0 completing, so the
   * orchestrator's `sweepRunIfDead()` immediately promoted every run to
   * `status: killed, term_reason: crash`, and `/api/now/active-dispatches`
   * reported "Active dispatches: 0" even when autopilot was looping
   * healthily.
   *
   * The fix walks up the process tree from $$ looking for a `claude`
   * ancestor (the long-lived autopilot CLI session) and stamps THAT pid.
   * Falls back to $$ when no `claude` ancestor exists (manual / test
   * invocations), which is still safe because isolated runs skip the
   * run-start POST entirely.
   *
   * This test runs bootstrap from a node:test child (no `claude` ancestor
   * unless the operator invokes `npm test` from inside a Claude Code
   * session, which is the normal hydra dev loop). In both shapes the
   * recorded pid MUST be a positive integer that's alive at the moment
   * bootstrap exits — anything else means the resolver short-circuited
   * or wrote the dead bash pid.
   */
  /**
   * Reap-on-exit backstop (issue #898). `bootstrap.sh --reap` is the systemd
   * ExecStopPost hook that guarantees a terminal run-end POST when the
   * autopilot session exits. With a NON-DEFAULT state path (the test-isolation
   * convention) it must short-circuit as "isolated run — nothing to reap" and
   * exit 0 WITHOUT POSTing to the live /api/autopilot/run-end (mirroring the
   * run-start isolation skip). This pins that it never aborts the unit stop
   * and never touches prod surfaces under isolation.
   */
  test("--reap on an isolated (non-default) state path is a clean no-op", () => {
    const tmp = makeTempState();
    try {
      const result = spawnSync(join(SCRIPTS, "bootstrap.sh"), ["--reap"], {
        env: {
          ...process.env,
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
          HYDRA_AUTOPILOT_LOG: tmp.log,
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
      });
      assert.equal(result.status, 0, `reap exited non-zero: ${result.stderr}`);
      assert.match(
        result.stdout ?? "",
        /isolated run/,
        "reap on a non-default state path must short-circuit as isolated",
      );
      // It must NOT have created the state file — reap never writes state.
      assert.equal(existsSync(tmp.state), false, "reap must not create state.json");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  /**
   * Reap cause derivation (issue #898 / AC2). The unit is Type=exec, so a
   * `systemctl restart` / RuntimeMaxSec stop arrives as a SIGTERM and systemd
   * exports EXIT_CODE=signal / EXIT_STATUS=TERM to the ExecStopPost reap. AC2
   * requires that signal-kill be recorded DETERMINISTICALLY as `interrupted`,
   * distinct from a genuine crash — the bug QA flagged was that any
   * EXIT_CODE!=exited fell through to `crash`, making `crash` the catch-all.
   * `--reap-derive-cause` echoes the shared mapping so we pin it directly.
   */
  test("SIGTERM signal-kill (EXIT_CODE=signal/EXIT_STATUS=TERM) → interrupted", () => {
    const r = deriveReapCause("signal", "TERM");
    assert.equal(r.status, 0, `derive exited non-zero: ${r.stdout}`);
    assert.equal(r.cause, "interrupted",
      "a SIGTERM (systemctl restart / RuntimeMaxSec) must be `interrupted`, not `crash`");
    assert.equal(r.exitCodeNum, "0", "an interrupted end records exit_code 0");
  });

  test("SIGTERM by number (EXIT_STATUS=15) → interrupted", () => {
    const r = deriveReapCause("signal", "15");
    assert.equal(r.cause, "interrupted", "EXIT_STATUS=15 (SIGTERM numeric) must map to interrupted");
    assert.equal(r.exitCodeNum, "0");
  });

  test("SIGINT signal-kill (EXIT_STATUS=INT / 2) → interrupted", () => {
    for (const s of ["INT", "2"]) {
      const r = deriveReapCause("signal", s);
      assert.equal(r.cause, "interrupted", `EXIT_STATUS=${s} (SIGINT) must map to interrupted`);
      assert.equal(r.exitCodeNum, "0");
    }
  });

  test("clean exit (EXIT_CODE=exited/EXIT_STATUS=0) → interrupted", () => {
    const r = deriveReapCause("exited", "0");
    assert.equal(r.cause, "interrupted");
    assert.equal(r.exitCodeNum, "0");
  });

  /**
   * Self-propagated SIGTERM/SIGINT exit *code* (issue #925). When a child the
   * `claude` CLI spawned (a dispatched subagent / tool) dies on SIGTERM, the
   * parent propagates 143 (= 128+SIGTERM) as its OWN exit STATUS, so systemd
   * reports EXIT_CODE=exited / EXIT_STATUS=143 — NOT EXIT_CODE=signal. Before
   * #925 that fell through to the `crash` catch-all, mislabeling every clean
   * self-exit a crash (and, via SuccessExitStatus= missing 143, arming the
   * StartLimit lockout). It must now map to `interrupted` / exit_code 0,
   * mirroring the EXIT_CODE=signal TERM/INT arm.
   */
  test("self-exit code 143 (EXIT_CODE=exited/EXIT_STATUS=143) → interrupted", () => {
    const r = deriveReapCause("exited", "143");
    assert.equal(r.status, 0, `derive exited non-zero: ${r.stdout}`);
    assert.equal(r.cause, "interrupted",
      "a code-143 self-exit (128+SIGTERM propagated by the parent) must be `interrupted`, not `crash`");
    assert.equal(r.exitCodeNum, "0", "an interrupted end records exit_code 0");
  });

  test("self-exit code 130 (EXIT_CODE=exited/EXIT_STATUS=130) → interrupted", () => {
    const r = deriveReapCause("exited", "130");
    assert.equal(r.cause, "interrupted",
      "a code-130 self-exit (128+SIGINT propagated by the parent) must be `interrupted`, not `crash`");
    assert.equal(r.exitCodeNum, "0");
  });

  test("a real crash signal (EXIT_STATUS=SEGV) stays crash, not interrupted", () => {
    const r = deriveReapCause("signal", "SEGV");
    assert.equal(r.cause, "crash", "SEGV is a genuine crash — must NOT be reclassified as interrupted");
    assert.equal(r.exitCodeNum, "1", "a non-numeric crash signal records the non-zero sentinel");
  });

  /**
   * Issue #1903 — the honest baton-pass. A CLEAN exit (code 0/143/130) with
   * subagent slots STILL occupied is a `handoff`, not `interrupted`: the
   * print-mode session ended its turn while subagents are mid-flight, and the
   * next pace-gate-launched run re-seeds the surviving dispatch ledger (#1352).
   * `interrupted` stays reserved for a clean ZERO-slot exit.
   */
  test("clean exit with slots occupied → handoff (#1903)", () => {
    for (const status of ["0", "143", "130"]) {
      const r = deriveReapCause("exited", status, "2");
      assert.equal(r.cause, "handoff",
        `clean exit (status ${status}) with slots>0 is an honest baton-pass, not interrupted`);
      assert.equal(r.exitCodeNum, "0", "a handoff records exit_code 0 (clean)");
    }
  });

  test("clean exit with ZERO slots stays interrupted, not handoff (#1903)", () => {
    const r = deriveReapCause("exited", "0", "0");
    assert.equal(r.cause, "interrupted",
      "a clean exit with no slots in flight is a genuine print-mode end — stays interrupted");
    assert.equal(r.exitCodeNum, "0");
  });

  test("a crash with slots occupied stays crash, never handoff (#1903 INV-A)", () => {
    const r = deriveReapCause("signal", "SEGV", "3");
    assert.equal(r.cause, "crash",
      "an abnormal exit is a crash regardless of slot occupancy — handoff requires a CLEAN exit code");
    assert.equal(r.exitCodeNum, "1");
  });

  /**
   * Issue #2030 — the slots-occupied count the live --reap path derives must
   * also see background/signal classes (sweep_orch / retro_orch / …) fired
   * DURING this run. Those never enter `state.json.slots`, so #1903's
   * slots-only count read 0 for a background-only run and mis-stamped it
   * `interrupted`. `__reap_count_slots_occupied` (exercised via the
   * --reap-count-slots dry-run) sums pipeline slots + this-run background fires.
   */
  const RUN_START = 1_700_000_000;
  const stateWithSignals = (
    slots: Record<string, unknown>,
    signals: Record<string, number>,
    startedEpoch = RUN_START,
  ): Record<string, unknown> => ({
    started_epoch: startedEpoch,
    slots,
    signal_last_fired: signals,
  });

  test("background-only run (sweep_orch+retro_orch fired this run) counts >0 → handoff (#2030)", () => {
    // All pipeline slots null, but two background classes fired AT/AFTER
    // started_epoch — the exact proof case from the issue (run d7bca162).
    const count = reapCountSlots(stateWithSignals(
      { dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
        design_concept_orch: null },
      { health: 0, sweep_orch: RUN_START + 5, sweep_target: 0,
        discover_orch: 0, discover_target: 0, retro_orch: RUN_START + 7 },
    ));
    assert.equal(count, 2, "two background classes fired this run must count as 2 occupied");
    // …and that count drives the clean-exit derivation to handoff, not interrupted.
    const r = deriveReapCause("exited", "0", String(count));
    assert.equal(r.cause, "handoff",
      "a clean-exit background-only run is an honest baton-pass, not interrupted (#2030)");
  });

  test("background signal fired BEFORE this run (stale) does not count (#2030)", () => {
    // A retro_orch that fired in a PRIOR run (timestamp < started_epoch) is not
    // in flight for THIS run — it must not inflate the count.
    const count = reapCountSlots(stateWithSignals(
      { dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null },
      { health: 0, sweep_orch: RUN_START - 3600, retro_orch: RUN_START - 100 },
    ));
    assert.equal(count, 0, "a signal fired before started_epoch is stale, not in-flight");
    const r = deriveReapCause("exited", "0", String(count));
    assert.equal(r.cause, "interrupted",
      "a clean exit with only STALE background fires is a genuine nothing-pending end");
  });

  test("pipeline slots and this-run background fires sum together (#2030)", () => {
    const count = reapCountSlots(stateWithSignals(
      { dev_orch: { skill: "hydra-dev", started: "now" }, qa_orch: null,
        research_orch: null, dev_target: null, qa_target: null, research_target: null },
      { sweep_orch: RUN_START + 1 },
    ));
    assert.equal(count, 2, "1 pipeline slot + 1 this-run background fire = 2");
  });

  test("background-only run still derives crash on an abnormal exit (#2030 INV-A)", () => {
    // Even with background work in flight, a non-clean exit code is a crash —
    // the slots count is consulted ONLY on a clean exit (INV-A preserved).
    const count = reapCountSlots(stateWithSignals(
      { dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null },
      { sweep_orch: RUN_START + 2, retro_orch: RUN_START + 3 },
    ));
    assert.equal(count, 2, "background fires are counted");
    const r = deriveReapCause("signal", "SEGV", String(count));
    assert.equal(r.cause, "crash",
      "an abnormal exit is a crash regardless of in-flight background work (#2030 INV-A)");
    assert.equal(r.exitCodeNum, "1");
  });

  test("a missing/garbage state file degrades to 0 (never blocks the reap) (#2030)", () => {
    const result = spawnSync(join(SCRIPTS, "bootstrap.sh"),
      ["--reap-count-slots", "/nonexistent/state.json"],
      { env: { ...process.env, PATH: process.env.PATH ?? "" }, encoding: "utf-8" });
    assert.equal(result.status, 0, "the dry-run never errors on a missing file");
    assert.equal((result.stdout ?? "").trim(), "0", "a missing state file degrades to 0");
  });

  test("missing started_epoch treats every non-zero signal as this-run (conservative) (#2030)", () => {
    // No started_epoch → start defaults to 0 → any non-zero signal counts.
    // The conservative direction: prefer handoff over a false interrupted.
    const count = reapCountSlots({
      slots: { dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null },
      signal_last_fired: { health: 0, sweep_orch: 1_650_000_000 },
    });
    assert.equal(count, 1, "with no started_epoch, a non-zero signal counts as in-flight");
  });

  test("a non-zero exit status stays crash with the real code", () => {
    const r = deriveReapCause("exited", "37");
    assert.equal(r.cause, "crash");
    assert.equal(r.exitCodeNum, "37", "a non-zero exit preserves the real exit status");
  });

  // Issue #1130: phantom-session-block guard. The reap must arm a session block
  // ONLY on a genuine session-limit crash (code=1) — never on a clean exit, so
  // a stale `hit your session limit` line left in the journal by a PRIOR run
  // cannot re-park the autopilot for hours while the usage meter is empty.
  test("crash exit (code 1) with a session-limit line → arms block (post=yes)", () => {
    const r = reapSessionDecision("exited", "1", SESSION_LIMIT_LINE);
    assert.equal(r.cause, "crash");
    assert.equal(r.post, "yes", "a genuine session-limit crash must arm the block");
  });

  test("clean exit (code 0) with a stale session-limit line → NO block (post=no)", () => {
    const r = reapSessionDecision("exited", "0", SESSION_LIMIT_LINE);
    assert.equal(r.cause, "interrupted");
    assert.equal(r.post, "no",
      "a clean code-0 exit must NOT arm a phantom block from a stale prior-run line (#1130)");
  });

  test("self-exit 143 with a stale session-limit line → NO block (post=no)", () => {
    const r = reapSessionDecision("exited", "143", SESSION_LIMIT_LINE);
    assert.equal(r.cause, "interrupted");
    assert.equal(r.post, "no", "a 143 self-exit must NOT arm a phantom block (#1130)");
  });

  test("signal-kill (SIGTERM) with a stale session-limit line → NO block (post=no)", () => {
    const r = reapSessionDecision("signal", "TERM", SESSION_LIMIT_LINE);
    assert.equal(r.cause, "interrupted");
    assert.equal(r.post, "no", "a SIGTERM restart must NOT arm a phantom block (#1130)");
  });

  test("crash exit with NO session-limit line → no block (post=no)", () => {
    const r = reapSessionDecision("exited", "1", "");
    assert.equal(r.cause, "crash");
    assert.equal(r.post, "no", "a crash with no session-limit line records nothing");
  });

  test("records an alive owning-pid (not bootstrap.sh's short-lived $$)", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(typeof s.pid, "number", "state.pid must be a number");
      assert.ok(s.pid > 0, "state.pid must be positive");
      // The recorded pid MUST be alive at the moment we read it. The
      // bug we're guarding against wrote $$ (bootstrap's own pid), which
      // is dead by the time the test reads state.json a few ms later.
      // Use process.kill(pid, 0) — throws ESRCH if dead, succeeds otherwise.
      assert.doesNotThrow(
        () => process.kill(s.pid, 0),
        `state.pid=${s.pid} is dead at read-time — bootstrap stamped its own $$ instead of walking up to the owning process`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("respects env-var overrides for budget knobs", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {
          HYDRA_AUTOPILOT_TOKEN_BUDGET: "100000",
          HYDRA_AUTOPILOT_MAX_SEC: "120",
          HYDRA_AUTOPILOT_IDLE_TURNS: "2",
          HYDRA_AUTOPILOT_SCOPE: "orch-only",
        },
        tmp,
      );
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.limits.token_budget, 100000);
      assert.equal(s.limits.wall_clock_max_sec, 120);
      assert.equal(s.limits.idle_drain_turns, 2);
      assert.equal(s.limits.scope, "orch-only");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("rejects soft cap > hard cap with non-zero exit", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap(
        {
          HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS: "1000000",
          HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS: "500000",
        },
        tmp,
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /FATAL.*exceeds/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid scope value", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({ HYDRA_AUTOPILOT_SCOPE: "invalid-scope" }, tmp);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /FATAL.*SCOPE.*invalid/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #431 (later extended by #466): pin the 12-key schema as a
  // single explicit smoke test so a future bootstrap edit that drops one
  // of the named null keys fails loudly. The split assertions above
  // already check this, but a consolidated key-count assertion documents
  // the contract.
  //
  // History: #431 introduced the 11-key check (6 pipeline + 5 signal).
  // #466 (Phase B of #437) added the seventh pipeline slot
  // `design_concept_orch`, bumping the total to 12 (7 pipeline + 5 signal).
  // #2575 added the 4 long-cooldown signal classes (retro_orch /
  // architecture_orch / cleanup_orch / scout_orch) so their 24h cooldown is
  // tracked + carried across pace-gate relaunches, bumping the total to 16
  // (7 pipeline + 9 signal). #2722 added the 5th long-cooldown signal class
  // `wire_or_retire_target` (24h — same bug class), bumping the total to 17
  // (7 pipeline + 10 signal). #2739 added the 6th long-cooldown signal class
  // `design_qa_target` (7d — same bug class), bumping the total to 18
  // (7 pipeline + 11 signal). #2949 added the 7th long-cooldown signal class
  // `skill_prune` (7d — same bug class), bumping the total to 19
  // (7 pipeline + 12 signal). NOTE (issue #3351): `wayfinder_orch` is a NEW
  // signal class in classes.json but is DELIBERATELY NOT in this bootstrap seed —
  // it is a 1h class (like cleanup_orch's cadence but map-anchored, not
  // carry-forward-sensitive), so a missing signal_last_fired entry is treated as
  // never-fired (immediately eligible) with no #2575 re-run hazard. The bootstrap
  // seed set is intentionally the 12 carry-forward-sensitive classes only.
  test("emits exactly 7 pipeline slot names + 12 signal_last_fired names (19 keys total)", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));

      const pipelineSlots = [
        "dev_orch", "qa_orch", "research_orch",
        "dev_target", "qa_target", "research_target",
        "design_concept_orch",
      ];
      const signalKeys = [
        "health", "sweep_orch", "sweep_target", "discover_orch", "discover_target",
        "retro_orch", "architecture_orch", "cleanup_orch", "scout_orch",
        "wire_or_retire_target", "design_qa_target", "skill_prune",
      ];

      assert.deepEqual(Object.keys(s.slots).sort(), [...pipelineSlots].sort(),
        "slots dict must contain exactly the 7 named pipeline keys");
      assert.deepEqual(Object.keys(s.signal_last_fired).sort(), [...signalKeys].sort(),
        "signal_last_fired dict must contain exactly the 12 named signal keys");
      assert.equal(
        Object.keys(s.slots).length + Object.keys(s.signal_last_fired).length,
        19,
        "schema must declare 19 named keys (7 pipeline + 12 signal) — see issues #431, #466, #2575, #2722, #2739, #2949"
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2575 — the 4 long-cooldown signal classes must carry their prior
  // last-fired timestamp across a pace-gate relaunch (which re-runs bootstrap
  // ~every 15 min), NOT reset to 0. Before #2575 these keys were absent from
  // the heredoc, so decide.py's `signal_is_cooled()` read a missing key as
  // epoch 0 (permanently cooled) and retro_orch fired 5–8×/day instead of the
  // designed 1×/day. With a prior state.json present, bootstrap must preserve
  // the timestamps while still re-arming the 5 always-on classes to 0.
  test("carries prior signal_last_fired timestamps forward for the 7 long-cooldown classes (issue #2575)", () => {
    const tmp = makeTempState();
    try {
      // A prior run's state: the 7 cooldown classes fired recently; the
      // always-on classes also carry stale values that must be re-armed to 0.
      const priorRetro = 1_700_000_000;
      writeFileSync(tmp.state, JSON.stringify({
        schema_version: 2,
        slots: {},
        signal_last_fired: {
          health: 1_650_000_001,
          sweep_orch: 1_650_000_002,
          sweep_target: 1_650_000_003,
          discover_orch: 1_650_000_004,
          discover_target: 1_650_000_005,
          retro_orch: priorRetro,
          architecture_orch: 1_700_000_100,
          cleanup_orch: 1_700_000_200,
          scout_orch: 1_700_000_300,
          wire_or_retire_target: 1_700_000_400,
          design_qa_target: 1_700_000_500,
          skill_prune: 1_700_000_600,
        },
      }));
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));

      // The 7 long-cooldown classes carry their prior timestamp forward — this
      // is the core of the fix; a reset-to-0 here is the #2575 bug.
      assert.equal(s.signal_last_fired.retro_orch, priorRetro,
        "retro_orch must carry its prior last-fired timestamp forward (NOT reset to 0)");
      assert.equal(s.signal_last_fired.architecture_orch, 1_700_000_100,
        "architecture_orch must carry its prior last-fired timestamp forward");
      assert.equal(s.signal_last_fired.cleanup_orch, 1_700_000_200,
        "cleanup_orch must carry its prior last-fired timestamp forward");
      assert.equal(s.signal_last_fired.scout_orch, 1_700_000_300,
        "scout_orch must carry its prior last-fired timestamp forward");
      // #2722 — wire_or_retire_target is the 5th long-cooldown class (24h).
      assert.equal(s.signal_last_fired.wire_or_retire_target, 1_700_000_400,
        "wire_or_retire_target must carry its prior last-fired timestamp forward (#2722)");
      // #2739 — design_qa_target is the 6th long-cooldown class (7d).
      assert.equal(s.signal_last_fired.design_qa_target, 1_700_000_500,
        "design_qa_target must carry its prior last-fired timestamp forward (#2739)");
      // #2949 — skill_prune is the 7th long-cooldown class (7d).
      assert.equal(s.signal_last_fired.skill_prune, 1_700_000_600,
        "skill_prune must carry its prior last-fired timestamp forward (#2949)");

      // The 5 always-on classes are re-armed to 0 each run by design.
      for (const sig of ["health", "sweep_orch", "sweep_target", "discover_orch", "discover_target"]) {
        assert.equal(s.signal_last_fired[sig], 0, `always-on signal ${sig} must re-arm to 0`);
      }
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2575 (+ #2722, #2739, #2949) — first-ever run (no prior state file)
  // defaults the 7 long-cooldown classes to 0, exactly like the 5 always-on ones.
  test("defaults the 7 long-cooldown signal classes to 0 when there is no prior state (issue #2575, #2722, #2739, #2949)", () => {
    const tmp = makeTempState();
    try {
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      for (const sig of ["retro_orch", "architecture_orch", "cleanup_orch", "scout_orch", "wire_or_retire_target", "design_qa_target", "skill_prune"]) {
        assert.equal(s.signal_last_fired[sig], 0,
          `cooldown signal ${sig} must default to 0 on first-ever run`);
      }
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2715 — reboot survival. /tmp is boot-wiped, so after a host reboot
  // there is NO prior state file; the #2575 carry-forward falls to 0 and the
  // long-cooldown classes all fire in the first post-boot run. With the Redis
  // mirror in place, bootstrap seeds the 4 long-cooldown classes from Redis
  // instead of 0 — the seed order is prior-file → Redis → 0. This test
  // simulates the reboot: NO prior state file, but Redis holds the timestamps.
  test("seeds the 4 long-cooldown classes from Redis when the prior state file is gone (issue #2715)", () => {
    const tmp = makeTempState();
    try {
      const redisHash = {
        retro_orch: 1_780_000_000,
        architecture_orch: 1_780_000_100,
        cleanup_orch: 1_780_000_200,
        scout_orch: 1_780_000_300,
      };
      const stub = makeRedisStub(tmp.dir, { signalHash: redisHash });
      // No prior state file written — this is the post-reboot condition.
      const r = runBootstrap({ HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` }, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));

      assert.equal(s.signal_last_fired.retro_orch, redisHash.retro_orch,
        "retro_orch must seed from Redis after a reboot (NOT 0)");
      assert.equal(s.signal_last_fired.architecture_orch, redisHash.architecture_orch,
        "architecture_orch must seed from Redis after a reboot");
      assert.equal(s.signal_last_fired.cleanup_orch, redisHash.cleanup_orch,
        "cleanup_orch must seed from Redis after a reboot");
      assert.equal(s.signal_last_fired.scout_orch, redisHash.scout_orch,
        "scout_orch must seed from Redis after a reboot");
      // Always-on classes still re-arm to 0 — Redis mirror never touches them.
      for (const sig of ["health", "sweep_orch", "sweep_target", "discover_orch", "discover_target"]) {
        assert.equal(s.signal_last_fired[sig], 0, `always-on signal ${sig} must re-arm to 0`);
      }
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2715 — the prior state file WINS over Redis (seed order prior → Redis
  // → 0). Within a boot session /tmp survives, so the fast local prior-file tier
  // must take precedence; Redis is only the reboot backstop. Verify a prior file
  // with a fresher timestamp is preserved even when Redis holds a stale one.
  test("prefers the prior state file over Redis for the long-cooldown classes (issue #2715)", () => {
    const tmp = makeTempState();
    try {
      const priorTs = 1_790_000_000;
      writeFileSync(tmp.state, JSON.stringify({
        schema_version: 2,
        slots: {},
        signal_last_fired: {
          retro_orch: priorTs,
          architecture_orch: priorTs,
          cleanup_orch: priorTs,
          scout_orch: priorTs,
        },
      }));
      // Redis holds an OLDER timestamp that must be ignored in favour of the file.
      const stub = makeRedisStub(tmp.dir, {
        signalHash: {
          retro_orch: 1_700_000_000,
          architecture_orch: 1_700_000_000,
          cleanup_orch: 1_700_000_000,
          scout_orch: 1_700_000_000,
        },
      });
      const r = runBootstrap({ HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` }, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      for (const sig of ["retro_orch", "architecture_orch", "cleanup_orch", "scout_orch"]) {
        assert.equal(s.signal_last_fired[sig], priorTs,
          `${sig} must keep the prior-file timestamp, not fall through to the older Redis value`);
      }
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2715 — first install: no prior file AND no Redis key still degrades
  // to 0 (acceptance criterion — first-install behaviour unchanged). The stub
  // returns empty for every field, simulating an empty Redis.
  test("degrades to 0 when there is neither a prior state file nor a Redis key (issue #2715)", () => {
    const tmp = makeTempState();
    try {
      const stub = makeRedisStub(tmp.dir, { signalHash: {} }); // empty Redis
      const r = runBootstrap({ HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` }, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      for (const sig of ["retro_orch", "architecture_orch", "cleanup_orch", "scout_orch"]) {
        assert.equal(s.signal_last_fired[sig], 0,
          `${sig} must default to 0 when neither prior file nor Redis has a value`);
      }
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2715 — research_force_counter also seeds from Redis after a reboot.
  // The stored value is a date-keyed object; bootstrap prunes it to TODAY's UTC
  // key exactly like the prior-file path, so a stale yesterday counter can't leak
  // forward. Feed a Redis value that contains BOTH today and yesterday and assert
  // only today's survives.
  test("seeds research_force_counter from Redis (pruned to today) after a reboot (issue #2715)", () => {
    const tmp = makeTempState();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = "2000-01-01";
      const stub = makeRedisStub(tmp.dir, {
        researchForce: { [today]: { orch: 2 }, [yesterday]: { orch: 9 } },
      });
      // No prior state file — post-reboot condition.
      const r = runBootstrap({ HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` }, tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(s.research_force_counter, { [today]: { orch: 2 } },
        "research_force_counter must seed from Redis pruned to today's UTC key only");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2715 — the Redis seed is best-effort / fail-open: a redis-cli that
  // exits non-zero (redis down) must NOT abort bootstrap; the classes fall back
  // to 0 (design-concept #2715 Invariant 5).
  test("Redis seed is fail-open — a failing redis-cli never aborts bootstrap (issue #2715)", () => {
    const tmp = makeTempState();
    try {
      // A stub that always exits 1 (simulating docker/redis unavailable).
      const stub = join(tmp.dir, "redis-fail.sh");
      writeFileSync(stub, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
      const r = runBootstrap({ HYDRA_AUTOPILOT_REDIS_CLI: `bash ${stub}` }, tmp);
      assert.equal(r.status, 0, `bootstrap must not abort when redis-cli fails: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      for (const sig of ["retro_orch", "architecture_orch", "cleanup_orch", "scout_orch"]) {
        assert.equal(s.signal_last_fired[sig], 0,
          `${sig} must degrade to 0 when the Redis seed read fails`);
      }
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #431 — backward compat. The first γ run observed an existing
  // state.json with `pipeline: {}` (a misnamed empty dict from an older
  // bootstrap variant). bootstrap.sh uses `cat > state.json` which
  // unconditionally overwrites — verify this works for arbitrary
  // pre-existing shapes without crash.
  test("overwrites a legacy/malformed pre-existing state.json without crashing", () => {
    const tmp = makeTempState();
    try {
      // Seed the isolated state path with a legacy shape — bootstrap should
      // clobber it on the next run.
      writeFileSync(tmp.state, JSON.stringify({
        pipeline: {},  // misnamed empty dict observed in the wild
        signal_last_fired: {},  // partially-initialized
        cumulative_tokens: 999999,
        legacy_field: "should be gone after overwrite",
      }));
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap should not crash on legacy state: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      // New shape replaces the old completely.
      assert.equal(s.cumulative_tokens, 0, "fresh bootstrap must reset cumulative_tokens");
      assert.equal((s as Record<string, unknown>).legacy_field, undefined,
        "stale fields must be dropped on overwrite");
      assert.equal((s as Record<string, unknown>).pipeline, undefined,
        "legacy `pipeline` key must not survive the overwrite — canonical key is `slots`");
      assert.equal(Object.keys(s.slots).length, 7, "slots must be re-initialized with 7 named keys (post-#466)");
      assert.equal(Object.keys(s.signal_last_fired).length, 12, "signal_last_fired must be re-initialized with 12 named keys (post-#2575, #2722, #2739, #2949)");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Regression for 2026-05-16: the morning hydra-autopilot.service died from
  // a transient Anthropic API 5xx, leaving /tmp/hydra-autopilot-state.json
  // stamped with its dead PID. The bounded systemd auto-restart then ran a
  // fresh bootstrap, but the model misread the stale state as a live
  // duplicate and self-terminated, leaving the system without an autopilot
  // for ~10h until the next timer fire.
  test("recovers from stale state when the prior owner PID is dead", () => {
    const tmp = makeTempState();
    try {
      // Seed the isolated state.json with a PID that's almost certainly
      // dead (PID 1 is init, so use a high 32-bit value the kernel
      // won't assign).
      const deadPid = 2_000_000_000;
      writeFileSync(tmp.state, JSON.stringify({
        pid: deadPid, run_id: "stale-test", slots: {}, signal_last_fired: {},
      }));
      const r = runBootstrap({}, tmp);
      assert.equal(r.status, 0, `bootstrap should recover from stale state: ${r.stderr}`);
      assert.match(r.stdout + r.stderr, /recovering from stale state/,
        "bootstrap should log the stale-state recovery");
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.notEqual(s.pid, deadPid, "fresh bootstrap must stamp its own PID");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite state when the prior owner PID is alive", () => {
    const tmp = makeTempState();
    // The test runner's own PID is guaranteed alive for the duration of
    // this test, so it stands in for a live concurrent autopilot.
    const livePid = process.pid;
    try {
      writeFileSync(tmp.state, JSON.stringify({
        pid: livePid, run_id: "live-test", slots: {}, signal_last_fired: {},
      }));
      const r = runBootstrap({}, tmp);
      assert.notEqual(r.status, 0, "bootstrap must abort when prior PID is alive");
      assert.match(r.stdout + r.stderr, /prior autopilot pid=\d+ is alive/,
        "bootstrap should log why it refused");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #2479: crash_detail.log_tail must be FILLED on a crash, not just an
 * `{exit_code: N}` shell. #1079 shipped the schema + read path but the reaper
 * only ever read the run log — so a STARTUP crash (network/socket failure,
 * turns=0, dispatches=0) that died before writing the run log landed with no
 * log_tail, and the real API error was recoverable only from journald
 * out-of-band. The fix reads the run log first, then falls back to the unit
 * journal tail. These dry-run tests pin the assembled crash_detail the live
 * --reap POST path sends.
 */
describe("scripts/autopilot/bootstrap.sh --reap-crash-detail (issue #2479)", () => {
  test("crash with run-log present captures it as log_tail", () => {
    const log = "turn 1: dispatched dev_orch\nAPI Error: something blew up\nfinal line";
    const r = reapCrashDetail("exited", "1", { logContents: log });
    assert.equal(r.status, 0, `dry-run exited non-zero: ${r.stdout}`);
    const d = r.detail as Record<string, unknown>;
    assert.equal(d.exit_code, 1);
    assert.equal(d.log_tail, log, "run-log contents must populate log_tail");
    assert.equal(d.signal, undefined, "no signal field on a non-signal exit");
  });

  test("STARTUP crash (empty run-log) falls back to the journal tail", () => {
    // The #2479 failure mode: the session crashed before writing the run log,
    // so log_tail was empty and the run was un-drillable. The journal fallback
    // must fill it with the real API error.
    const journal =
      "hydra-pace-gate: eligible — exec'ing autopilot session\n" +
      "API Error: Unable to connect to API (FailedToOpenSocket)";
    const r = reapCrashDetail("exited", "1", { logContents: "", journalTail: journal });
    assert.equal(r.status, 0, `dry-run exited non-zero: ${r.stdout}`);
    const d = r.detail as Record<string, unknown>;
    assert.equal(d.exit_code, 1);
    assert.equal(
      d.log_tail,
      journal,
      "an empty run-log must trigger the journal-tail fallback so the crash is drillable",
    );
  });

  test("run-log wins over the journal fallback when both are available", () => {
    const log = "real run output line";
    const journal = "stale journal noise that should NOT be used";
    const r = reapCrashDetail("exited", "1", { logContents: log, journalTail: journal });
    const d = r.detail as Record<string, unknown>;
    assert.equal(d.log_tail, log, "the richer run-log source is preferred over the journal");
  });

  test("signal-kill crash records the signal name alongside log_tail", () => {
    const r = reapCrashDetail("signal", "SEGV", { logContents: "boom" });
    const d = r.detail as Record<string, unknown>;
    assert.equal(d.signal, "SEGV", "a signal kill records the signal name");
    assert.equal(d.log_tail, "boom");
  });

  test("clean exit records NO crash_detail (stays a 'died badly' signal)", () => {
    const r = reapCrashDetail("exited", "0", { logContents: "irrelevant" });
    assert.equal(r.detail, null, "a clean exit must echo null — no crash_detail persisted");
  });

  test("crash with no run-log AND no journal omits log_tail (best-effort, never blocks)", () => {
    const r = reapCrashDetail("exited", "1", { logContents: "", journalTail: "" });
    assert.equal(r.status, 0, `dry-run exited non-zero: ${r.stdout}`);
    const d = r.detail as Record<string, unknown>;
    assert.equal(d.exit_code, 1, "exit_code is still recorded");
    assert.equal(d.log_tail, undefined, "no source available => log_tail omitted, not empty-string");
  });
});

describe("scripts/systemd/hydra-autopilot.service (issue #898)", () => {
  const unit = readFileSync(
    join(REPO_ROOT, "scripts", "systemd", "hydra-autopilot.service"),
    "utf-8",
  );

  // The reap-on-exit backstop is only guaranteed if the unit invokes the
  // reap hook on EVERY stop. ExecStopPost= fires regardless of how the main
  // process exited (clean, signal, crash), which is exactly the "any exit
  // path" coverage issue #898 requires.
  test("wires bootstrap.sh --reap as ExecStopPost", () => {
    assert.match(
      unit,
      /^ExecStopPost=.*bootstrap\.sh --reap/m,
      "unit must run `bootstrap.sh --reap` on stop so a terminal run-end is recorded on every exit path",
    );
  });

  // The `-` prefix makes a reap failure non-fatal to the unit stop — a
  // run-end POST failure must never leave the unit in a failed state.
  test("the reap ExecStopPost is non-fatal (`-` prefix)", () => {
    assert.match(
      unit,
      /^ExecStopPost=-/m,
      "ExecStopPost must be prefixed with `-` so a reap failure can't fail the unit stop",
    );
  });

  // AC2: a SIGTERM stop (`systemctl restart` / RuntimeMaxSec) is a clean
  // interrupt, not a failure. SuccessExitStatus=SIGTERM both keeps Type=exec
  // from marking a deliberate restart as failed and stops Restart=on-failure
  // from spuriously retrying it.
  test("declares SuccessExitStatus=SIGTERM so a restart isn't a failure", () => {
    assert.match(
      unit,
      /^SuccessExitStatus=.*SIGTERM/m,
      "unit must treat a SIGTERM stop as success (issue #898 / AC2)",
    );
  });

  // Issue #925: the dominant termination was a `claude` self-exit with code
  // 143 (128+SIGTERM) / 130 (128+SIGINT). `SuccessExitStatus=SIGTERM` matches
  // a delivered *signal* only — NOT an exit *code* of 143 — so without the
  // numeric codes here those self-exits armed Restart=on-failure → StartLimit
  // lockout. The unit must declare the numeric codes a success too.
  test("declares exit codes 143 and 130 as success (issue #925)", () => {
    const m = unit.match(/^SuccessExitStatus=(.*)$/m);
    assert.ok(m, "unit must have a SuccessExitStatus= line");
    const tokens = (m![1] ?? "").split(/\s+/).filter(Boolean);
    assert.ok(tokens.includes("143"),
      "SuccessExitStatus must list 143 (128+SIGTERM self-exit) so it doesn't arm Restart=on-failure");
    assert.ok(tokens.includes("130"),
      "SuccessExitStatus must list 130 (128+SIGINT self-exit)");
  });

  // Issue #925: with StartLimitBurst=2 / IntervalSec=3600, two bad runs in an
  // hour dead-zoned the Pace Gate (which fires ~every 15 min = 900s) for the
  // rest of that hour. The window must be no wider than one Gate cycle so a
  // transient burst cannot starve the autopilot for more than a single cycle.
  test("StartLimit window is no wider than one Pace Gate cycle (issue #925)", () => {
    const interval = unit.match(/^StartLimitIntervalSec=(\d+)$/m);
    assert.ok(interval, "unit must have a StartLimitIntervalSec= line");
    assert.ok(Number(interval![1]) <= 900,
      `StartLimitIntervalSec must be <= 900s (one Pace Gate cycle); got ${interval![1]}`);
  });
});

describe("scripts/autopilot/term-check.py", () => {
  function writeState(path: string, patch: Record<string, unknown>): void {
    // Post-#426 schema: 6 pipeline slots + signal_last_fired map.
    const base = {
      started_epoch: Math.floor(Date.now() / 1000),
      limits: {
        token_budget: 2000000,
        wall_clock_max_sec: 28800,
        idle_drain_turns: 5,
        scope: "all",
        subagent_max_tokens: 400000,
        subagent_hard_max_tokens: 800000,
      },
      cumulative_tokens: 0,
      idle_turns: 0,
      slots: {
        dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
      },
      failure_log: [],
    };
    writeFileSync(path, JSON.stringify({ ...base, ...patch }));
  }

  function runTermCheck(statePath: string): { status: number; stdout: string } {
    const r = spawnSync(join(SCRIPTS, "term-check.py"), [], {
      env: { ...process.env, HYDRA_AUTOPILOT_STATE: statePath },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
  }

  test("prints OK when no termination condition met", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, {});
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints TERM:budget when cumulative tokens >= budget", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, { cumulative_tokens: 2000001 });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:budget /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2429 — `TERM:budget` is a LIVE gate, NOT dead code. It reads
  // state.json's `cumulative_tokens` (the reap.py surrogate), not the Redis run
  // hash, so a run-hash value of 0 (common on a 1-2-turn print-mode run) never
  // disables it. These two cases pin the budget boundary so a future "the field
  // is always 0, remove the dead branch" change has to contradict a named test:
  // just-below-budget keeps iterating (OK), at-budget terminates (TERM:budget).
  test("does NOT trip budget when cumulative tokens are just below budget (#2429)", () => {
    const tmp = makeTempState();
    try {
      // base writeState() sets token_budget = 2_000_000.
      writeState(tmp.state, { cumulative_tokens: 1_999_999 });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK /,
        "below the budget the live gate keeps iterating — proves the branch is reachable, not dead");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("trips budget exactly AT the token_budget boundary (#2429)", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, { cumulative_tokens: 2_000_000 });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:budget /,
        "the comparison is >=, so reaching the budget exactly terminates — the gate fires on real state.json spend");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints TERM:wall_clock when elapsed >= wall_clock_max_sec", () => {
    const tmp = makeTempState();
    try {
      // Started 100 seconds ago, cap = 60
      writeState(tmp.state, {
        started_epoch: Math.floor(Date.now() / 1000) - 100,
        limits: {
          token_budget: 2000000,
          wall_clock_max_sec: 60,
          idle_drain_turns: 5,
          scope: "all",
          subagent_max_tokens: 400000,
          subagent_hard_max_tokens: 800000,
        },
      });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:wall_clock /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints TERM:idle when idle_turns >= cap AND all slots empty", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, { idle_turns: 5 });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:idle /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("does NOT trip idle when a slot is occupied", () => {
    const tmp = makeTempState();
    try {
      writeState(tmp.state, {
        idle_turns: 5,
        slots: {
          dev_orch: { skill: "hydra-dev", started: "now", partial_tokens: 0 },
          qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
      });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("prints OK state-missing when state file does not exist", () => {
    const tmp = makeTempState();
    try {
      // Don't write state file
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK state-missing$/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // Issue #2030 — the idle-drain gate (`slots_occupied == 0`) must also count
  // background/signal classes fired this run, or a background-only run trips
  // TERM:idle prematurely (the same gap #2030 fixes in the reap baton-pass).
  test("does NOT trip idle when a background class fired this run (#2030)", () => {
    const tmp = makeTempState();
    try {
      const now = Math.floor(Date.now() / 1000);
      writeState(tmp.state, {
        idle_turns: 5,           // would trip idle if slots_occupied were 0
        started_epoch: now - 10,
        slots: {                 // all pipeline slots empty
          dev_orch: null, qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
        signal_last_fired: {     // but sweep_orch fired AFTER started_epoch
          health: 0, sweep_orch: now - 2, sweep_target: 0,
          discover_orch: 0, discover_target: 0,
        },
      });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^OK /,
        "a background class in flight this run keeps the run busy — no premature TERM:idle");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("STILL trips idle when the only background fires are stale (prior run) (#2030)", () => {
    const tmp = makeTempState();
    try {
      const now = Math.floor(Date.now() / 1000);
      writeState(tmp.state, {
        idle_turns: 5,
        started_epoch: now - 10,
        slots: {
          dev_orch: null, qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
        signal_last_fired: {     // fired BEFORE this run started → not in flight
          health: 0, sweep_orch: now - 3600, sweep_target: 0,
          discover_orch: 0, discover_target: 0,
        },
      });
      const r = runTermCheck(tmp.state);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^TERM:idle /,
        "stale background fires from a prior run must not keep the run alive");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/reap.py", () => {
  function writeStateWithSlot(path: string, slot: { partial_tokens: number; skill?: string }): void {
    writeFileSync(path, JSON.stringify({
      started_epoch: Math.floor(Date.now() / 1000),
      limits: {
        token_budget: 2000000,
        wall_clock_max_sec: 28800,
        idle_drain_turns: 5,
        scope: "all",
        subagent_max_tokens: 400000,
        subagent_hard_max_tokens: 800000,
      },
      cumulative_tokens: 0,
      idle_turns: 0,
      burned_classes: [],
      slots: {
        dev_orch: { skill: slot.skill ?? "hydra-dev", started: "now", partial_tokens: slot.partial_tokens },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    }));
  }

  function runReap(statePath: string): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(join(SCRIPTS, "reap.py"), [], {
      env: {
        ...process.env,
        HYDRA_AUTOPILOT_STATE: statePath,
        // Point at a deliberately-nonexistent repo so gh fails fast
        // without contacting GitHub. reap.py marks gh issue creation
        // as non-fatal (check=False), so the state mutation still
        // happens — which is what we care about here.
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        GH_TOKEN: "invalid-test-token",
      },
      encoding: "utf-8",
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  test("under hard cap: no-op (slot preserved)", () => {
    const tmp = makeTempState();
    try {
      writeStateWithSlot(tmp.state, { partial_tokens: 100000 }); // < 800k
      const r = runReap(tmp.state);
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.notEqual(s.slots.dev_orch, null, "slot should still be occupied");
      assert.deepEqual(s.burned_classes, [], "no class should be burned yet");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("over hard cap: clears slot and marks class burned", () => {
    const tmp = makeTempState();
    try {
      writeStateWithSlot(tmp.state, { partial_tokens: 1_000_000 }); // > 800k hard cap
      const r = runReap(tmp.state);
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.slots.dev_orch, null, "slot should be cleared");
      assert.ok(s.burned_classes.includes("dev_orch"), "dev_orch should be burned");
      assert.match(r.stdout, /HARD-CAP TRIP class=dev_orch/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("missing state file: graceful no-op", () => {
    const tmp = makeTempState();
    try {
      // Don't write state file
      const r = runReap(tmp.state);
      assert.equal(r.status, 0);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/dispatch.sh log", () => {
  test("appends a single dispatch line to the run log", () => {
    const tmp = makeTempState();
    try {
      const r = spawnSync(
        join(SCRIPTS, "dispatch.sh"),
        ["log", "dev_orch", "hydra-dev", "2026-05-14T17:00:00Z"],
        {
          env: { ...process.env, HYDRA_AUTOPILOT_LOG: tmp.log },
          encoding: "utf-8",
        },
      );
      assert.equal(r.status, 0);
      const contents = readFileSync(tmp.log, "utf-8");
      assert.equal(contents, "dispatch dev_orch hydra-dev 2026-05-14T17:00:00Z\n");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("unknown subcommand exits non-zero", () => {
    const r = spawnSync(join(SCRIPTS, "dispatch.sh"), ["frobnicate"], {
      encoding: "utf-8",
    });
    assert.notEqual(r.status, 0);
  });
});

describe("scripts/autopilot/drain.sh", () => {
  test("prints final summary line with state-derived fields", () => {
    const tmp = makeTempState();
    try {
      const startedEpoch = Math.floor(Date.now() / 1000) - 3 * 3600 - 30 * 60; // 03:30 ago
      writeFileSync(tmp.state, JSON.stringify({
        started_epoch: startedEpoch,
        limits: { token_budget: 2000000 },
        cumulative_tokens: 1234567,
        dispatches: 42,
        slots: {
          dev_orch: null, qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
      }));
      const r = spawnSync(join(SCRIPTS, "drain.sh"), ["7"], {
        env: { ...process.env, HYDRA_AUTOPILOT_STATE: tmp.state, HYDRA_AUTOPILOT_LOG: tmp.log },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0);
      const out = (r.stdout ?? "").trim();
      assert.match(out, /^\[autopilot\] FINAL \| duration=03:30 \| dispatches=42 \| tokens=1234567\/2000000 \| merged_PRs=7 \| digest=/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("graceful fallback when state.json is missing", () => {
    const tmp = makeTempState();
    try {
      const r = spawnSync(join(SCRIPTS, "drain.sh"), ["0"], {
        env: { ...process.env, HYDRA_AUTOPILOT_STATE: tmp.state, HYDRA_AUTOPILOT_LOG: tmp.log },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0);
      assert.match((r.stdout ?? "").trim(), /^\[autopilot\] FINAL \| state-missing /);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/* executable bit", () => {
  test("every script is executable and has a shebang", () => {
    const scripts = [
      "bootstrap.sh",
      "collect-state.sh",
      "recover-stale.sh",
      "reap.py",
      "term-check.py",
      "dispatch.sh",
      "drain.sh",
    ];
    for (const name of scripts) {
      const path = join(SCRIPTS, name);
      assert.ok(existsSync(path), `${name} missing`);
      // Check shebang
      const first = readFileSync(path, "utf-8").split("\n", 1)[0];
      assert.match(first, /^#!/, `${name} missing shebang`);
      // Check exec bit via spawnSync --help / --version compatible probe
      // (some scripts will fail without args, but the OS exec call will succeed)
      const mode = execFileSync("stat", ["-c", "%a", path], { encoding: "utf-8" }).trim();
      // Octal mode — owner-execute bit is the first digit; should be 7xx.
      assert.match(mode, /^[7][0-9]{2}$/, `${name} not executable by owner (mode=${mode})`);
    }
  });
});

describe("collect-state.sh untriaged_orphans exclusion set (#2828, #2958)", () => {
  // collect-state.sh is network-dependent (live gh), so this pins the SOURCE:
  // the jq exclusion array must contain every operator-wait / lifecycle label.
  // Missing `ready-for-human` (#2828) and `needs-info` (#2958) each caused
  // sweep_orch re-triage churn against issues sweep cannot advance.
  test("exclusion array contains all lifecycle + operator-wait labels", () => {
    const src = readFileSync(join(SCRIPTS, "collect-state.sh"), "utf-8");
    const required = [
      "ready-for-agent",
      "in-progress",
      "blocked",
      "needs-qa",
      "needs-triage",
      "needs-research",
      "target-backlog",
      "ready-for-human",
      "needs-info",
    ];
    // Isolate the untriaged_orphans jq filter block so a label mentioned only
    // in a comment elsewhere can't satisfy the assertion.
    const start = src.indexOf('echo -n "untriaged_orphans="');
    assert.ok(start >= 0, "untriaged_orphans emitter missing from collect-state.sh");
    const block = src.slice(start, src.indexOf("| length", start));
    for (const label of required) {
      assert.ok(
        block.includes(`"${label}"`),
        `untriaged_orphans exclusion array missing "${label}"`,
      );
    }
  });
});

describe("collect-state.sh wayfinder frontier no-pick sentinel (#3400)", () => {
  // collect-state.sh is network-dependent (live gh), so this pins the SOURCE:
  // the wayfinder frontier/ticket-type extraction MUST use `cut -s` so the
  // no-pick sentinel line (`WF_MAP_LINE="0"`, no space) yields empty output and
  // the frontier stays `none`. Without `-s`, GNU cut echoes the whole line
  // ("0") when there is no delimiter, spuriously emitting
  // `wayfinder_orch_frontier=issue-0` — which decide.py's truthy-and-!=none
  // wayfinder gate accepts, dispatching wayfinder_orch against issue 0 (#3400).
  test("WF_PICK_NUM + WF_TICKET_TYPE cut both use -s (suppress no-delimiter)", () => {
    const src = readFileSync(join(SCRIPTS, "collect-state.sh"), "utf-8");
    // Isolate the frontier-extraction block so a `cut` elsewhere can't satisfy
    // the assertion; anchor on the two assignments this fix targets.
    const pickStart = src.indexOf("WF_PICK_NUM=");
    assert.ok(pickStart >= 0, "WF_PICK_NUM assignment missing from collect-state.sh");
    const block = src.slice(pickStart, src.indexOf("echo \"$WF_FRONTIER\"", pickStart));
    assert.match(
      block,
      /WF_PICK_NUM=\$\(printf '%s' "\$WF_MAP_LINE" \| cut -s -d' ' -f2\)/,
      "WF_PICK_NUM must use `cut -s` so the no-pick sentinel resolves to empty",
    );
    assert.match(
      block,
      /WF_TICKET_TYPE=\$\(printf '%s' "\$WF_MAP_LINE" \| cut -s -d' ' -f3\)/,
      "WF_TICKET_TYPE must use `cut -s` so the no-pick sentinel resolves to empty",
    );
    // Belt-and-suspenders: neither extraction may fall back to a bare `cut -d`
    // without `-s` (the exact #3400 regression).
    assert.ok(
      !/WF_PICK_NUM=\$\(printf '%s' "\$WF_MAP_LINE" \| cut -d' ' -f2\)/.test(block),
      "WF_PICK_NUM must NOT use bare `cut -d` without `-s` (#3400 regression)",
    );
  });
});
