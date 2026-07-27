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
const REAP_DIR = join(REPO_ROOT, "scripts", "autopilot");

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

function runCompletionWithReflDir(
  args: string[],
  paths: Paths,
  reflDir: string,
): { status: number; stdout: string; stderr: string } {
  // Like `runCompletion` but with an explicit HYDRA_AUTOPILOT_REFL_DIR so
  // deposit-file presence is fully controlled by the test. Hoisted to top level
  // (issue #3734) so the WARN-gating and key-form-tolerance describes share it.
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
      HYDRA_AUTOPILOT_REFL_DIR: reflDir,
      HYDRA_REAP_WORKTREE_GC: "0",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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

describe("reap.py completion → refl-deposit WARN gating (issues #2450, #3734)", () => {
  /**
   * The deposit-health WARN gating (issue #2450 framed it, issue #3734 reworked it).
   * #2450 WARNed whenever a code-writing skill completed with NO deposit file
   * (deposit-absent). #3734 retires that: deposit-absent is the HONEST 'none' (the
   * producer ran `do_reflect` but the reflection store had nothing to serve, so it
   * correctly wrote nothing), so warning on it cried wolf and trained readers to
   * ignore the cue. The WARN now fires ONLY for the anomalous presence states
   * (deposit-empty / read-error / no-task-id — see the sibling describe below),
   * each with its own cue; the honest deposit-absent and non-code-writing cases
   * stay silent while `refl_presence` still records the state as a structured field.
   */

  test("a code-writing skill completion with no deposit file does NOT emit a WARN (issue #3734: honest decline)", () => {
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

      // tmp.dir has no hydra-refl-sources-tABS file → deposit-absent. This is the
      // HONEST 'none' (the producer ran but the reflection store had nothing to
      // serve, so it correctly wrote nothing), NOT a plumbing defect. Issue #3734
      // retires the false-alarm WARN here so the cue stays credible for real
      // anomalies; refl_presence=deposit-absent is still logged (asserted below).
      const r = runCompletionWithReflDir(
        ["dev_orch", "tABS", "1000", "hydra-dev"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.doesNotMatch(
        r.stderr,
        /WARN refl_deposit/,
        "honest deposit-absent on a code-writing skill must NOT emit a WARN",
      );
      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /WARN refl_deposit/,
        "honest deposit-absent must NOT WARN in the run log either",
      );
      // The structured presence field is still stamped so the state is observable
      // without a loud cue.
      assert.match(
        log,
        /refl_presence=deposit-absent/,
        "deposit-absent is still logged as a structured field",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("hydra-target-build with no deposit does NOT emit a WARN (issue #3734: honest decline)", () => {
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
        /WARN refl_deposit/,
        "hydra-target-build honest deposit-absent must NOT emit WARN",
      );
      const log = runLog(tmp);
      assert.match(log, /refl_presence=deposit-absent/, "deposit-absent is still logged");
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
        /WARN refl_deposit/,
        "non-code-writing skills must not emit deposit-absent WARN",
      );
      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /WARN refl_deposit/,
        "non-code-writing skills must not emit deposit-absent WARN in run log",
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
        /WARN refl_deposit/,
        "a present deposit must not trigger the absent WARN",
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
        /WARN refl_deposit/,
        "hydra-grill must not emit deposit-absent WARN (it never writes a reflection-source deposit)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("reap.py completion → refl-deposit anomaly WARN fires (issue #3734)", () => {
  /**
   * The WARN now fires ONLY for the anomalous presence states, each carrying its
   * own cue (REFL_DEPOSIT_WARN_CUES). The honest deposit-absent (sibling describe
   * above) is silent. These cases pin each anomaly → its distinct cue so a
   * regression that collapses them back to the old false-alarm
   * `refl-deposit-absent-on-code-write` is caught. All fire only for a code-
   * writing skill (hydra-dev).
   */
  function slotState(taskId: string, skill: string): Record<string, unknown> {
    return {
      slots: {
        dev_orch: {
          skill,
          started_epoch: Math.floor(Date.now() / 1000),
          task_id: taskId,
        },
      },
      failure_log: [],
    };
  }

  test("a deposit FILE that exists but is empty (deposit-empty) fires WARN with its own cue", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, slotState("tEMPTY", "hydra-dev"));
      // An empty refl-sources FILE: the writer (do_reflect) never produces one
      // (it skips writing entirely when nothing was served), so this is anomalous.
      writeFileSync(join(tmp.dir, "hydra-refl-sources-tEMPTY"), "   \n  ");

      const r = runCompletionWithReflDir(["dev_orch", "tEMPTY", "1000", "hydra-dev"], tmp, tmp.dir);
      assert.equal(r.status, 0, `reap must exit 0; stderr=${r.stderr}`);

      assert.match(r.stderr, /refl_deposit_anomaly/, "deposit-empty must emit the anomaly WARN");
      assert.match(r.stderr, /presence=deposit-empty/, "the WARN names the deposit-empty state");
      assert.match(r.stderr, /cue: refl-deposit-empty-on-code-write/, "deposit-empty carries its own cue");
      assert.match(runLog(tmp), /refl_presence=deposit-empty/, "presence field is logged distinctly");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a deposit FILE that exists but cannot be read (read-error) fires WARN with its own cue", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, slotState("tERR", "hydra-dev"));
      // A DIRECTORY at the deposit path: path.exists() is true so the resolver
      // returns it, but read_text() raises IsADirectoryError (an OSError) → the
      // reader classifies it read-error. Simulates an unreadable deposit file.
      mkdirSync(join(tmp.dir, "hydra-refl-sources-tERR"));

      const r = runCompletionWithReflDir(["dev_orch", "tERR", "1000", "hydra-dev"], tmp, tmp.dir);
      assert.equal(r.status, 0, `reap must exit 0; stderr=${r.stderr}`);

      assert.match(r.stderr, /refl_deposit_anomaly/, "read-error must emit the anomaly WARN");
      assert.match(r.stderr, /presence=read-error/, "the WARN names the read-error state");
      assert.match(r.stderr, /cue: refl-deposit-unreadable-on-code-write/, "read-error carries its own cue");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("no task_id to key the lookup on (no-task-id) fires WARN with its own cue", () => {
    const tmp = makeTmp();
    try {
      // An empty task_id → _read_reflection_sources short-circuits to no-task-id
      // before even touching the filesystem. A code-writing completion with no
      // task_id is a plumbing defect worth surfacing.
      writeState(tmp.state, slotState("", "hydra-dev"));

      const r = runCompletionWithReflDir(["dev_orch", "", "1000", "hydra-dev"], tmp, tmp.dir);
      assert.equal(r.status, 0, `reap must exit 0; stderr=${r.stderr}`);

      assert.match(r.stderr, /refl_deposit_anomaly/, "no-task-id must emit the anomaly WARN");
      assert.match(r.stderr, /presence=no-task-id/, "the WARN names the no-task-id state");
      assert.match(r.stderr, /cue: refl-deposit-no-task-id-on-code-write/, "no-task-id carries its own cue");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("reap.py deposit key-form tolerance (issue #3734)", () => {
  /**
   * The deposit writer (reflection-deposit.sh::derive_task_id) strips a leading
   * `agent-` and keys on the bare hash; the reap path receives the harness
   * `.task.id` as `agent-<HASH>`. Before #3734 the two forms never joined, so a
   * deposit written under the bare hash was unreadable and `testsAfter` recorded
   * null every cycle. The tolerant resolver (`_resolve_deposit_path`, shared by
   * ALL four deposit readers) fixes it at the read boundary. These cases pin
   * BOTH directions (bare↔agent-prefixed) and the exact-form-first precedence, so
   * the read key cannot drift from the write key — the derivation #3675 asks to
   * pin. The first three drive the readers directly (the reap READ path itself);
   * the fourth drives the full run_completion path end-to-end.
   */

  // Drive the four readers directly via a python import (HYDRA_AUTOPILOT_REFL_DIR
  // points the module at the test's deposit dir). Returns each reader's output
  // for `taskId`. This exercises reap's real reader functions, not a mock.
  function readDeposits(taskId: string, reflDir: string): Record<string, unknown> {
    const script = [
      "import sys, json",
      "sys.path.insert(0, sys.argv[1])",
      "import reap",
      "tid = sys.argv[2]",
      "srcs, pres = reap._read_reflection_sources(tid)",
      "anchor = reap._read_anchor_deposit(tid)",
      "ground = reap._read_grounding_tests(tid)",
      "esc = reap._read_escalation_deposit(tid)",
      "print(json.dumps({",
      '  "sources": srcs, "presence": pres,',
      '  "anchor": anchor, "grounding": ground, "escalation": esc,',
      "}))",
    ].join("\n");
    const r = spawnSync("python3", ["-c", script, REAP_DIR, taskId], {
      env: { ...process.env, HYDRA_AUTOPILOT_REFL_DIR: reflDir },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `python import failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  const GROUND_JSON = JSON.stringify({ testsAfter: 42, testsPassingAfter: 40 });
  const ESC_JSON = JSON.stringify({ escalationAttempt: 2, escalatedModel: "sonnet" });

  test("a BARE-keyed deposit is read back through an agent-prefixed task_id (all four readers)", () => {
    const tmp = makeTmp();
    try {
      // The reflect/grounding writer strips `agent-` and keys on the bare hash.
      writeFileSync(join(tmp.dir, "hydra-refl-sources-feedface"), "per-anchor,by-file");
      writeFileSync(join(tmp.dir, "hydra-refl-anchor-feedface"), "issue-3734");
      writeFileSync(join(tmp.dir, "hydra-grounding-tests-feedface"), GROUND_JSON);
      writeFileSync(join(tmp.dir, "hydra-escalation-feedface"), ESC_JSON);

      const out = readDeposits("agent-feedface", tmp.dir);
      assert.equal(out.sources, "per-anchor,by-file");
      assert.equal(out.presence, "deposit-present");
      assert.equal(out.anchor, "issue-3734");
      assert.deepEqual(out.grounding, { testsAfter: 42, testsPassingAfter: 40 });
      assert.equal(out.escalation, ESC_JSON);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an AGENT-prefixed-keyed deposit is read back through a bare task_id (vice versa)", () => {
    const tmp = makeTmp();
    try {
      // The escalation writer passes the harness task_id verbatim (agent-prefixed);
      // if the reader ever receives the bare form, it must still resolve.
      writeFileSync(join(tmp.dir, "hydra-refl-sources-agent-feedface"), "per-anchor");
      writeFileSync(join(tmp.dir, "hydra-refl-anchor-agent-feedface"), "issue-3734");
      writeFileSync(join(tmp.dir, "hydra-grounding-tests-agent-feedface"), GROUND_JSON);
      writeFileSync(join(tmp.dir, "hydra-escalation-agent-feedface"), ESC_JSON);

      const out = readDeposits("feedface", tmp.dir);
      assert.equal(out.sources, "per-anchor");
      assert.equal(out.presence, "deposit-present");
      assert.equal(out.anchor, "issue-3734");
      assert.deepEqual(out.grounding, { testsAfter: 42, testsPassingAfter: 40 });
      assert.equal(out.escalation, ESC_JSON);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("the exact key form is preferred when both forms exist on disk (precedence)", () => {
    const tmp = makeTmp();
    try {
      writeFileSync(join(tmp.dir, "hydra-refl-sources-feedface"), "bare-wins-when-queried-bare");
      writeFileSync(join(tmp.dir, "hydra-refl-sources-agent-feedface"), "agent-wins-when-queried-agent");

      assert.equal(
        readDeposits("feedface", tmp.dir).sources,
        "bare-wins-when-queried-bare",
        "a bare query must read the bare-keyed file, not fall through to the agent- one",
      );
      assert.equal(
        readDeposits("agent-feedface", tmp.dir).sources,
        "agent-wins-when-queried-agent",
        "an agent- query must read the agent-keyed file first",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("end-to-end: a bare-keyed deposit resolves through run_completion (agent-prefixed task_id)", () => {
    const tmp = makeTmp();
    try {
      // No `anchor` on the slot → anchor_ref falls back to the deposit, proving
      // the anchor reader resolves across the key mismatch on the live reap path.
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "agent-feedface",
          },
        },
        failure_log: [],
      });
      writeFileSync(join(tmp.dir, "hydra-refl-sources-feedface"), "per-anchor");
      writeFileSync(join(tmp.dir, "hydra-refl-anchor-feedface"), "issue-3734");

      const r = runCompletionWithReflDir(
        ["dev_orch", "agent-feedface", "1000", "hydra-dev"],
        tmp,
        tmp.dir,
      );
      assert.equal(r.status, 0, `reap must exit 0; stderr=${r.stderr}`);
      const log = runLog(tmp);
      // refl-sources resolved across the key mismatch → present in the cycle line.
      assert.match(log, /refl_sources=per-anchor refl_presence=deposit-present/);
      // anchor resolved across the key mismatch → surfaced as task_title.
      assert.match(log, /task_title=issue-3734/);
      // deposit-present is not an anomaly → no WARN.
      assert.doesNotMatch(r.stderr, /WARN refl_deposit/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
