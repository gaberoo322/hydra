/**
 * Cross-run persistence of the forced-research daily cap (issue #1666,
 * QA remediation on PR #1678).
 *
 * decide.py's 4/day forced-research cap was dead code twice over:
 *
 *   1. Nothing ever WROTE research_force_counter — fixed by the
 *      plan-time stamp + CLI write-back in decide.py (tests in
 *      test/autopilot-decide.test.mts pin the within-run behavior).
 *   2. bootstrap.sh rewrites state.json from a heredoc on EVERY run and
 *      the pace-gate relaunches the autopilot ~every 15 minutes, so a
 *      counter persisted only within one run's state file degraded the
 *      documented "4/day" cap to "4/run" (design-concept Invariant 4 —
 *      the QA FAIL finding on PR #1678).
 *
 * These tests pin the bootstrap seeding half: research_force_counter is
 * carried from the prior state file into the fresh heredoc, pruned to
 * today's UTC key, degrading to {} on missing/corrupt prior state — and
 * the cap therefore holds ACROSS a bootstrap restart within one UTC day.
 *
 * All paths are env-isolated (HYDRA_AUTOPILOT_STATE/HEARTBEAT/LOG) so the
 * live /tmp state of a running autopilot is never touched — same pattern
 * as test/autopilot-scripts.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const BOOTSTRAP = join(SCRIPTS, "bootstrap.sh");
const DECIDE = join(SCRIPTS, "decide.py");

interface Tmp { dir: string; state: string; heartbeat: string; log: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-force-cap-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
    log: join(dir, "nightly.log"),
    cands: join(dir, "cands.json"),
    events: join(dir, "events.json"),
  };
}

function runBootstrap(tmp: Tmp): { status: number; stderr: string } {
  const r = spawnSync(BOOTSTRAP, [], {
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_STATE: tmp.state,
      HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
      HYDRA_AUTOPILOT_LOG: tmp.log,
      // Pin scope so a host-level HYDRA_AUTOPILOT_SCOPE (e.g. the
      // orch-only systemd drop-in) can't leak in and suppress the
      // research_target dispatches this suite depends on.
      HYDRA_AUTOPILOT_SCOPE: "all",
      PATH: process.env.PATH ?? "",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

// Minimal decide()-compatible state, mirroring baseState() in
// test/autopilot-decide.test.mts. pid is omitted so bootstrap's
// concurrent-run guard (`.pid // 0`) treats it as recoverable.
function decideState(): any {
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
    signals: {},
    research_force_counter: {},
  };
}

function runDecide(tmp: Tmp): any {
  const r = spawnSync("python3", [DECIDE, "decide", tmp.state, tmp.cands, tmp.events], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`decide.py exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

function forcedResearchDispatch(plan: any): any | undefined {
  return (plan.actions ?? []).find(
    (a: any) => a.type === "dispatch" && a.slot === "research_target",
  );
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("bootstrap.sh — research_force_counter seeding (issue #1666 / PR #1678 QA)", () => {
  test("seeds today's bucket from the prior state file and prunes stale-day keys", () => {
    const tmp = makeTmp();
    try {
      const today = todayUtc();
      writeFileSync(tmp.state, JSON.stringify({
        pid: 0,
        research_force_counter: {
          [today]: { research_target: 3 },
          "2000-01-01": { research_target: 9 },
        },
      }));
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(
        s.research_force_counter,
        { [today]: { research_target: 3 } },
        "today's bucket must survive the heredoc rewrite; stale days must be pruned",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("degrades to {} when there is no prior state file", () => {
    const tmp = makeTmp();
    try {
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(s.research_force_counter, {},
        "fresh install must start with an empty counter, not a missing field");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("degrades to {} on unparseable prior state (fail-open, never blocks bootstrap)", () => {
    const tmp = makeTmp();
    try {
      writeFileSync(tmp.state, "not json at all");
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap must not abort on corrupt prior state: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(s.research_force_counter, {});
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("degrades to {} when the prior counter has a non-object shape", () => {
    const tmp = makeTmp();
    try {
      writeFileSync(tmp.state, JSON.stringify({ pid: 0, research_force_counter: "corrupt" }));
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(s.research_force_counter, {});
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("post-#3832: decide() no longer forces research_target, yet bootstrap still preserves a pre-seeded counter across a restart (#1666 / #3832)", () => {
    // ISSUE #3832 removed the candidate-feed forced-research branch — the
    // ONLY decide() writer of research_force_counter — so the counter can no
    // longer be ACCUMULATED through decide() to reconstruct the original
    // PR-#1678 QA scenario (drive the counter to 4 across a bootstrap
    // restart via forced dispatches, 5th suppressed). Pin the new reality
    // end-to-end: (a) decide() stays silent on an empty retired feed (no
    // forced dispatch, no counter stamp), and (b) bootstrap still preserves a
    // pre-existing counter across a restart — the actual #1666 fix location,
    // retained so a future forced-research producer would see a per-DAY (not
    // per-run) cap.
    const tmp = makeTmp();
    try {
      const today = todayUtc();
      writeFileSync(tmp.state, JSON.stringify(decideState()));
      writeFileSync(tmp.cands, JSON.stringify({ candidates: [], research_recommended: true }));
      writeFileSync(tmp.events, JSON.stringify([]));

      // (a) decide() no longer forces research_target from the retired feed.
      const d = forcedResearchDispatch(runDecide(tmp));
      assert.equal(d, undefined,
        "the retired candidate feed must not force research_target (#3832)");
      const afterDecide = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(afterDecide.research_force_counter, {},
        "with the trigger gone, decide() must not stamp the counter");

      // (b) Bootstrap still preserves a pre-seeded counter across a restart.
      writeFileSync(tmp.state, JSON.stringify({
        pid: 0,
        research_force_counter: { [today]: { research_target: 2 } },
      }));
      const r = runBootstrap(tmp);
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      const reborn = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(
        reborn.research_force_counter,
        { [today]: { research_target: 2 } },
        "a pre-seeded counter must survive the bootstrap heredoc rewrite (#1666 per-DAY, not per-run)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
