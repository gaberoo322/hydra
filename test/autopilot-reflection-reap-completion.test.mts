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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
      // Issue #2635: dispatch.sh's `hydra` CLI / curl fallback read HYDRA_BASE_URL
      // / HYDRA_API, not HYDRA_API_BASE — pin them to the dead port too so the
      // cycle-record POST can never leak to the live orchestrator on :4000.
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

describe("reap.py completion → deposit healthcheck (issue #2450, regated by #3734)", () => {
  /**
   * #2450 originally warned on deposit-ABSENT. #3734 established that's
   * backwards: `do_reflect()` only ever writes hydra-refl-sources-<task_id> when
   * it has something non-empty to report, so on the (large) majority of
   * anchors — where the reflection store served nothing — the file is never
   * created at all. Warning on ABSENT therefore fired on almost every
   * code-writing reap regardless of deposit health: zero signal value.
   *
   * The regated invariant: deposit-absent is the HONEST common baseline and
   * must NOT warn. Only presence states that mean the recipe ran but produced
   * something other than a clean "nothing to report" — deposit-empty,
   * read-error, no-task-id — are suspicious enough to warn on.
   */

  /**
   * Helper that runs reap.py completion with an explicit HYDRA_AUTOPILOT_REFL_DIR
   * so deposit-file presence is fully controlled by the test.
   */
  function runCompletionWithReflDir(
    args: string[],
    paths: Paths,
    reflDir: string,
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync("python3", [REAP, "completion", ...args], {
      env: {
        ...process.env,
        HYDRA_API_BASE: DEAD_API_BASE,
        // Issue #2635: dispatch.sh's `hydra` CLI / curl fallback read
        // HYDRA_BASE_URL / HYDRA_API, not HYDRA_API_BASE — pin them to the dead
        // port too so the cycle-record POST can never leak to :4000.
        HYDRA_BASE_URL: DEAD_API_BASE,
        HYDRA_AUTOPILOT_STATE: paths.state,
        HYDRA_AUTOPILOT_LOG: paths.log,
        HYDRA_AUTOPILOT_REFL_DIR: reflDir,
        HYDRA_REAP_WORKTREE_GC: "0",
      },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("a code-writing skill completion with no deposit file does NOT emit a WARN (deposit-absent is the honest baseline)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tABS",
            anchor: "issue-2450",
          },
        },
        failure_log: [],
      });

      // tmp.dir has no hydra-refl-sources-tABS file → deposit-absent.
      const r = runCompletionWithReflDir(
        ["dev_orch", "tABS", "1000", "hydra-dev"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.doesNotMatch(
        r.stderr,
        /WARN refl_deposit_broken/,
        "deposit-absent is the honest common case (do_reflect never writes when it has nothing to report) — must NOT warn",
      );
      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /WARN refl_deposit_broken/,
        "deposit-absent must not warn in the run log either",
      );
      assert.match(
        log,
        /refl_presence=deposit-absent/,
        "the slot_complete line still truthfully reports deposit-absent",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("hydra-target-build with no deposit also does NOT emit a WARN (it is in REFLECTION_DEPOSIT_SKILLS but absent is honest)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tTGT",
            anchor: "issue-2450",
          },
        },
        failure_log: [],
      });

      const r = runCompletionWithReflDir(
        ["dev_target", "tTGT", "1000", "hydra-target-build"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.doesNotMatch(
        r.stderr,
        /WARN refl_deposit_broken/,
        "hydra-target-build with deposit-absent must not warn",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a non-code-writing skill (hydra-qa) with no deposit does NOT emit a WARN", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          qa_orch: {
            skill: "hydra-qa",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tQA",
            anchor: "issue-2450",
          },
        },
        failure_log: [],
      });

      const r = runCompletionWithReflDir(
        ["qa_orch", "tQA", "1000", "hydra-qa"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.doesNotMatch(
        r.stderr,
        /WARN refl_deposit_broken/,
        "non-code-writing skills must not emit the deposit-broken WARN",
      );
      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /WARN refl_deposit_broken/,
        "non-code-writing skills must not emit the deposit-broken WARN in run log",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a code-writing skill WITH a deposit file does NOT emit a WARN", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tDEP",
            anchor: "issue-2450",
          },
        },
        failure_log: [],
      });

      // Write a deposit file so reap sees deposit-present, not deposit-absent.
      writeFileSync(join(tmp.dir, "hydra-refl-sources-tDEP"), "per-anchor");

      const r = runCompletionWithReflDir(
        ["dev_orch", "tDEP", "1000", "hydra-dev"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.doesNotMatch(
        r.stderr,
        /WARN refl_deposit_broken/,
        "a present deposit must not trigger the deposit-broken WARN",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("hydra-grill with no deposit does NOT emit a WARN (grill is not in REFLECTION_DEPOSIT_SKILLS)", () => {
    // hydra-grill is in CYCLE_RECORD_SKILLS but writes a design-concept artifact,
    // not a reflection-source deposit. A deposit-absent on grill is expected and
    // must NOT produce a false-positive WARN.
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          design_concept_orch: {
            skill: "hydra-grill",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tGRL",
            anchor: "issue-2450",
          },
        },
        failure_log: [],
      });

      const r = runCompletionWithReflDir(
        ["design_concept_orch", "tGRL", "1000", "hydra-grill"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.doesNotMatch(
        r.stderr,
        /WARN refl_deposit_broken/,
        "hydra-grill must not emit the deposit-broken WARN (it never writes a reflection-source deposit)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a code-writing skill with a BLANK deposit file (deposit-empty) emits the deposit-broken WARN", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tEMP",
            anchor: "issue-3734",
          },
        },
        failure_log: [],
      });

      // do_reflect() never intentionally writes an empty file — a blank file
      // means the write was truncated/corrupt, which IS suspicious.
      writeFileSync(join(tmp.dir, "hydra-refl-sources-tEMP"), "");

      const r = runCompletionWithReflDir(
        ["dev_orch", "tEMP", "1000", "hydra-dev"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.match(
        r.stderr,
        /WARN refl_deposit_broken skill=hydra-dev task_id=tEMP.*presence=deposit-empty/,
        "a blank (but present) deposit file must warn — it can never be an intentional write",
      );
      const log = runLog(tmp);
      assert.match(
        log,
        /WARN refl_deposit_broken skill=hydra-dev task_id=tEMP.*presence=deposit-empty/,
        "the deposit-empty WARN must also land in the run log",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a code-writing skill whose deposit path cannot be read (read-error) emits the deposit-broken WARN", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tERR",
            anchor: "issue-3734",
          },
        },
        failure_log: [],
      });

      // A directory at the expected deposit path is not a file: reap's
      // `path.read_text()` raises OSError (IsADirectoryError), yielding
      // read-error rather than a clean read.
      mkdirSync(join(tmp.dir, "hydra-refl-sources-tERR"));

      const r = runCompletionWithReflDir(
        ["dev_orch", "tERR", "1000", "hydra-dev"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.match(
        r.stderr,
        /WARN refl_deposit_broken skill=hydra-dev task_id=tERR.*presence=read-error/,
        "an unreadable deposit path must warn as read-error",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
