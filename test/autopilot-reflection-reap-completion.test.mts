/**
 * Regression test for issue #1820 — the LIVE-path reflection-record fire.
 *
 * #1119 Slice 1 wired `self_heal.append_failure → reap._fire_reflection_record`,
 * but `append_failure` is never called on today's hook-driven reap path, so the
 * reflection store stayed empty and `reflectionMatchSource` was permanently
 * 'none'. The fix moves the WRITE producer onto the one subprocess that runs on
 * EVERY terminal dispatch AND holds the anchor: `reap.py completion`
 * (`run_completion`). It fires a per-anchor reflection ONLY on a non-merged
 * failure, recovering:
 *   - the anchor from `slot.anchor` (stamped at dispatch time), captured before
 *     the slot is nulled, and
 *   - the failure signal from EITHER a soft token-cap trip OR a matching
 *     `failure_log` row that decide.py recorded for this task_id.
 *
 * These tests drive the real `reap.py completion` CLI against a DEAD orchestrator
 * (HYDRA_API_BASE → a closed port) so the POST always fails fast and must be
 * swallowed — reflection writes are learning, the reap path is correctness. We
 * assert the swallow line (`reflection_record_skipped anchor=<ref>`) appears on
 * a failure and is ABSENT on a clean success, and that a slot with no anchor
 * makes no fire attempt.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the reflection POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-reflection-"));
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

describe("reap.py completion → reflection-record live fire (issue #1820)", () => {
  test("a failure_log-flagged completion fires a reflection (swallowed) keyed on the slot anchor", () => {
    const tmp = makeTmp();
    try {
      // decide.py recorded a subagent_stop failure for task tF on dev_orch.
      // The slot carries `anchor` — the only place the per-cycle ref survives.
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tF",
            anchor: "issue-1820",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tF", note: "npm test failed" },
        ],
      });

      const r = runCompletion(["dev_orch", "tF", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_record_skipped anchor=issue-1820/,
        "a failed completion must attempt a reflection POST keyed on the slot anchor",
      );
      // The classified outcome must NOT be the raw decide.py pattern string —
      // it is run through the self_heal taxonomy (note 'npm test failed' →
      // verification-failure).
      assert.match(log, /outcome=verification-failure/, "the cue is classified via self_heal taxonomy");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a soft-cap token runaway fires a reflection even without a failure_log row", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tS",
            anchor: "issue-1820",
          },
        },
        failure_log: [],
      });

      // total_tokens >= subagent_max_tokens (400k) → soft-cap "failed".
      const r = runCompletion(["dev_orch", "tS", "500000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_record_skipped anchor=issue-1820/,
        "a soft-cap runaway is a non-merged failure and must fire a reflection",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a clean success (no failure signal) makes NO reflection POST attempt", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tOK",
            anchor: "issue-1820",
          },
        },
        failure_log: [],
      });

      // Under the soft cap, no failure_log row → clean completion.
      const r = runCompletion(["dev_orch", "tOK", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /reflection_record_skipped/,
        "a clean success must not attempt a reflection POST",
      );
      // It must still have reaped the slot normally.
      assert.match(log, /slot_complete .*task_id=tOK/, "the slot is still reaped on success");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a failed completion with no anchor on the slot makes NO reflection POST attempt", () => {
    const tmp = makeTmp();
    try {
      // Slot carries no `anchor` (legacy / signal-shaped dispatch).
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tNA",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tNA", note: "no-diff" },
        ],
      });

      const r = runCompletion(["dev_orch", "tNA", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /reflection_record_skipped/,
        "no anchor on the slot → no reflection POST attempt",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
