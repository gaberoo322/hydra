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
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
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
