/**
 * Regression test for issue #2112 — the reflection producer was a permanent
 * no-op because reap recovered the cycle anchor ONLY from `slot["anchor"]`,
 * a field the dispatch harness never stamps.
 *
 * Root cause: the live `state.slots[<cls>]` written at dispatch time carries
 * only `task_id`/`skill`/`started_epoch`/`branch` — never `anchor` — and for
 * `dev_orch` the dispatch action passes no `prompt_args.anchor` at all (the
 * #458 contract). So `reap.run_completion` read `anchor_ref = slot.get("anchor")`
 * → always `None` → `_fire_reflection_for_completion` early-returned on its
 * `if not anchor_ref` guard → `recordAnchorReflection` was never called →
 * `GET /api/reflections?anchor=X` returned `count:0` and `reflectionMatchSource`
 * stayed `'none'` on 100% of cycles. The #1119 fix wired the producer chain but
 * left this final link severed.
 *
 * Fix: the code-writing dispatch deposits its anchor (e.g. "issue-2112") to a
 * task-scoped file `${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-anchor-<task_id>`
 * (mirroring the existing reflection-source deposit), and reap reads it via
 * `_read_anchor_deposit` as the authoritative anchor source — falling back to
 * `slot.get("anchor")`. This makes the reflection fire on a non-merged failure
 * even though the slot has no `anchor` field.
 *
 * Drives the real `reap.py completion` CLI against a DEAD orchestrator
 * (HYDRA_API_BASE → a closed port) so the POST fails fast and is swallowed; we
 * assert the swallow line (`reflection_record_skipped anchor=<ref>`) proves a
 * fire was ATTEMPTED keyed on the DEPOSITED anchor.
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
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-anchor-deposit-"));
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

function depositAnchor(dir: string, taskId: string, anchor: string): void {
  writeFileSync(join(dir, `hydra-refl-anchor-${taskId}`), anchor);
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
      // Deposit + read use the same dir as the reflection-source deposit.
      HYDRA_AUTOPILOT_REFL_DIR: paths.dir,
      HYDRA_REAP_WORKTREE_GC: "0",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

describe("reap.py completion → anchor recovered from deposit (issue #2112)", () => {
  test("a failed completion with NO slot anchor fires a reflection keyed on the DEPOSITED anchor", () => {
    const tmp = makeTmp();
    try {
      // The slot has no `anchor` field — exactly the live slot shape the
      // harness writes (task_id/skill/started_epoch/branch only).
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tDEP",
            branch: "worktree-agent-deadbeef-t1-dev_orch",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tDEP", note: "npm test failed" },
        ],
      });
      // The dispatch deposited its anchor at planning time.
      depositAnchor(tmp.dir, "tDEP", "issue-2112");

      const r = runCompletion(["dev_orch", "tDEP", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_record_skipped anchor=issue-2112/,
        "the reflection POST must be attempted keyed on the DEPOSITED anchor, not the (absent) slot anchor",
      );
      assert.match(log, /outcome=verification-failure/, "the cue is classified via self_heal taxonomy");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("the slot anchor still wins when present (deposit is a fallback)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tBOTH",
            anchor: "issue-slot",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tBOTH", note: "npm test failed" },
        ],
      });
      // A different value in the deposit — the slot anchor must take precedence.
      depositAnchor(tmp.dir, "tBOTH", "issue-deposit");

      const r = runCompletion(["dev_orch", "tBOTH", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(log, /reflection_record_skipped anchor=issue-slot/, "slot anchor wins over the deposit");
      assert.doesNotMatch(log, /anchor=issue-deposit/, "the deposit must not override a present slot anchor");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a failed completion with NO slot anchor AND no deposit makes NO reflection POST attempt", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tNONE",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tNONE", note: "no-diff" },
        ],
      });
      // No deposit written → still degrades to the prior no-op.

      const r = runCompletion(["dev_orch", "tNONE", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /reflection_record_skipped/,
        "no slot anchor and no deposit → no reflection POST attempt (truthful no-op)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an empty deposit file is treated as no anchor (no fire)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tEMPTY",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tEMPTY", note: "no-diff" },
        ],
      });
      depositAnchor(tmp.dir, "tEMPTY", "   "); // whitespace-only → treated as empty

      const r = runCompletion(["dev_orch", "tEMPTY", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /reflection_record_skipped/,
        "an empty/whitespace deposit must be treated as no anchor",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
