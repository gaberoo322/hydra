/**
 * Regression tests for reap.py populating cycle-record `task_title` from the
 * slot anchor (issue #2012).
 *
 * Bug: `reap._fire_cycle_record` hardcoded BOTH the `task_title` (positional 5)
 * and `anchor_ref` (positional 6) args it passes to `dispatch.sh cycle-record`
 * to the empty string. The empty string is stripped before storage, so a
 * SUCCESSFUL hydra-dev / hydra-grill merge for a named issue stored
 * `taskTitle == null` in its Redis cycle record. Naive no-task counters then
 * mistook those merges for no-op cycles — the #1832 hydra-discover false
 * "54% no-task regression" on a system actually merging 88–100% of cycles.
 *
 * Fix: `run_completion` already recovers the per-cycle anchor reference from
 * `slot.anchor` (e.g. "issue-2012") before the slot is nulled. reap now
 * forwards that anchor as the cycle-record `task_title` + `anchor_ref`, so a
 * cycle that merged a PR for a named issue carries a non-null `taskTitle`.
 * A genuinely task-less dispatch (no slot anchor) stays "" → dispatch.sh omits
 * the field → truthful null.
 *
 * These tests drive the real `reap.py completion` CLI against a DEAD
 * orchestrator (the cycle-record POST inside dispatch.sh fails fast and is
 * swallowed — observability, not correctness). We assert the OBSERVABLE proxy:
 * the `slot_complete` run-log line now carries a `task_title=<anchor>` field
 * (the cycle-record POST body itself goes to the dead API), mirroring how the
 * #1591 `duration_ms` field is asserted in autopilot-dedup-reap.test.mts.
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
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-tasktitle-"));
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

describe("reap.py completion → cycle-record task_title from slot anchor (issue #2012)", () => {
  test("a merged named-issue cycle carries the slot anchor as task_title", () => {
    const tmp = makeTmp();
    try {
      // The slot carries `anchor` = "issue-2012" — the resolvable task title.
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "t2012",
            anchor: "issue-2012",
          },
        },
        failure_log: [],
      });

      const r = runCompletion(["dev_orch", "t2012", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      // The slot_complete line now surfaces the task_title forwarded to the
      // cycle-record write — non-empty for a named-issue cycle.
      assert.match(
        log,
        /slot_complete .*task_id=t2012.* task_title=issue-2012/,
        "a merged named-issue cycle must forward the slot anchor as task_title",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an anchor-less slot keeps an empty task_title (truthful null)", () => {
    const tmp = makeTmp();
    try {
      // Slot carries NO `anchor` (legacy / signal-shaped dispatch).
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tNoAnchor",
          },
        },
        failure_log: [],
      });

      const r = runCompletion(["dev_orch", "tNoAnchor", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      // The field is present but empty — a genuinely task-less dispatch stays
      // null downstream (dispatch.sh omits the empty field).
      assert.match(
        log,
        /slot_complete .*task_id=tNoAnchor.* task_title=(\s|$)/,
        "an anchor-less slot must leave task_title empty (truthful null)",
      );
      assert.doesNotMatch(
        log,
        /slot_complete .*task_id=tNoAnchor.* task_title=\S/,
        "an anchor-less slot must not fabricate a non-empty task_title",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
