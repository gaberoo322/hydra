/**
 * Regression test for issue #411 — autopilot: idempotent subagent reap
 * (dedup by task ID).
 *
 * Motivating observation (autopilot run 2026-05-14): task ID
 * `a153eb193e1b05209` (hydra-qa on PR #402) fired three completion
 * notifications hours apart. The model noticed manually and added
 * tokens only once, but if Phase 2 were running unattended through
 * `scripts/autopilot/reap.py completion`, the tokens would have been
 * triple-counted. This test pins the dedup ledger so a future edit to
 * `reap.py` or `bootstrap.sh` cannot silently regress.
 *
 * The dedup invariants under test:
 *
 * 1. bootstrap.sh initialises `reaped_task_ids: []` on a fresh state.json.
 * 2. First reap for a given `task_id` mutates state (token accounting,
 *    slot release, slot.tokens recorded, burned_classes on soft-cap
 *    trip, task_id appended to `reaped_task_ids`).
 * 3. Repeat reap with the same `task_id` is a no-op — emits
 *    `dup_skip task_id=<X>` to the run log and exits 0 without mutating
 *    cumulative_tokens, slots, or burned_classes.
 * 4. `reaped_task_ids` is FIFO-bounded to the most-recent 1000 entries
 *    so state.json stays bounded across long autopilot sessions.
 * 5. Backward compat: an older state.json written before #411 (no
 *    `reaped_task_ids` field) is tolerated — the script defaults the
 *    field to [] and proceeds normally.
 *
 * Network-dependent paths (gh issue create on hard-cap trip) are NOT
 * exercised here — that's covered by autopilot-scripts.test.mts.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const REAP = join(SCRIPTS, "reap.py");
const BOOTSTRAP = join(SCRIPTS, "bootstrap.sh");

// A closed port — reap.py defaults HYDRA_API_BASE to the live orchestrator on
// :4000, and without an override this test's completion calls POST fabricated
// hydra-discover token records straight into production Redis (issue #3915).
const DEAD_API_BASE = "http://127.0.0.1:1";

function makeTempState(): { dir: string; state: string; heartbeat: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dedup-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    heartbeat: join(dir, "heartbeat.txt"),
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
    // Post-#426 schema: 6 fixed pipeline slots.
    slots: {
      dev_orch: null,
      qa_orch: { skill: "hydra-qa", started: "now", partial_tokens: 0 },
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
      HYDRA_API_BASE: DEAD_API_BASE,
      // The cycle-record POST rides dispatch.sh's `hydra` CLI / curl fallback,
      // which read HYDRA_BASE_URL / HYDRA_API — pin them to the dead port too
      // so nothing leaks to the live orchestrator on :4000.
      HYDRA_BASE_URL: DEAD_API_BASE,
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

describe("scripts/autopilot/bootstrap.sh initializes reaped_task_ids (issue #411)", () => {
  test("fresh state.json contains a top-level reaped_task_ids: []", () => {
    // Isolate via HYDRA_AUTOPILOT_STATE/HEARTBEAT/LOG so the test never
    // touches the live /tmp/hydra-autopilot-state.json or POSTs a fake
    // run to the live API (root cause of 2026-05-26 dashboard ghost-outage).
    const tmp = makeTempState();
    try {
      const r = spawnSync(BOOTSTRAP, [], {
        env: {
          ...process.env,
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
          HYDRA_AUTOPILOT_LOG: tmp.log,
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      assert.ok(existsSync(tmp.state), "bootstrap should write state.json at the isolated path");
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        Array.isArray(s.reaped_task_ids),
        "reaped_task_ids must be an array at bootstrap",
      );
      assert.equal(s.reaped_task_ids.length, 0, "reaped_task_ids must start empty");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/autopilot/reap.py completion — dedup by task_id (issue #411)", () => {
  // ISSUE-411-CASE-DEDUP-NOOP — first reap adds tokens; second reap with
  // the same task_id is a no-op. This is the case that proves the dedup
  // behaviour from the motivating autopilot observation.
  test("ISSUE-411-CASE-DEDUP-NOOP: first reap adds tokens; second reap with same task_id is a no-op", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state);
      const TASK = "a153eb193e1b05209"; // matches the motivating observation
      const TOKENS = 50_000;

      // First reap: state mutates.
      const first = runReap(
        ["completion", "qa_orch", TASK, String(TOKENS), "hydra-qa"],
        tmp,
      );
      assert.equal(first.status, 0, `first reap failed: ${first.stderr}`);
      let s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, TOKENS, "first reap must add tokens");
      assert.deepEqual(s.reaped_task_ids, [TASK], "task_id must be appended");
      assert.equal(s.slots.qa_orch, null, "slot must be released after first reap");
      const logAfterFirst = readFileSync(tmp.log, "utf-8");
      assert.match(logAfterFirst, /slot_complete .*task_id=a153eb193e1b05209/);

      // Second reap: SAME task_id. Must be a complete no-op on state.
      const second = runReap(
        ["completion", "qa_orch", TASK, String(TOKENS), "hydra-qa"],
        tmp,
      );
      assert.equal(second.status, 0, `second reap failed: ${second.stderr}`);
      s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(
        s.cumulative_tokens,
        TOKENS,
        "duplicate reap must NOT add tokens — would have tripled in the wild",
      );
      assert.deepEqual(
        s.reaped_task_ids,
        [TASK],
        "duplicate reap must not re-append task_id",
      );
      assert.match(
        second.stdout,
        /dup_skip task_id=a153eb193e1b05209/,
        "duplicate reap must emit dup_skip to stdout",
      );
      const logAfterSecond = readFileSync(tmp.log, "utf-8");
      assert.match(
        logAfterSecond,
        /dup_skip task_id=a153eb193e1b05209/,
        "duplicate reap must emit dup_skip to run log",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("distinct task_ids are independent — both count", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state);
      const r1 = runReap(["completion", "qa_orch", "task-A", "10000", "hydra-qa"], tmp);
      assert.equal(r1.status, 0);
      // Slot was released by first reap; the second reap targets a
      // different class that's still occupied. Re-seed dev_orch.
      const s1 = JSON.parse(readFileSync(tmp.state, "utf-8"));
      s1.slots.dev_orch = { skill: "hydra-dev", started: "now", partial_tokens: 0 };
      writeFileSync(tmp.state, JSON.stringify(s1));

      const r2 = runReap(
        ["completion", "dev_orch", "task-B", "20000", "hydra-dev"],
        tmp,
      );
      assert.equal(r2.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, 30000, "distinct task_ids must both add tokens");
      assert.deepEqual(s.reaped_task_ids, ["task-A", "task-B"]);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("soft-cap trip on first reap appends class to burned_classes; dup does not re-burn", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state);
      const OVER_SOFT = 500_000; // > 400k soft cap, < 800k hard cap
      const TASK = "soft-trip-task";

      const r1 = runReap(
        ["completion", "qa_orch", TASK, String(OVER_SOFT), "hydra-qa"],
        tmp,
      );
      assert.equal(r1.status, 0);
      let s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        s.burned_classes.includes("qa_orch"),
        "soft-cap trip must burn the class",
      );
      assert.equal(s.burned_classes.filter((c: string) => c === "qa_orch").length, 1);

      // Duplicate must not double-burn nor re-append (idempotent).
      const r2 = runReap(
        ["completion", "qa_orch", TASK, String(OVER_SOFT), "hydra-qa"],
        tmp,
      );
      assert.equal(r2.status, 0);
      s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(
        s.burned_classes.filter((c: string) => c === "qa_orch").length,
        1,
        "duplicate reap must not duplicate burned_classes entry",
      );
      assert.equal(s.cumulative_tokens, OVER_SOFT, "duplicate reap must not double tokens");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("reaped_task_ids is FIFO-bounded to the most recent 1000 entries", () => {
    const tmp = makeTempState();
    try {
      // Pre-seed the ledger right at the cap with synthetic IDs.
      const pre: string[] = [];
      for (let i = 0; i < 1000; i++) pre.push(`old-${i}`);
      writeBaseState(tmp.state, { reaped_task_ids: pre });

      const NEW = "fresh-task-x";
      const r = runReap(["completion", "qa_orch", NEW, "1000", "hydra-qa"], tmp);
      assert.equal(r.status, 0, `bounded reap failed: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(
        s.reaped_task_ids.length,
        1000,
        "ledger must stay bounded at 1000 entries",
      );
      assert.equal(
        s.reaped_task_ids[s.reaped_task_ids.length - 1],
        NEW,
        "newest task_id must be retained at the tail",
      );
      assert.equal(
        s.reaped_task_ids[0],
        "old-1",
        "FIFO eviction must drop the oldest entry (old-0)",
      );
      assert.equal(
        s.reaped_task_ids.includes("old-0"),
        false,
        "oldest entry must be evicted",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("backward compat: state.json without reaped_task_ids field is tolerated", () => {
    const tmp = makeTempState();
    try {
      // Simulate an older state.json (pre-#411) — no reaped_task_ids field.
      writeBaseState(tmp.state);
      const s0 = JSON.parse(readFileSync(tmp.state, "utf-8"));
      delete s0.reaped_task_ids;
      writeFileSync(tmp.state, JSON.stringify(s0));

      const r = runReap(
        ["completion", "qa_orch", "legacy-task", "5000", "hydra-qa"],
        tmp,
      );
      assert.equal(r.status, 0, `legacy reap must not crash: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.deepEqual(
        s.reaped_task_ids,
        ["legacy-task"],
        "missing field must default to [] and accept the new task_id",
      );
      assert.equal(s.cumulative_tokens, 5000);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Signal-class reap (issue #432)
  // ---------------------------------------------------------------------
  //
  // Until #432 the soft-cap burn was nested inside the `if slot is not
  // None` branch in reap.py, which meant signal classes (health,
  // sweep_*, discover_*) — which never occupy a slot — could run hot
  // without ever getting burned. cumulative_tokens still incremented,
  // but a runaway hydra-discover would keep getting re-dispatched.
  // These tests pin the fix.

  test("ISSUE-432: signal-class completion increments cumulative_tokens (no slot to clear)", () => {
    const tmp = makeTempState();
    try {
      // Fresh state — no slot occupied. Signal classes never had one.
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: null, qa_orch: null, research_orch: null,
          dev_target: null, qa_target: null, research_target: null,
        },
      });
      const r = runReap(
        ["completion", "discover_orch", "aa6ce268f0b849876", "42500", "hydra-discover"],
        tmp,
      );
      assert.equal(r.status, 0, `signal reap failed: ${r.stderr}`);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(
        s.cumulative_tokens,
        42500,
        "signal-class completion must accumulate tokens (was 0 before #432 fix)",
      );
      assert.deepEqual(
        s.reaped_task_ids,
        ["aa6ce268f0b849876"],
        "signal task_id must be appended to the dedup ledger",
      );
      // state.slots must not gain a new key.
      assert.equal(
        Object.prototype.hasOwnProperty.call(s.slots, "discover_orch"),
        false,
        "signal class must NOT pollute state.slots (pipeline-only)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-432: signal-class completion still gets soft-cap burned when tokens >= soft", () => {
    // Latent bug fixed alongside #432: signal classes could never get
    // burned because the burn logic was inside the pipeline-only branch.
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state);
      const OVER_SOFT = 500_000; // > 400k soft cap
      const r = runReap(
        ["completion", "discover_orch", "runaway-task", String(OVER_SOFT), "hydra-discover"],
        tmp,
      );
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        s.burned_classes.includes("discover_orch"),
        "runaway signal class must be burned on soft-cap trip (was missing pre-#432)",
      );
      assert.equal(s.cumulative_tokens, OVER_SOFT);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-432: signal-class reap is idempotent (dup_skip on second call)", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state);
      const TASK = "a0d9717fb4681215c";
      const r1 = runReap(
        ["completion", "sweep_orch", TASK, "18200", "hydra-sweep"],
        tmp,
      );
      assert.equal(r1.status, 0);
      const r2 = runReap(
        ["completion", "sweep_orch", TASK, "18200", "hydra-sweep"],
        tmp,
      );
      assert.equal(r2.status, 0);
      assert.match(r2.stdout, /dup_skip task_id=a0d9717fb4681215c/);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.cumulative_tokens, 18200, "duplicate signal reap must not double-count");
      assert.deepEqual(s.reaped_task_ids, [TASK]);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Cycle-duration on reap (issue #1591)
  // ---------------------------------------------------------------------
  //
  // Bug: reap.py hardcoded duration_ms="0" on EVERY cycle-record write, so
  // betting/target cycles (which only ever got their cycle record from the
  // reap path) recorded totalDurationMs=0 — the 46% dropout in #1591. Only
  // orchestrator cycles that got a model-fired auto-merge follow-up ever
  // carried a real duration. The fix computes the wall-clock span from the
  // slot's dispatch-start stamp (`started_epoch` / legacy `started` ISO8601)
  // at reap time, for BOTH dev_orch and dev_target. The deterministic,
  // network-free observable is the `duration_ms=<N>` field on the
  // `slot_complete` run-log line (the cycle-record POST itself goes to the
  // live API, which this isolated test never reaches).

  test("ISSUE-1591: a dev_target completion records a NON-ZERO duration_ms from the slot start stamp", () => {
    const tmp = makeTempState();
    try {
      // Slot dispatched ~5 minutes ago — a realistic betting/target build.
      const startedEpoch = Math.floor(Date.now() / 1000) - 300;
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: null,
          qa_orch: null,
          research_orch: null,
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: startedEpoch,
            task_id: "betting-build-1591",
            partial_tokens: 0,
          },
          qa_target: null,
          research_target: null,
        },
      });

      const r = runReap(
        ["completion", "dev_target", "betting-build-1591", "120000", "hydra-target-build"],
        tmp,
      );
      assert.equal(r.status, 0, `target reap failed: ${r.stderr}`);

      const log = readFileSync(tmp.log, "utf-8");
      const m = log.match(/slot_complete .*task_id=betting-build-1591.* duration_ms=(\d+)/);
      assert.ok(
        m,
        "slot_complete line must carry a duration_ms field (absent entirely before the #1591 fix)",
      );
      const durationMs = Number(m![1]);
      assert.ok(
        durationMs > 0,
        `target cycle duration_ms must be > 0 (got ${durationMs}); the #1591 bug recorded 0`,
      );
      // Sanity: ~5 minutes (300_000ms) within a generous wall-clock window.
      assert.ok(
        durationMs >= 290_000 && durationMs <= 600_000,
        `duration_ms must reflect the ~5min slot age (got ${durationMs})`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-1591: legacy `started` ISO8601 slot stamp also yields a non-zero duration_ms", () => {
    const tmp = makeTempState();
    try {
      // Older state.json shape: ISO8601 `started`, no `started_epoch`.
      const startedIso = new Date(Date.now() - 120_000).toISOString();
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started: startedIso,
            task_id: "legacy-iso-task",
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
        ["completion", "dev_orch", "legacy-iso-task", "80000", "hydra-dev"],
        tmp,
      );
      assert.equal(r.status, 0, `legacy-iso reap failed: ${r.stderr}`);

      const log = readFileSync(tmp.log, "utf-8");
      const m = log.match(/slot_complete .*task_id=legacy-iso-task.* duration_ms=(\d+)/);
      assert.ok(m, "slot_complete line must carry a duration_ms field");
      assert.ok(
        Number(m![1]) > 0,
        `legacy ISO8601 start stamp must still compute a non-zero duration_ms (got ${m![1]})`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("ISSUE-1591: a slot with no start stamp records duration_ms=0 (truthful fallback)", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: null,
          qa_orch: null,
          research_orch: null,
          // No started_epoch / started — the unknown-start case.
          dev_target: { skill: "hydra-target-build", task_id: "no-stamp", partial_tokens: 0 },
          qa_target: null,
          research_target: null,
        },
      });

      const r = runReap(
        ["completion", "dev_target", "no-stamp", "50000", "hydra-target-build"],
        tmp,
      );
      assert.equal(r.status, 0, `no-stamp reap failed: ${r.stderr}`);

      const log = readFileSync(tmp.log, "utf-8");
      const m = log.match(/slot_complete .*task_id=no-stamp.* duration_ms=(\d+)/);
      assert.ok(m, "slot_complete line must always carry a duration_ms field");
      assert.equal(
        Number(m![1]),
        0,
        "a missing start stamp must fall back to duration_ms=0, never crash or fabricate",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("default invocation (no subcommand) still runs hard-cap enforcement", () => {
    // Sanity check that adding the `completion` subcommand did not
    // regress the pre-existing default-mode behaviour exercised by
    // autopilot-scripts.test.mts.
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: { skill: "hydra-dev", started: "now", partial_tokens: 1_000_000 },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
        },
      });
      const r = runReap([], tmp);
      assert.equal(r.status, 0);
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.slots.dev_orch, null, "hard-cap path must still clear the slot");
      assert.ok(s.burned_classes.includes("dev_orch"));
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #4304 — the snapshot-before-mutate boundary inside run_completion
// (architecture-scan finding; the sprawl ratchet #4134 forbids a new file for
// this subject, so these cases join the existing `reap.py completion` suite).
//
// The slot-derived reads run_completion's fire steps depend on (anchor_ref /
// worktree_branch / duration_ms) used to live inline in the function body,
// ordered before the slot-nulling mutation only by prose comments ("capture
// ... BEFORE the slot is nulled", cited against #1591 / #1820 / #3391) — the
// exact ordering discipline that #2112 and #3785 each broke in production
// (a read helper correctly PLACED but fed by a field nothing populated in
// time). The restructure names the boundary so the ordering is a data
// dependency, not a comment:
//
//   _snapshot_completion_slot(s, cls, task_id) -> frozen CompletionSnapshot
//     — the ONLY reader of s.slots[cls] on the completion path (past the
//       #3895 task_id-mismatch probe at the top of the guards);
//   _release_pipeline_slot(s, cls, total_tokens)
//     — the ONLY mutation of s.slots[cls] (stamp tokens + null).
//
// Cases 1-3 unit-test the snapshot builder by importing reap.py as a module:
//   1. occupied slot → captures anchor/branch/duration and leaves state
//      byte-identical (a pure read — the builder must never mutate);
//   2. the returned record is frozen (interpreter-enforced immutability);
//   3. signal class (no slot) → None/None/0/False and NO branch-recovery
//      attempt (the #3785 gate: recovery is pipeline-only).
// Case 4 spies the two boundary functions from inside run_completion:
//   4. the slot is read exactly once, through the snapshot builder, STRICTLY
//      before the release mutation — the temporal coupling the comments used
//      to carry, now asserted by the interpreter.
// Case 5 is the CLI-level regression net for the restructure:
//   5. a stamped slot's anchor/branch/duration all survive into the
//      post-null fire steps (slot_complete line + cycle_record_fired key).
// ---------------------------------------------------------------------------
describe("scripts/autopilot/reap.py completion — snapshot-before-mutate boundary (issue #4304)", () => {
  // Import reap.py as a module (its __main__ guard keeps import side-effect
  // free) so the boundary functions can be unit-tested in isolation. Env is
  // pinned the same way runReap pins it — dead API base, isolated
  // state/log/refl paths, a `true` redis-cli stub (branch recovery + the
  // cross-run mirror become instant no-ops), and worktree GC off.
  function runPython(code: string, tmp: { dir: string; state: string; log: string }):
    { status: number; stdout: string; stderr: string } {
    const r = spawnSync("python3", ["-c", code], {
      env: {
        ...process.env,
        REAP_PATH: REAP,
        HYDRA_API_BASE: DEAD_API_BASE,
        HYDRA_BASE_URL: DEAD_API_BASE,
        HYDRA_AUTOPILOT_STATE: tmp.state,
        HYDRA_AUTOPILOT_LOG: tmp.log,
        HYDRA_AUTOPILOT_REFL_DIR: tmp.dir,
        HYDRA_AUTOPILOT_REDIS_CLI: "true",
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        GH_TOKEN: "invalid-test-token",
        HYDRA_REAP_WORKTREE_GC: "0",
      },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function runCompletionSnapshot(
    args: string[],
    paths: { state: string; log: string; dir: string },
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(REAP, ["completion", ...args], {
      env: {
        ...process.env,
        HYDRA_API_BASE: DEAD_API_BASE,
        HYDRA_BASE_URL: DEAD_API_BASE,
        HYDRA_AUTOPILOT_STATE: paths.state,
        HYDRA_AUTOPILOT_LOG: paths.log,
        HYDRA_AUTOPILOT_REFL_DIR: paths.dir,
        HYDRA_AUTOPILOT_REDIS_CLI: "true",
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        GH_TOKEN: "invalid-test-token",
        HYDRA_REAP_WORKTREE_GC: "0",
      },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("snapshot builder captures an occupied slot's fields and mutates nothing (pure read)", () => {
    const tmp = makeTempState();
    try {
      const r = runPython(`
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("reap_u", os.environ["REAP_PATH"])
reap = importlib.util.module_from_spec(spec)
# Register BEFORE exec_module: reap.py uses PEP 563 future annotations,
# so @dataclass resolves cls.__module__ through sys.modules and an
# unregistered module makes the decorator blow up with a bare
# AttributeError on NoneType.
sys.modules["reap_u"] = reap
spec.loader.exec_module(reap)
state = {
    "limits": {},
    "slots": {"dev_orch": {
        "task_id": "task-snap-1",
        "skill": "hydra-dev",
        "started_epoch": int(time.time()) - 4,
        "anchor": "issue-4304",
        "branch": "worktree-agent-run9-t2-dev_orch",
    }},
}
before = json.dumps(state, sort_keys=True)
snap = reap._snapshot_completion_slot(state, "dev_orch", "task-snap-1")
after = json.dumps(state, sort_keys=True)
print(json.dumps({
    "pure_read": before == after,
    "anchor_ref": snap.anchor_ref,
    "worktree_branch": snap.worktree_branch,
    "duration_ms": snap.duration_ms,
    "slot_occupied": snap.slot_occupied,
}))
`, tmp);
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.pure_read, true, "snapshot builder must not mutate state");
      assert.equal(out.anchor_ref, "issue-4304", "slot-stamped anchor must be captured");
      assert.equal(
        out.worktree_branch,
        "worktree-agent-run9-t2-dev_orch",
        "slot-stamped branch must be captured",
      );
      assert.ok(
        out.duration_ms >= 3900,
        `duration_ms must be computed from started_epoch (got ${out.duration_ms})`,
      );
      assert.equal(out.slot_occupied, true, "occupied slot must report slot_occupied");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("the snapshot record is frozen — fire steps cannot smuggle a write through it", () => {
    const tmp = makeTempState();
    try {
      const r = runPython(`
import dataclasses, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("reap_u", os.environ["REAP_PATH"])
reap = importlib.util.module_from_spec(spec)
# Register BEFORE exec_module: reap.py uses PEP 563 future annotations,
# so @dataclass resolves cls.__module__ through sys.modules and an
# unregistered module makes the decorator blow up with a bare
# AttributeError on NoneType.
sys.modules["reap_u"] = reap
spec.loader.exec_module(reap)
state = {"limits": {}, "slots": {"dev_orch": {"task_id": "task-snap-2"}}}
snap = reap._snapshot_completion_slot(state, "dev_orch", "task-snap-2")
try:
    snap.anchor_ref = "mutated"
    print(json.dumps({"frozen": False}))
except dataclasses.FrozenInstanceError:
    print(json.dumps({"frozen": True}))
`, tmp);
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.frozen,
        true,
        "CompletionSnapshot must be a frozen dataclass — the boundary's immutability is interpreter-enforced",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("signal class (no slot): snapshot is None/None/0/False and branch recovery is never attempted", () => {
    const tmp = makeTempState();
    try {
      const r = runPython(`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("reap_u", os.environ["REAP_PATH"])
reap = importlib.util.module_from_spec(spec)
# Register BEFORE exec_module: reap.py uses PEP 563 future annotations,
# so @dataclass resolves cls.__module__ through sys.modules and an
# unregistered module makes the decorator blow up with a bare
# AttributeError on NoneType.
sys.modules["reap_u"] = reap
spec.loader.exec_module(reap)
state = {"limits": {}, "slots": {"dev_orch": None}}
snap = reap._snapshot_completion_slot(state, "sweep_orch", "task-snap-3")
print(json.dumps({
    "anchor_ref": snap.anchor_ref,
    "worktree_branch": snap.worktree_branch,
    "duration_ms": snap.duration_ms,
    "slot_occupied": snap.slot_occupied,
}))
`, tmp);
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.anchor_ref, null, "no slot + no deposit → anchor None");
      assert.equal(out.worktree_branch, null, "no slot → branch None");
      assert.equal(out.duration_ms, 0, "no slot → duration 0");
      assert.equal(out.slot_occupied, false, "no slot → slot_occupied False");
      const log = existsSync(tmp.log) ? readFileSync(tmp.log, "utf-8") : "";
      assert.match(log, /compute_duration_missing_start_stamp/);
      assert.ok(
        !log.includes("worktree_branch_recover_skipped"),
        "branch recovery must NOT run for a signal class (issue #3785 gate)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("run_completion reads the slot exactly once, via the snapshot builder, strictly before the release mutation", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: {
            task_id: "task-snap-4",
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 2,
            partial_tokens: 0,
          },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
        },
      });
      const r = runPython(`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("reap_u", os.environ["REAP_PATH"])
reap = importlib.util.module_from_spec(spec)
# Register BEFORE exec_module: reap.py uses PEP 563 future annotations,
# so @dataclass resolves cls.__module__ through sys.modules and an
# unregistered module makes the decorator blow up with a bare
# AttributeError on NoneType.
sys.modules["reap_u"] = reap
spec.loader.exec_module(reap)
state_path = os.environ["HYDRA_AUTOPILOT_STATE"]
calls = []
orig_snapshot = reap._snapshot_completion_slot
orig_release = reap._release_pipeline_slot
def spy_snapshot(s, cls, task_id):
    slot = (s.get("slots") or {}).get(cls)
    calls.append(["snapshot", json.dumps(slot, sort_keys=True)])
    return orig_snapshot(s, cls, task_id)
def spy_release(s, cls, total_tokens):
    slot = (s.get("slots") or {}).get(cls)
    calls.append(["release", json.dumps(slot, sort_keys=True)])
    return orig_release(s, cls, total_tokens)
reap._snapshot_completion_slot = spy_snapshot
reap._release_pipeline_slot = spy_release
rc = reap.run_completion("dev_orch", "task-snap-4", 5000, "hydra-dev")
order = [c[0] for c in calls]
first_slot = json.loads(calls[0][1]) if calls and calls[0][0] == "snapshot" else None
with open(state_path, encoding="utf-8") as fh:
    final = json.load(fh)
print("SNAP_RESULT:" + json.dumps({
    "rc": rc,
    "order": order,
    "snapshot_saw_occupied": first_slot is not None,
    "snapshot_saw_task_id": (first_slot or {}).get("task_id") == "task-snap-4",
    "final_slot": final["slots"]["dev_orch"],
    "final_cumulative": final["cumulative_tokens"],
    "final_reaped": final["reaped_task_ids"],
}))
`, tmp);
      assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
      // run_completion prints its own [autopilot] lines to stdout; the
      // probe prefixes its JSON with a marker so it survives that noise.
      const out = JSON.parse(r.stdout.split("SNAP_RESULT:").pop()!);
      assert.equal(out.rc, 0, "run_completion never hard-fails");
      assert.deepEqual(
        out.order,
        ["snapshot", "release"],
        "the slot must be read through the snapshot builder exactly once, then released",
      );
      assert.equal(out.snapshot_saw_occupied, true, "snapshot must see the slot still populated");
      assert.equal(out.snapshot_saw_task_id, true, "snapshot must see the real occupant");
      assert.equal(out.final_slot, null, "release must null the slot");
      assert.equal(out.final_cumulative, 5000, "token accounting unchanged by the restructure");
      assert.deepEqual(out.final_reaped, ["task-snap-4"], "dedup ledger unchanged");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLI: a stamped slot's anchor/branch/duration survive into the post-null fire steps", () => {
    const tmp = makeTempState();
    try {
      writeBaseState(tmp.state, {
        slots: {
          dev_orch: {
            task_id: "task-snap-5",
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 3,
            anchor: "issue-4304",
            branch: "worktree-agent-run9-t5-dev_orch",
            partial_tokens: 0,
          },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
        },
      });
      const r = runCompletionSnapshot(
        ["dev_orch", "task-snap-5", "7500", "hydra-dev"],
        tmp,
      );
      assert.equal(r.status, 0, `completion failed: ${r.stderr}`);
      const log = readFileSync(tmp.log, "utf-8");
      assert.match(
        log,
        /slot_complete class=dev_orch skill=hydra-dev task_id=task-snap-5 tokens=7500 cumulative=7500 duration_ms=[1-9]\d* task_title=issue-4304/,
        "slot_complete must carry a non-zero duration_ms and the slot-stamped anchor — values only available BEFORE the slot was nulled",
      );
      assert.match(
        log,
        /cycle_record_fired cycleId=worktree-agent-run9-t5-dev_orch task_id=task-snap-5/,
        "cycle-record must key on the slot-stamped branch (the #3391/#3785 capture, post-restructure)",
      );
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.slots.dev_orch, null, "slot released");
      assert.equal(s.cumulative_tokens, 7500, "tokens accounted");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #2954 — bounded run-end POST retry (`__reap_post_run_end` via the
// `--reap-post-run-end` dry-run flag).
//
// Motivating incident (run 3e2ac66d, 2026-07-06): a run that merged PRs
// triggered the deploy, the deploy restarted hydra-orchestrator.service
// (~10s window), and reap's single run-end POST fired inside that window and
// failed — so the dead-pid sweeper backstop stamped the clean handoff exit
// as status=killed / term_reason=crash. The fix is a bounded client-side
// retry loop shared between the live --reap path and this dry-run flag, so
// these cases pin exactly the production assembly:
//   1. 500-then-200 — curl -sf treats 5xx as failure, so this pins
//      retry-on-HTTP-error; success line names the winning attempt.
//   2. connection-refused exhaustion — pins retry-on-connect-refused, the
//      EXACT pre-existing "sweeper will backstop" line (the sweeper backstop
//      contract is unchanged), and exit 0 (reap NEVER aborts the unit stop).
//   3. first-attempt success — exactly one POST, no retry lines, and the
//      success line stays byte-compatible with the pre-#2954 format.
//
// All cases run with HYDRA_AUTOPILOT_REAP_POST_BACKOFFS='0 0 0' (4 attempts,
// zero sleeps) so the suite stays fast. Top-level describe with per-test
// server lifecycle — no shared state with the sibling suites above.
// ---------------------------------------------------------------------------
describe("scripts/autopilot/bootstrap.sh --reap-post-run-end — bounded run-end POST retry (issue #2954)", () => {
  // Async spawn (NOT spawnSync): the dry-run curls the in-process test HTTP
  // server, and spawnSync would block the event loop — the server could never
  // answer and every attempt would burn its full --max-time (a 20s hang that
  // looks like a retry bug but is a test-harness deadlock).
  function runPostRunEnd(
    apiBase: string,
    payload: string,
    backoffs = "0 0 0",
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(BOOTSTRAP, ["--reap-post-run-end", payload], {
        env: {
          ...process.env,
          HYDRA_API_BASE: apiBase,
          HYDRA_AUTOPILOT_REAP_POST_BACKOFFS: backoffs,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf-8").on("data", (d: string) => (stderr += d));
      child.on("error", rejectRun);
      child.on("close", (code) => resolveRun({ status: code ?? -1, stdout, stderr }));
    });
  }

  function listen(server: Server): Promise<number> {
    return new Promise((resolvePort) => {
      server.listen(0, "127.0.0.1", () => {
        resolvePort((server.address() as AddressInfo).port);
      });
    });
  }

  function close(server: Server): Promise<void> {
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  test("500-then-200: retries past transient HTTP errors and reports the winning attempt", async () => {
    let posts = 0;
    const server = createServer((req, res) => {
      posts += 1;
      const failThisOne = posts <= 2;
      req.resume();
      req.on("end", () => {
        res.statusCode = failThisOne ? 500 : 200;
        res.setHeader("content-type", "application/json");
        res.end(failThisOne ? '{"error":"restarting"}' : '{"ok":true}');
      });
    });
    const port = await listen(server);
    try {
      const r = await runPostRunEnd(
        `http://127.0.0.1:${port}`,
        '{"run_id":"r-2954-500","cause":"handoff","ended_epoch":0,"exit_code":0}',
      );
      assert.equal(r.status, 0, `dry-run exited non-zero: ${r.stderr}`);
      assert.equal(posts, 3, "server must see exactly 3 POSTs (two 500s, then the 200)");
      assert.match(
        r.stdout,
        /reap: recorded run-end run_id=r-2954-500 cause=handoff exit_code=0 \(idempotent\) attempt=3\/4/,
        "success line must name the winning attempt when it was not the first",
      );
      assert.match(r.stdout, /run-end POST attempt 1\/4 failed/, "attempt 1 failure must be logged");
      assert.match(r.stdout, /run-end POST attempt 2\/4 failed/, "attempt 2 failure must be logged");
      assert.ok(
        !r.stdout.includes("sweeper will backstop"),
        "a run that eventually succeeded must NOT emit the exhaustion line",
      );
    } finally {
      await close(server);
    }
  });

  test("connection-refused exhaustion: exits 0 and keeps the exact 'sweeper will backstop' line", async () => {
    // Grab a just-freed ephemeral port so the connection is refused instantly
    // (the deploy-restart window's closed-port shape — no listener at all).
    const probe = createServer(() => {});
    const port = await listen(probe);
    await close(probe);

    const r = await runPostRunEnd(
      `http://127.0.0.1:${port}`,
      '{"run_id":"r-2954-refused","cause":"handoff","ended_epoch":0,"exit_code":0}',
    );
    assert.equal(r.status, 0, `reap must NEVER abort the unit stop, got: ${r.stderr}`);
    assert.ok(
      r.stdout.includes(
        "[autopilot] reap: run-end POST failed (orchestrator down?) run_id=r-2954-refused cause=handoff — sweeper will backstop",
      ),
      `exhaustion must emit the EXACT pre-existing backstop line, got: ${r.stdout}`,
    );
    // Attempt count equals the configured schedule: 3 backoffs → 4 attempts,
    // i.e. 3 logged retry-failures before the exhaustion line.
    for (const n of [1, 2, 3]) {
      assert.match(
        r.stdout,
        new RegExp(`run-end POST attempt ${n}/4 failed — retrying in 0s`),
        `attempt ${n}/4 retry line must be logged`,
      );
    }
    assert.ok(
      !r.stdout.includes("attempt 4/4 failed"),
      "the final attempt exhausts (backstop line), it does not log another retry",
    );
  });

  test("first-attempt success: exactly one POST and the pre-#2954 success line unchanged", async () => {
    let posts = 0;
    const server = createServer((req, res) => {
      posts += 1;
      req.resume();
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true,"deduped":false}');
      });
    });
    const port = await listen(server);
    try {
      const r = await runPostRunEnd(
        `http://127.0.0.1:${port}`,
        '{"run_id":"r-2954-first","cause":"interrupted","ended_epoch":0,"exit_code":0}',
      );
      assert.equal(r.status, 0, `dry-run exited non-zero: ${r.stderr}`);
      assert.equal(posts, 1, "first-attempt success must POST exactly once");
      assert.match(
        r.stdout,
        /reap: recorded run-end run_id=r-2954-first cause=interrupted exit_code=0 \(idempotent\)\s*$/m,
        "first-attempt success line must stay byte-compatible (no attempt= suffix)",
      );
      assert.ok(!r.stdout.includes("attempt="), "no attempt suffix on a first-try success");
      assert.ok(!r.stdout.includes("retrying"), "no retry lines on a first-try success");
    } finally {
      await close(server);
    }
  });

  test("refuses to run without HYDRA_API_BASE (can never POST a fake run-end to the live API)", () => {
    const env = { ...process.env, HYDRA_AUTOPILOT_REAP_POST_BACKOFFS: "0 0 0" };
    delete (env as Record<string, string | undefined>).HYDRA_API_BASE;
    const r = spawnSync(BOOTSTRAP, ["--reap-post-run-end", "{}"], {
      env,
      encoding: "utf-8",
    });
    assert.notEqual(r.status, 0, "missing HYDRA_API_BASE must fail loud, not default to localhost:4000");
    assert.match(r.stderr ?? "", /requires HYDRA_API_BASE/);
  });
});
