/**
 * Regression test for issue #3391 — reap keys its cycle-record on the synthesised
 * worktree branch so `testsAfter` stops recording 0 on the dashboards' record.
 *
 * Root cause (grounded in live Redis, 2026-07-16): per code-writing dispatch reap
 * wrote its test-count-bearing cycle-record under the bare worktree-hash
 * `task_id`, while the merge-watch enrichment (holdback-merge-watch.ts) + the
 * trend/dashboard read the SEPARATE record keyed on the run-token-shaped
 * synthesised `worktreeBranch` (`worktree-agent-<runToken>-t<N>-<slot>`). The two
 * ids are un-joinable, so the sampled record never received `testsAfter` and it
 * recorded 0 every cycle. The #3252 TS mirror bridged onto a THIRD un-indexed
 * twin and was discarded by the trend read's `if (!raw.cycleId) continue` guard.
 *
 * Fix: reap now POSTs its cycle-record under the branch itself (when a slot
 * branch is present), so the test counts and the merge fields converge on ONE
 * indexed record. A signal-class / cleared-slot completion has no branch, so it
 * keeps keying on the task_id (its cycleId IS the task_id).
 *
 * These tests drive the real `reap.py completion` CLI against a DEAD orchestrator
 * (the cycle-record POST inside dispatch.sh fails fast and is swallowed —
 * observability, not correctness). reap logs the chosen key to the run log as a
 * `cycle_record_fired cycleId=<X>` line BEFORE firing the (uninspectable) POST,
 * so we assert on that line — mirroring how the #1591 `duration_ms` and #2952
 * `token_record_skipped cycleId=<X>` fields are asserted in the sibling reap
 * tests.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the cycle-record POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-branchcycle-"));
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function writeState(path: string, patch: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    slots: {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
    },
    signal_last_fired: {},
    failure_log: [],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...patch }));
}

function runCompletion(
  args: string[],
  paths: Paths,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      // Keep the worktree-GC side-effect out of the test.
      HYDRA_REAP_WORKTREE_GC: "0",
      // Issue #3866: reap.py's dev_orch no-PR-stall check shells out to a REAL
      // `gh pr list`/`gh issue edit`/`gh issue comment` against
      // HYDRA_AUTOPILOT_REPO whenever a dev_orch completion carries an anchor
      // with no open PR — which this suite's fixtures do. Point it at a
      // nonexistent fixture repo with an invalid token (same pattern as
      // test/autopilot-reap-task-id-mismatch.test.mts) so it can never touch
      // the real gaberoo322/hydra repo.
      HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
      GH_TOKEN: "invalid-test-token",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

// Issue #3970: the default-mode hard-cap sweep files a REAL GitHub issue on a
// runaway slot (`gh issue create`). Stub `gh` on PATH so the test never opens
// one — the issue-filing is incidental to the cycle-record keying under test.
function runHardcap(
  paths: Paths,
): { status: number; stdout: string; stderr: string } {
  const binDir = join(paths.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(binDir, "gh"), 0o755);
  const r = spawnSync("python3", [REAP], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HYDRA_API_BASE: DEAD_API_BASE,
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      HYDRA_REAP_WORKTREE_GC: "0",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runGrillCrash(
  taskId: string,
  paths: Paths,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [REAP, "grill-crash", taskId], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      HYDRA_REAP_WORKTREE_GC: "0",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("reap.py completion → cycle-record keyed on the worktree branch (issue #3391)", () => {
  test("a pipeline completion with a slot branch fires the cycle-record under the BRANCH cycleId", () => {
    const tmp = makeTmp();
    try {
      const branch = "worktree-agent-3391aaaa-t2-dev_orch";
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "t3391",
            anchor: "issue-3391",
            branch,
          },
        },
      });

      const r = runCompletion(["dev_orch", "t3391", "12345", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      // The cycle-record fires under the BRANCH id (the id merge-watch enriches),
      // not the bare task_id — that convergence is the whole fix.
      assert.match(
        log,
        new RegExp(`cycle_record_fired cycleId=${branch} task_id=t3391 skill=hydra-dev`),
        "the cycle-record must be keyed on the synthesised worktree branch",
      );
      // It must NOT be keyed on the bare task_id (the un-joinable twin).
      assert.doesNotMatch(
        log,
        /cycle_record_fired cycleId=t3391 /,
        "the cycle-record must not be keyed on the bare worktree-hash task_id",
      );
      assert.match(log, /slot_complete .*task_id=t3391/, "the slot is still reaped");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a signal-class completion (no slot branch) keeps keying the cycle-record on the task_id", () => {
    const tmp = makeTmp();
    try {
      // hydra-grill is in CYCLE_RECORD_SKILLS but is a signal-shaped dispatch with
      // no pipeline slot / branch — its cycleId IS the task_id.
      writeState(tmp.state, { slots: {} });

      const r = runCompletion(["grill_orch", "tGrill", "5000", "hydra-grill"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /cycle_record_fired cycleId=tGrill task_id=tGrill skill=hydra-grill/,
        "a branch-less completion keys the cycle-record on the task_id",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a non-code-writing, non-escalated completion fires NO cycle-record at all", () => {
    const tmp = makeTmp();
    try {
      // hydra-research is outside CYCLE_RECORD_SKILLS and carries no escalation
      // blob, so the cycle-record gate short-circuits before any fire.
      writeState(tmp.state, { slots: {} });

      const r = runCompletion(["research_orch", "tRes", "5000", "hydra-research"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /cycle_record_fired/,
        "a non-code-writing completion must not fire a cycle-record",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("reap.py terminal-failure write sites → cycle-record keyed on the worktree branch (issue #3970)", () => {
  // The two terminal-failure reap paths — run_hardcap's runaway-abandon sweep
  // and run_grill_crash — previously captured (task_id, skill, anchor) from the
  // live slot but NEVER the branch, so their failed cycle-record unconditionally
  // keyed on the bare task_id (an un-joinable record). #3970 extends
  // run_completion's #3391 branch-capture-before-null pattern to both sites.
  // They are twin-safe to fix (INV-3): a hard-cap trip and a grill crash never
  // open a PR, so they never reach the merge-watch enrichment that would
  // otherwise re-key on a different id.

  test("a hard-cap trip on a slot WITH a branch fires the cycle-record under the BRANCH cycleId", () => {
    const tmp = makeTmp();
    try {
      const branch = "worktree-agent-3970aaaa-t3-dev_orch";
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "t3970hc",
            anchor: "issue-3970",
            branch,
            // partial_tokens >= subagent_hard_max_tokens (800_000) trips the cap.
            partial_tokens: 900_000,
          },
        },
      });

      const r = runHardcap(tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        new RegExp(`cycle_record_fired cycleId=${branch} task_id=t3970hc skill=hydra-dev status=failed`),
        "a hard-capped slot with a branch must key its failed cycle-record on the branch",
      );
      assert.doesNotMatch(
        log,
        /cycle_record_fired cycleId=t3970hc /,
        "the hard-cap cycle-record must not key on the bare task_id when a branch was present",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a hard-cap trip on a branch-less slot still keys the cycle-record on the task_id (INV-4 fallback)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "t3970nofb",
            anchor: "issue-3970",
            // No branch field — the documented dominant gap. The fallback must
            // keep keying on the bare task_id byte-for-byte with prior behaviour.
            partial_tokens: 900_000,
          },
        },
      });

      const r = runHardcap(tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /cycle_record_fired cycleId=t3970nofb task_id=t3970nofb skill=hydra-dev status=failed/,
        "a branch-less hard-capped slot keys its cycle-record on the bare task_id",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a grill crash on a design_concept_orch slot WITH a branch fires the cycle-record under the BRANCH cycleId", () => {
    const tmp = makeTmp();
    try {
      const branch = "worktree-agent-3970bbbb-t2-design_concept_orch";
      writeState(tmp.state, {
        slots: {
          design_concept_orch: {
            skill: "hydra-grill",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "t3970gc",
            branch,
          },
        },
      });

      const r = runGrillCrash("t3970gc", tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        new RegExp(`cycle_record_fired cycleId=${branch} task_id=t3970gc skill=hydra-grill status=failed`),
        "a grill crash on a slot with a branch must key its failed cycle-record on the branch",
      );
      assert.doesNotMatch(
        log,
        /cycle_record_fired cycleId=t3970gc /,
        "the grill-crash cycle-record must not key on the bare task_id when a branch was present",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
