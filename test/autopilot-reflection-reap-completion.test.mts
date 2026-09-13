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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
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
      // Issue #3866: reap.py's dev_orch no-PR-stall check shells out to a REAL
      // `gh pr list`/`gh issue edit`/`gh issue comment` against
      // HYDRA_AUTOPILOT_REPO whenever a dev_orch completion carries an anchor
      // with no open PR — which this suite's fixtures do. Point it at a
      // nonexistent fixture repo with an invalid token (same pattern as
      // test/autopilot-reap-task-id-mismatch.test.mts) so it can never touch
      // the real gaberoo322/hydra repo.
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

  test("a soft-cap token runaway with UNKNOWN PR state fires a reflection even without a failure_log row (issue #4248 INV-2)", () => {
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
      // Issue #4248 INV-2: this suite's env (nonexistent repo + invalid
      // GH_TOKEN) makes the PR-existence check UNKNOWN — the suppression gate
      // must treat unknown as "no evidence" and fire exactly as before, AND
      // log the observability line saying the PR check could not complete.
      assert.match(
        log,
        /reflection_pr_check_unknown anchor=issue-1820/,
        "an unresolvable PR check must be logged as unknown, never treated as 'PR exists'",
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
        // Issue #3866: see the rationale comment on the sibling runCompletion
        // helper above — never let the dev_orch no-PR-stall check touch the
        // real gaberoo322/hydra repo from a test fixture.
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        GH_TOKEN: "invalid-test-token",
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

// ===========================================================================
// Issue #4248 — soft-cap FALSE-FAILURE reflection suppression.
// ===========================================================================
//
// A dev_orch dispatch that legitimately shipped (opened a PR referencing its
// anchor) but crossed the soft token cap used to get an anchor-keyed "this
// anchor FAILED, do NOT repeat" reflection persisted anyway (observed: run
// da9b4ba9, PR #4242, 432,562 tokens) — poisoning any future retry of the
// anchor. The fix gates the soft-cap-only branch of
// `_fire_reflection_for_completion` on POSITIVE PR evidence derived from the
// ONE shared open-PR payload hoisted above the fire:
//
//   - pr_exists True  → SUPPRESS (log `reflection_suppressed_pr_exists`);
//   - pr_exists False → fire exactly as before (genuine runaway);
//   - pr_exists None  → UNKNOWN → fire exactly as before (INV-2: only a
//                       positive finding suppresses) + log
//                       `reflection_pr_check_unknown` for observability;
//   - a decide.py failure_log row ALWAYS wins over PR evidence (INV-3);
//   - cost bookkeeping (burned_classes / cycle status) is untouched (INV-4).
//
// These cases drive the REAL `reap.py completion` CLI against a DEAD
// orchestrator with a STUB `gh` (HYDRA_AUTOPILOT_GH_CLI, the injection
// pattern of test/autopilot-dev-resume-stall.test.mts) — suppression is
// asserted as ABSENCE of `reflection_record_skipped` plus PRESENCE of
// `reflection_suppressed_pr_exists` in the run log. New top-level describe
// with its own tmp lifecycle (per the CLAUDE.md authoring rule).
describe("reap.py completion → soft-cap false-failure reflection suppression (issue #4248)", () => {
  interface StubPaths {
    dir: string;
    state: string;
    log: string;
    ghStub: string;
    ghCallsLog: string;
  }

  /**
   * Same stub-gh shape as test/autopilot-dev-resume-stall.test.mts: records
   * every invocation, answers `pr list` with $STUB_PR_LIST_JSON (exit
   * $STUB_PR_LIST_EXIT), `issue view` with $STUB_ISSUE_VIEW_JSON (default
   * OPEN), and exits 0 for everything else (issue edit/comment/create).
   */
  function makeStubTmp(): StubPaths {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-4248-"));
    const ghStub = join(dir, "gh-stub.sh");
    const ghCallsLog = join(dir, "gh-calls.log");
    writeFileSync(
      ghStub,
      `#!/usr/bin/env bash
set -u
echo "$*" >> "${ghCallsLog}"
case "\${1:-} \${2:-}" in
  "pr list")
    exit_code="\${STUB_PR_LIST_EXIT:-0}"
    if [ "\$exit_code" != "0" ]; then
      exit "\$exit_code"
    fi
    printf '%s' "\${STUB_PR_LIST_JSON:-[]}"
    exit 0
    ;;
  "issue view")
    exit_code="\${STUB_ISSUE_VIEW_EXIT:-0}"
    if [ "\$exit_code" != "0" ]; then
      exit "\$exit_code"
    fi
    out="\${STUB_ISSUE_VIEW_JSON:-}"
    if [ -z "\$out" ]; then
      out='{"state":"OPEN"}'
    fi
    printf '%s' "\$out"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    );
    chmodSync(ghStub, 0o755);
    return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log"), ghStub, ghCallsLog };
  }

  function runCompletionStubbed(
    args: string[],
    paths: StubPaths,
    ghEnv: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } {
    const r = spawnSync("python3", [REAP, "completion", ...args], {
      env: {
        ...process.env,
        HYDRA_API_BASE: DEAD_API_BASE,
        // Issue #2635: pin the alternate base-url env names to the dead port
        // too so no POST can leak to the live orchestrator on :4000.
        HYDRA_BASE_URL: DEAD_API_BASE,
        HYDRA_AUTOPILOT_STATE: paths.state,
        HYDRA_AUTOPILOT_LOG: paths.log,
        HYDRA_REAP_WORKTREE_GC: "0",
        // Never touch the real repo from a fixture — the stub answers `gh`,
        // and the repo name only appears in the recorded argv.
        HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
        HYDRA_AUTOPILOT_GH_CLI: paths.ghStub,
        GH_TOKEN: "invalid-test-token",
        ...ghEnv,
      },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function ghCalls(paths: StubPaths): string[] {
    return existsSync(paths.ghCallsLog)
      ? readFileSync(paths.ghCallsLog, "utf-8").trim().split("\n").filter(Boolean)
      : [];
  }

  /** Base state with an occupied dev_orch slot anchored on issue-4248. */
  function writeSoftCapState(
    path: string,
    slotCls: string,
    taskId: string,
    patch: Record<string, unknown> = {},
  ): void {
    writeState(path, {
      slots: {
        [slotCls]: {
          skill: slotCls === "dev_target" ? "hydra-target-build" : "hydra-dev",
          started_epoch: Math.floor(Date.now() / 1000),
          task_id: taskId,
          anchor: "issue-4248",
        },
      },
      failure_log: [],
      ...patch,
    });
  }

  test("soft-cap + open PR referencing the anchor → NO reflection fire, suppression logged, cost burn intact (issue #4248 INV-1/INV-4/INV-5)", () => {
    const tmp = makeStubTmp();
    try {
      writeSoftCapState(tmp.state, "dev_orch", "tSUP");

      // The PR's body references the anchor (a closing verb) — the exact
      // shape of the motivating incident (PR #4242 closing #4177).
      const prJson = JSON.stringify([
        { headRefName: "worktree-agent-da9b4ba9-t2-dev_orch", body: "fixes #4248\n\nCloses #4248" },
      ]);
      // 500k tokens >= subagent_max_tokens (400k) → soft-cap "failed", but a
      // PR referencing the anchor exists → the false-failure reflection is
      // suppressed.
      const r = runCompletionStubbed(["dev_orch", "tSUP", "500000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_suppressed_pr_exists anchor=issue-4248 task_id=tSUP/,
        "the suppression must be logged with the anchor and task_id (INV-1's machine-readable line)",
      );
      assert.doesNotMatch(
        log,
        /reflection_record_skipped/,
        "a soft-cap completion with a live PR must make NO reflection POST attempt — the false failure narrative is never persisted",
      );
      // INV-4: cost-throttle bookkeeping is byte-for-byte unchanged by the
      // suppression — the cycle still burns and the slot is still reaped.
      assert.match(
        log,
        /slot_complete .*task_id=tSUP.*status=failed/,
        "the slot_complete line still stamps status=failed (the #3839 cost throttle stands)",
      );
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        (s.burned_classes as string[]).includes("dev_orch"),
        "burned_classes still contains dev_orch — suppression changes only the reflection",
      );
      assert.equal(s.slots.dev_orch, null, "the slot is still released");

      // INV-5: ONE shared `gh pr list` fetch — the reflection gate, the stall
      // check and the promotion all read the same payload.
      const prListCalls = ghCalls(tmp).filter((c) => c.startsWith("pr list"));
      assert.equal(
        prListCalls.length,
        1,
        `exactly one shared gh pr list fetch must serve the reflection gate + stall + promotion: ${JSON.stringify(ghCalls(tmp))}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("soft-cap + clean empty PR list → fires as before, and the completed check is not 'unknown' (issue #4248)", () => {
    const tmp = makeStubTmp();
    try {
      writeSoftCapState(tmp.state, "dev_orch", "tNOPR");

      // The stub answers a clean empty list (gh succeeded, no open PRs) — a
      // GENUINE soft-cap runaway: the reflection must fire exactly as before.
      const r = runCompletionStubbed(["dev_orch", "tNOPR", "500000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}',
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_record_skipped anchor=issue-4248/,
        "a genuine soft-cap runaway with a completed no-PR check must still fire the reflection",
      );
      assert.doesNotMatch(
        log,
        /reflection_suppressed_pr_exists/,
        "no PR → no suppression",
      );
      assert.doesNotMatch(
        log,
        /reflection_pr_check_unknown/,
        "the check COMPLETED (False) — the unknown observability line must not appear",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("soft-cap + failure_log row + open PR → the recorded failure STILL fires (issue #4248 INV-3)", () => {
    const tmp = makeStubTmp();
    try {
      writeSoftCapState(tmp.state, "dev_orch", "tFPR", {
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tFPR", note: "npm test failed" },
        ],
      });

      // A decide.py-recorded failure row is a GENUINE failure signal — a PR
      // being open does not refute it (e.g. verification failed after push).
      const prJson = JSON.stringify([
        { headRefName: "worktree-agent-x-t2-dev_orch", body: "Closes #4248" },
      ]);
      const r = runCompletionStubbed(["dev_orch", "tFPR", "500000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_record_skipped anchor=issue-4248/,
        "the failure_log row wins over PR evidence — the reflection must still fire",
      );
      assert.doesNotMatch(
        log,
        /reflection_suppressed_pr_exists/,
        "the PR gate applies ONLY to the soft-cap-only branch (INV-3)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("soft-cap on a non-PR class → no gh call at all, fires as before with the unknown line (issue #4248 INV-2)", () => {
    const tmp = makeStubTmp();
    try {
      writeSoftCapState(tmp.state, "research_orch", "tRES");

      // research_orch never opens a PR — the gate has nothing to check
      // (pr_exists None), makes NO gh call, and fires exactly as today.
      const r = runCompletionStubbed(["research_orch", "tRES", "500000", "hydra-research"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /reflection_record_skipped anchor=issue-4248/,
        "a non-PR class soft-cap runaway must fire the reflection unchanged",
      );
      assert.match(
        log,
        /reflection_pr_check_unknown anchor=issue-4248/,
        "the absent evidence is logged as unknown for observability",
      );
      assert.equal(
        ghCalls(tmp).length,
        0,
        `a non-PR class must trigger ZERO gh subprocess calls: ${JSON.stringify(ghCalls(tmp))}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
