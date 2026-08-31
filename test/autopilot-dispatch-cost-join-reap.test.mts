/**
 * Regression test for issue #4126 (ADR-0032 epic #4123 slice gamma) — the
 * dispatch -> issue cost-join producer's best-effort posture.
 *
 * `_post_dispatch_cost_join` (scripts/autopilot/reap.py) is the producer for
 * `hydra:cost:dispatch-join:*` (src/redis/cost.ts's `DispatchCostJoinRecord`),
 * fired once per completed dispatch from `run_completion` alongside the
 * existing `_fire_token_record` per-cycle write. The design-concept artifact
 * for #4126 states the join write "is best-effort and MUST NOT block or fail
 * reap.py's completion path — any POST failure (network, non-2xx,
 * orchestrator down) is logged and swallowed, exactly like the existing
 * `_fire_token_record` contract."
 *
 * Mirrors `test/autopilot-token-record-reap-completion.test.mts`'s pattern
 * exactly (same fixture shape, same DEAD_API_BASE technique): drive the real
 * `reap.py completion` CLI against a closed port so the dispatch-cost POST
 * always fails fast, and assert (1) reap still exits 0, (2) the slot is still
 * reaped normally, and (3) the failure is logged via
 * `dispatch_cost_join_skipped` rather than raised — proving the swallow
 * behavior the MUST-NOT invariant requires, not just asserting text exists in
 * a file.
 *
 * Authored as its own file with a dedicated top-level `describe` (no shared
 * Redis fixture, no teardown to race against — CLAUDE.md authoring rule is
 * moot here since this suite touches no Redis at all, only reap.py's own
 * temp-dir state/log files).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the dispatch-cost POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-cost-join-"));
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
      // test/autopilot-token-record-reap-completion.test.mts) so it can never
      // touch the real gaberoo322/hydra repo.
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

describe("reap.py completion -> dispatch cost-join best-effort posture (issue #4126)", () => {
  test("a positive-token, anchored completion attempts the POST and swallows a dead-port failure without blocking reap", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tCostJoin",
            anchor: "issue-4126",
          },
        },
      });

      const r = runCompletion(["dev_orch", "tCostJoin", "8000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0 even though the dispatch-cost POST fails, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dispatch_cost_join_skipped issue=4126 class=dev_orch tokens=8000/,
        "the dead-port POST failure must be logged (caught, not raised)",
      );
      // The slot must still reap normally — the join write never blocks the
      // completion path.
      assert.match(log, /slot_complete .*task_id=tCostJoin/, "the slot is still reaped despite the dead-port join POST");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a zero-token completion makes NO dispatch-cost POST attempt (truthful null, not a fabricated zero-cost record)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tCostJoinZero",
            anchor: "issue-4126",
          },
        },
      });

      const r = runCompletion(["dev_orch", "tCostJoinZero", "0", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /dispatch_cost_join_skipped/,
        "a zero-token completion must NOT attempt a dispatch-cost POST",
      );
      assert.match(log, /slot_complete .*task_id=tCostJoinZero/, "the slot is still reaped on a zero-token cycle");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an unanchored signal-class completion still swallows the POST failure without blocking reap (unattributed residual)", () => {
    const tmp = makeTmp();
    try {
      // A research/discover-shaped completion has no pipeline slot and no
      // anchor — the join record posts with issue:null (unattributed
      // residual, issue #4126's third open question) rather than being
      // silently dropped.
      writeState(tmp.state, { slots: {} });

      const r = runCompletion(["research_orch", "tCostJoinSig", "3000", "hydra-research"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dispatch_cost_join_skipped issue=None class=research_orch tokens=3000/,
        "an unanchored completion still attempts the POST (issue=None) and swallows the dead-port failure",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
