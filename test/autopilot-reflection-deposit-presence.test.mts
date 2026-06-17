/**
 * Regression test for issue #2020 — the reflection-deposit PRESENCE diagnostic.
 *
 * The deposit plumbing (#1119 → #1820 → #1912 → #1945) is correct: on a
 * non-merged failure reap fires a per-anchor reflection, and `reap.py completion`
 * forwards any planning-time deposit string to the cycle-record write. But the
 * read side collapsed two very different empty-string outcomes into the same
 * silent 'none':
 *   - HONEST none  — the dispatch served no reflections, so it correctly wrote
 *                    no deposit (deposit-absent), OR wrote an empty deposit
 *                    (deposit-empty).
 *   - FALSE none   — a deposit existed but could not be read (read-error), the
 *                    #1945-shaped hazard.
 *
 * #2020 adds a `refl_presence=<token>` field to the `slot_complete` reap-log
 * line so an operator can distinguish the two WITHOUT manually scanning the fs /
 * Redis. The forwarded `reflectionSources` string (and therefore the
 * cycle-record POST body) is unchanged — this is observability only.
 *
 * These tests drive the real `reap.py completion` CLI against a DEAD orchestrator
 * (so the cycle-record/reflection POSTs fail fast and are swallowed) with a
 * controlled `HYDRA_AUTOPILOT_REFL_DIR`, and assert the presence token on the
 * `slot_complete` log line for each deposit state.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the cycle-record / reflection POSTs fail fast and are swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

interface Paths {
  dir: string;
  state: string;
  log: string;
  reflDir: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-presence-"));
  return {
    dir,
    state: join(dir, "state.json"),
    log: join(dir, "nightly.log"),
    reflDir: dir, // deposit files land at <dir>/hydra-refl-sources-<task_id>
  };
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
      HYDRA_AUTOPILOT_REFL_DIR: paths.reflDir,
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

function cleanState(paths: Paths, taskId: string): void {
  writeState(paths.state, {
    slots: {
      dev_orch: {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
        anchor: "issue-2020",
      },
    },
    failure_log: [],
  });
}

describe("reap.py completion → reflection-deposit presence diagnostic (issue #2020)", () => {
  test("no deposit file → refl_presence=deposit-absent (the honest-none common case)", () => {
    const tmp = makeTmp();
    try {
      cleanState(tmp, "tAbsent");
      const r = runCompletion(["dev_orch", "tAbsent", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /slot_complete .*task_id=tAbsent .*refl_presence=deposit-absent/,
        "a missing deposit file must log refl_presence=deposit-absent",
      );
      // The forwarded sources string stays empty — cycle-record body unchanged.
      assert.match(log, /refl_sources= /, "no deposit → empty refl_sources (truthful none)");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("empty deposit file → refl_presence=deposit-empty (still honest none)", () => {
    const tmp = makeTmp();
    try {
      cleanState(tmp, "tEmpty");
      writeFileSync(join(tmp.reflDir, "hydra-refl-sources-tEmpty"), "   \n");
      const r = runCompletion(["dev_orch", "tEmpty", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /slot_complete .*task_id=tEmpty .*refl_presence=deposit-empty/,
        "a present-but-empty deposit file must log refl_presence=deposit-empty",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("non-empty deposit file → refl_presence=deposit-present and forwards the bucket string", () => {
    const tmp = makeTmp();
    try {
      cleanState(tmp, "tPresent");
      writeFileSync(
        join(tmp.reflDir, "hydra-refl-sources-tPresent"),
        "per-anchor,by-file",
      );
      const r = runCompletion(["dev_orch", "tPresent", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /slot_complete .*task_id=tPresent .*refl_presence=deposit-present/,
        "a non-empty deposit file must log refl_presence=deposit-present",
      );
      assert.match(
        log,
        /refl_sources=per-anchor,by-file/,
        "the served bucket string is forwarded unchanged",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
