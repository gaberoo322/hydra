/**
 * Regression test for the reap-side reflection-record best-effort fire
 * (issue #1119, Slice 1) — the python half of the WRITE-gap fix.
 *
 * `self_heal.append_failure` is the single chokepoint where a NON-MERGED
 * terminal outcome is decided WITH the anchor (`issue`) + classified pattern
 * (`outcome`) + cue (`reason`) all known. It fires
 * `reap._fire_reflection_record`, which POSTs to
 * `/api/autopilot/reflection-record`. That POST is STRICTLY best-effort: an
 * unreachable orchestrator, a non-2xx, or any error must be logged and
 * SWALLOWED — it must NEVER change the self-heal exit code or break the
 * failure-log append (the reap path is correctness; reflection writes are
 * learning).
 *
 * These tests pin that swallow behaviour by pointing HYDRA_API_BASE at a dead
 * port and asserting:
 *   - `self_heal.py append` for a learning-worthy pattern still exits 0,
 *     still writes the failure-log row, and logs a `reflection_record_skipped`
 *     line (the swallow happened, the append survived).
 *   - `worktree-isolation-broken` is skipped entirely (no fire attempt) —
 *     an infra abort is not a model-fixable failure narrative.
 *   - a failure record with no `issue` (no anchor to key on) makes no fire
 *     attempt.
 *
 * No live orchestrator is contacted — HYDRA_API_BASE points at 127.0.0.1:1
 * (a closed port) so the POST always fails fast.
 *
 * ---------------------------------------------------------------------------
 * Issue #2670 carve-out — failure-path WRITER regression guard.
 * ---------------------------------------------------------------------------
 * #2648 (reframe of #2336) proposed firing reflections on SUCCESSFUL cycles to
 * lift `reflectionMatchSource` off `"none"`; a design-concept grill confirmed
 * that premise is working-as-designed (reflections are failure-only by
 * definition), so #2648 was closed. What remained was a real residual gap: no
 * regression test pinned that the failure-path producer
 * `reap._fire_reflection_for_completion` still WRITES on a genuine failure /
 * soft-cap cycle and does NOT write on a merged first attempt. The second
 * top-level describe below adds that both-directions guard so a future edit to
 * the reap gate (line ~593: `if not soft_cap_hit and failure_entry is None:
 * return`) can never silently re-break the #1119 → #1820 → #2112 producer. It
 * drives the REAL `reap.py completion` CLI against the same dead orchestrator,
 * asserting the swallow line appears on a failure and is absent on a merged
 * success. (New top-level describe with its own tmp lifecycle — no shared-Redis
 * teardown, per the CLAUDE.md authoring rule.)
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

// Issue #2670: the honest-none discriminator the discover / health filing
// decision consults so it stops re-filing a merged-first-attempt `none` as an
// anomaly. Imported here (the same carve-out owns the failure-path writer guard
// below) to pin that a `served-but-bucketed-none` verdict is the ONLY one it
// treats as file-worthy.
const { isHonestNoneVerdict } = await import("../src/metrics/reflection-health.ts");

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SELF_HEAL = join(REPO_ROOT, "scripts", "autopilot", "self_heal.py");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the reflection POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

function runAppend(
  args: string[],
  paths: { failureLog: string; runLog: string },
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [SELF_HEAL, "append", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      HYDRA_AUTOPILOT_FAILURE_LOG: paths.failureLog,
      HYDRA_AUTOPILOT_LOG: paths.runLog,
    },
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function makeTmp(): { dir: string; failureLog: string; runLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reflection-fire-"));
  return {
    dir,
    failureLog: join(dir, "failures.jsonl"),
    runLog: join(dir, "nightly.log"),
  };
}

describe("self_heal.append_failure → reap._fire_reflection_record (issue #1119)", () => {
  test("a learning-worthy failure swallows the dead-orchestrator POST and still appends", () => {
    const tmp = makeTmp();
    try {
      const r = runAppend(
        ["no-diff", "dev_orch", "--issue=issue-1119", "--cue=made zero file changes"],
        tmp,
      );
      // The append (correctness) must succeed regardless of the dead POST.
      assert.equal(r.status, 0, `append must exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.ok(existsSync(tmp.failureLog), "failure-log row must be written");
      const row = JSON.parse(readFileSync(tmp.failureLog, "utf-8").trim().split("\n").pop()!);
      assert.equal(row.issue, "issue-1119");
      assert.equal(row.pattern, "no-diff");

      // The swallow line proves the POST was attempted AND failed gracefully.
      const runLog = existsSync(tmp.runLog) ? readFileSync(tmp.runLog, "utf-8") : "";
      assert.match(
        runLog,
        /reflection_record_skipped/,
        "a dead orchestrator must produce a reflection_record_skipped run-log line",
      );
      assert.match(runLog, /anchor=issue-1119/, "the swallow line names the anchor");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("worktree-isolation-broken is NOT recorded as a reflection (infra abort)", () => {
    const tmp = makeTmp();
    try {
      const r = runAppend(
        [
          "worktree-isolation-broken",
          "dev_orch",
          "--issue=issue-1119",
          "--cue=worktree isolation broken; cwd is main",
        ],
        tmp,
      );
      assert.equal(r.status, 0, `append must exit 0, got ${r.status}; stderr=${r.stderr}`);
      // No fire attempt → no skip line for this anchor.
      const runLog = existsSync(tmp.runLog) ? readFileSync(tmp.runLog, "utf-8") : "";
      assert.doesNotMatch(
        runLog,
        /reflection_record_skipped/,
        "an infra-abort pattern must not even attempt a reflection POST",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a failure with no anchor (issue) makes no reflection POST attempt", () => {
    const tmp = makeTmp();
    try {
      // No --issue= → record.issue is None → skip.
      const r = runAppend(["no-diff", "dev_orch", "--cue=zero changes"], tmp);
      assert.equal(r.status, 0, `append must exit 0, got ${r.status}; stderr=${r.stderr}`);
      const runLog = existsSync(tmp.runLog) ? readFileSync(tmp.runLog, "utf-8") : "";
      assert.doesNotMatch(
        runLog,
        /reflection_record_skipped/,
        "no anchor to key on → no POST attempt",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Issue #2670 — failure-path WRITER regression guard on
// `reap._fire_reflection_for_completion`.
// ===========================================================================
//
// Locks in the already-correct failure-only producer (#1119 → #1820 → #2112)
// against a future edit to the reap gate. Drives the REAL `reap.py completion`
// CLI (via a synthetic state file) against a DEAD orchestrator so the
// reflection POST always fails fast and must be swallowed — the swallow line
// `reflection_record_skipped anchor=<ref>` is the observable proof that a WRITE
// was attempted. We assert BOTH directions the acceptance criteria demand:
//   - a failing (`failure_log` row) OR soft-cap completion → WRITE attempted;
//   - a merged first attempt (under the soft cap, no failure_log) → NO write.

interface ReapPaths {
  dir: string;
  state: string;
  log: string;
}

function makeReapTmp(): ReapPaths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reflection-fire-completion-"));
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function writeReapState(path: string, patch: Record<string, unknown>): void {
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

function runReapCompletion(
  args: string[],
  paths: ReapPaths,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      // Issue #2635: the cycle-record POST reads HYDRA_BASE_URL / HYDRA_API,
      // not HYDRA_API_BASE — pin them to the dead port too so nothing leaks to
      // a live orchestrator on :4000.
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

function reapRunLog(paths: ReapPaths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

describe("reap._fire_reflection_for_completion — failure-path writer regression guard (issue #2670)", () => {
  test("a failing (failure_log) completion WRITES the reflection (swallowed) keyed on the anchor", () => {
    const tmp = makeReapTmp();
    try {
      writeReapState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tFAIL",
            anchor: "issue-2670",
          },
        },
        failure_log: [
          { ts: Date.now() / 1000, pattern: "subagent_failure", task_id: "tFAIL", note: "npm test failed" },
        ],
      });

      const r = runReapCompletion(["dev_orch", "tFAIL", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(
        reapRunLog(tmp),
        /reflection_record_skipped anchor=issue-2670/,
        "a genuine failure completion must attempt the reflection WRITE (the failure-path producer must still fire)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a soft-cap runaway WRITES the reflection even without a failure_log row", () => {
    const tmp = makeReapTmp();
    try {
      writeReapState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tSOFT",
            anchor: "issue-2670",
          },
        },
        failure_log: [],
      });

      // total_tokens (500k) >= subagent_max_tokens (400k) → soft-cap "failed".
      const r = runReapCompletion(["dev_orch", "tSOFT", "500000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.match(
        reapRunLog(tmp),
        /reflection_record_skipped anchor=issue-2670/,
        "a soft-cap token runaway is a non-merged failure and must fire the reflection WRITE",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a merged first attempt (no failure signal, under the soft cap) does NOT write", () => {
    const tmp = makeReapTmp();
    try {
      writeReapState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tMERGE",
            anchor: "issue-2670",
          },
        },
        failure_log: [],
      });

      // Under the soft cap AND no failure_log row → a clean merged-first-attempt
      // completion. The failure-only invariant means NO reflection is written.
      const r = runReapCompletion(["dev_orch", "tMERGE", "1000", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.doesNotMatch(
        reapRunLog(tmp),
        /reflection_record_skipped/,
        "a merged first attempt must NOT fire a reflection (reflections are prior-FAILURE narratives, not success logs)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Issue #2670 — honest-none discriminator (the discover / health filing side).
// ===========================================================================
//
// `isHonestNoneVerdict` is the single predicate a filing decision consults so a
// merged-first-attempt `none` (the EXPECTED steady state of a high-merge run)
// is classified honest-none and NOT re-filed as "reflection silenced". Only the
// genuine candidate false-none (`served-but-bucketed-none`) is file-worthy.
describe("isHonestNoneVerdict — honest-none filing discriminator (issue #2670)", () => {
  test("the honest / non-actionable verdicts are ALL classified honest-none (do not file)", () => {
    // These three are the states a high-merge run legitimately produces — a
    // merged first attempt structurally serves nothing, so an all-`none`
    // empty-store window is honest, not an anomaly.
    for (const verdict of ["no-data", "healthy", "all-none-empty-store"] as const) {
      assert.equal(
        isHonestNoneVerdict({ verdict }),
        true,
        `verdict '${verdict}' must classify as honest-none (do NOT re-file the false alarm)`,
      );
    }
  });

  test("only served-but-bucketed-none is file-worthy (NOT honest-none)", () => {
    assert.equal(
      isHonestNoneVerdict({ verdict: "served-but-bucketed-none" }),
      false,
      "a deposit that landed yet still bucketed 'none' is the genuine candidate false-none — the ONLY verdict a health/discover check should surface",
    );
  });

  test("an unrecognised verdict fails safe to honest-none (do not file)", () => {
    // Fail-safe: an unknown state defaults to 'do not file the alarm', so a
    // future verdict token cannot accidentally reopen the re-file loop.
    assert.equal(
      isHonestNoneVerdict({ verdict: "some-future-token" as never }),
      true,
      "an unknown verdict must default to honest-none (do not file)",
    );
  });
});
