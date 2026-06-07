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
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SELF_HEAL = join(REPO_ROOT, "scripts", "autopilot", "self_heal.py");

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
