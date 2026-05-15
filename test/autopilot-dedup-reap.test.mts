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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const REAP = join(SCRIPTS, "reap.py");
const BOOTSTRAP = join(SCRIPTS, "bootstrap.sh");

function makeTempState(): { dir: string; state: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dedup-test-"));
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
    // bootstrap.sh writes to /tmp/hydra-autopilot-state.json directly,
    // mirroring the pattern in autopilot-scripts.test.mts. Copy out for
    // isolation and inspection.
    const tmp = makeTempState();
    try {
      const r = spawnSync(BOOTSTRAP, [], {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `bootstrap exited non-zero: ${r.stderr}`);
      assert.ok(existsSync("/tmp/hydra-autopilot-state.json"));
      const s = JSON.parse(readFileSync("/tmp/hydra-autopilot-state.json", "utf-8"));
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
