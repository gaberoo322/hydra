/**
 * Regression test for issue #3895 — autopilot: reap.py's shared default
 * state path has no isolation; `run_completion` unconditionally cleared a
 * pipeline slot with no cross-check that the passed `task_id` matched the
 * slot's actual occupant.
 *
 * Motivating incident (autopilot run 8f86ef9b, 2026-08-06): a stray/manual
 * `reap.py completion dev_orch <fabricated-task-id> <tokens> hydra-dev`
 * invocation against the SHARED default `/tmp/hydra-autopilot-state.json`
 * (no isolation, no locking, no task_id cross-check) cleared the REAL
 * in-flight `dev_orch` slot, inflated `cumulative_tokens` by a bogus tokens
 * figure, and falsely soft-cap-burned `dev_orch` for the rest of the run.
 *
 * The fix (see `run_completion` in `scripts/autopilot/reap.py`, issue
 * #3895): before ANY state mutation, an OCCUPIED pipeline slot's stamped
 * `task_id` is cross-checked against the passed `task_id`. A mismatch
 * refuses the ENTIRE completion — no `reaped_task_ids` append, no
 * `cumulative_tokens` increment, no `burned_classes` mutation, no slot
 * mutation — and logs a `task_id_mismatch_refused` line to both stdout and
 * the run log instead of silently succeeding.
 *
 * These tests pin:
 *   1. A mismatched task_id against an occupied slot is refused: zero state
 *      mutation, a `task_id_mismatch_refused` line on stdout + run log,
 *      exit 0 (reap never hard-fails).
 *   2. A MATCHING task_id against the same occupied slot still completes
 *      normally (the guard is not a blanket refusal).
 *   3. An EMPTY/unoccupied slot (None) — the legitimate "hard-cap already
 *      fired" / late-arriving-completion case — is NOT refused; the
 *      completion proceeds exactly as before the fix.
 *   4. A signal class (no slot key at all, e.g. `sweep_orch`) is never
 *      subject to the guard — signal classes have nothing to protect.
 *   5. A slot with no stamped `task_id` field (older/partial state) fails
 *      OPEN — the completion is NOT refused, since a missing field can't
 *      prove a mismatch.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const REAP = join(SCRIPTS, "reap.py");

function makeTempState(): { dir: string; state: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-mismatch-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    log: join(dir, "nightly.log"),
  };
}

function writeBaseState(
  path: string,
  patch: Record<string, unknown> = {},
): void {
  const base: Record<string, unknown> = {
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
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
    },
    failure_log: [],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...patch }));
}

function runReap(
  args: string[],
  paths: { state: string; log: string },
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(REAP, args, {
    env: {
      ...process.env,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
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

describe("scripts/autopilot/reap.py completion — task_id/slot-occupant cross-check (issue #3895)", () => {
  test("ISSUE-3895-CASE-MISMATCH: a task_id that does NOT match the occupied slot is refused with zero state mutation", () => {
    const tmp = makeTempState();
    try {
      const REAL_TASK_ID = "worktree-agent-8f86ef9b-t3-dev_orch";
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 60,
            task_id: REAL_TASK_ID,
            branch: REAL_TASK_ID,
            partial_tokens: 0,
          },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
        },
      });

      // Stray/manual invocation with a fabricated task_id that does not
      // match the real occupant — mirrors the incident's "tRunaway" call.
      const BOGUS_TASK_ID = "tRunaway";
      const r = runReap(
        ["completion", "dev_orch", BOGUS_TASK_ID, "450000", "hydra-dev"],
        tmp,
      );
      assert.equal(r.status, 0, `mismatched reap must exit 0, not crash: ${r.stderr}`);

      assert.match(
        r.stderr,
        /task_id_mismatch_refused class=dev_orch .*passed_task_id=tRunaway .*slot_task_id=worktree-agent-8f86ef9b-t3-dev_orch/,
        "a mismatched task_id must emit a loud task_id_mismatch_refused WARN to stderr",
      );
      const log = readFileSync(tmp.log, "utf-8");
      assert.match(
        log,
        /task_id_mismatch_refused class=dev_orch .*passed_task_id=tRunaway/,
        "the refusal must also be logged to the run log for post-hoc audit",
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(
        s.cumulative_tokens,
        0,
        "a refused completion must NOT pollute cumulative_tokens (was +450000 in the incident)",
      );
      assert.deepEqual(
        s.reaped_task_ids,
        [],
        "a refused completion must NOT append the bogus task_id to the dedup ledger",
      );
      assert.deepEqual(
        s.burned_classes,
        [],
        "a refused completion must NOT burn the class (450000 tokens would trip the 400000 soft cap)",
      );
      assert.deepEqual(
        s.slots.dev_orch,
        {
          skill: "hydra-dev",
          started_epoch: s.slots.dev_orch.started_epoch,
          task_id: REAL_TASK_ID,
          branch: REAL_TASK_ID,
          partial_tokens: 0,
        },
        "the REAL occupant's slot must be left completely untouched — this is the exact corruption the issue reports",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-3895-CASE-MATCH: a task_id that DOES match the occupied slot completes normally", () => {
    const tmp = makeTempState();
    try {
      const REAL_TASK_ID = "worktree-agent-real-t1-dev_orch";
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 60,
            task_id: REAL_TASK_ID,
            partial_tokens: 0,
          },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
        },
      });

      const r = runReap(
        ["completion", "dev_orch", REAL_TASK_ID, "50000", "hydra-dev"],
        tmp,
      );
      assert.equal(r.status, 0, `matching reap must succeed: ${r.stderr}`);
      assert.ok(
        !r.stderr.includes("task_id_mismatch_refused"),
        "a matching task_id must never trip the mismatch refusal",
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, 50000, "a matching completion must still add tokens");
      assert.deepEqual(s.reaped_task_ids, [REAL_TASK_ID]);
      assert.equal(s.slots.dev_orch, null, "a matching completion must still release the slot");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-3895-CASE-EMPTY-SLOT: an unoccupied (null) slot is NOT refused — legitimate late-arriving completion", () => {
    const tmp = makeTempState();
    try {
      // dev_orch slot already cleared (e.g. hard-cap already fired) —
      // the documented legitimate case that must keep working.
      writeBaseState(tmp.state);

      const r = runReap(
        ["completion", "dev_orch", "late-arriving-task", "30000", "hydra-dev"],
        tmp,
      );
      assert.equal(r.status, 0, `empty-slot reap must succeed: ${r.stderr}`);
      assert.ok(
        !r.stderr.includes("task_id_mismatch_refused"),
        "an empty/unoccupied slot must never trip the mismatch refusal",
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, 30000, "late-arriving completion against an empty slot must still count tokens");
      assert.deepEqual(s.reaped_task_ids, ["late-arriving-task"]);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-3895-CASE-SIGNAL-CLASS: a signal class (no slot key) is never subject to the guard", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state);

      const r = runReap(
        ["completion", "sweep_orch", "any-task-id-at-all", "20000", "hydra-sweep"],
        tmp,
      );
      assert.equal(r.status, 0, `signal-class reap must succeed: ${r.stderr}`);
      assert.ok(
        !r.stderr.includes("task_id_mismatch_refused"),
        "a signal class has no slot to protect, so the guard must never fire",
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, 20000, "signal-class completion must still accumulate tokens");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-3895-CASE-NO-STAMPED-TASK-ID: a slot with no task_id field fails OPEN (not refused)", () => {
    const tmp = makeTempState();
    try {
      // Older/partial state.json shape: slot occupied but never stamped a
      // task_id field. A missing field can't prove a mismatch, so the
      // guard must not block this legitimate completion.
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 60,
            partial_tokens: 0,
            // no task_id field
          },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
        },
      });

      const r = runReap(
        ["completion", "dev_orch", "any-task-id", "10000", "hydra-dev"],
        tmp,
      );
      assert.equal(r.status, 0, `no-stamped-task_id reap must succeed: ${r.stderr}`);
      assert.ok(
        !r.stderr.includes("task_id_mismatch_refused"),
        "a slot with no stamped task_id must fail OPEN, not be refused",
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, 10000, "the completion must proceed and count tokens");
      assert.equal(s.slots.dev_orch, null, "the slot must still be released");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
