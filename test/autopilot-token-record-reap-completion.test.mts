/**
 * Regression test for issue #2952 — the per-CYCLE token producer.
 *
 * The `hydra:metrics:tokens:by-cycle:<id>` key family (written by
 * `recordSubagentTokens`, read by `getCycleTokensRaw`) was near-empty: the
 * writer had exactly one caller (the POST /api/metrics/tokens handler) and
 * NOTHING posted to it. So the #2930 read-time cycle-trend join (#2964) read
 * null for almost every cycle, and the #2942 per-dispatch outcome record's
 * per-cycle-token FALLBACK never had data to fall back to.
 *
 * The fix wires `reap.run_completion` — the single subprocess that runs on
 * EVERY terminal dispatch and already holds the authoritative `total_tokens` —
 * to POST to /api/metrics/tokens via `_fire_token_record`. It fires ONCE per
 * task_id (after the `reaped_task_ids` dup-guard, so the underlying hincrby
 * can't double-count) and ONLY when `total_tokens > 0` (0 == "no usage parsed"
 * == unknown → truthful null, not a fabricated zero-token key).
 *
 * These tests drive the real `reap.py completion` CLI against a DEAD orchestrator
 * (HYDRA_API_BASE → a closed port) so the POST always fails fast and must be
 * swallowed — token accounting is observability, the reap path is correctness.
 * We assert the swallow line (`token_record_skipped task_id=<id>`) appears when
 * a positive-token completion attempts the POST, is ABSENT on a zero-token
 * completion (no POST attempt), and that the slot is reaped normally either way.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

// A closed port — the token POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-token-"));
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
      // The cycle-record POST rides dispatch.sh's `hydra` CLI / curl fallback,
      // which read HYDRA_BASE_URL / HYDRA_API — pin them to the dead port too
      // so nothing leaks to the live orchestrator on :4000.
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

describe("reap.py completion → per-cycle token-record live fire (issue #2952)", () => {
  test("a positive-token completion fires a token POST (swallowed) keyed on the task_id", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tTok",
            anchor: "issue-2952",
          },
        },
      });

      // 12345 tokens, under the soft cap → clean "completed" cycle.
      const r = runCompletion(["dev_orch", "tTok", "12345", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /token_record_skipped cycleId=tTok skill=hydra-dev tokens=12345/,
        "a positive-token completion must attempt a per-cycle token POST keyed on task_id",
      );
      // The slot must still reap normally.
      assert.match(log, /slot_complete .*task_id=tTok/, "the slot is still reaped");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a zero-token completion makes NO token POST attempt (truthful null, not a fabricated 0)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tZero",
            anchor: "issue-2952",
          },
        },
      });

      // 0 tokens == "no usage parsed" == unknown → no POST (absent key == null).
      const r = runCompletion(["dev_orch", "tZero", "0", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.doesNotMatch(
        log,
        /token_record_skipped/,
        "a zero-token completion must NOT attempt a token POST",
      );
      assert.match(log, /slot_complete .*task_id=tZero/, "the slot is still reaped on a zero-token cycle");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a signal-class completion (non-code-writing skill) still fires the per-cycle token POST", () => {
    const tmp = makeTmp();
    try {
      // A research/discover-shaped completion has no pipeline slot and is NOT in
      // CYCLE_RECORD_SKILLS — but the per-cycle token key is class-agnostic, so
      // it must still fire (the #2964 join / #2942 fallback key on task_id).
      writeState(tmp.state, { slots: {} });

      const r = runCompletion(["research_orch", "tSig", "5000", "hydra-research"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /token_record_skipped cycleId=tSig skill=hydra-research tokens=5000/,
        "a signal-class completion must still attempt a per-cycle token POST",
      );
      // A signal class has no pipeline slot / branch, so exactly ONE token POST
      // fires (keyed on the task_id) — no branch mirror.
      const sigPosts = (log.match(/token_record_skipped cycleId=/g) || []).length;
      assert.equal(sigPosts, 1, "no branch mirror for a slot-less signal-class completion");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a duplicate reap for the same task_id does NOT re-fire the token POST", () => {
    const tmp = makeTmp();
    try {
      // Pre-seed the reaped ledger so this task_id is a dup on first invocation.
      writeState(tmp.state, {
        reaped_task_ids: ["tDup"],
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tDup",
            anchor: "issue-2952",
          },
        },
      });

      const r = runCompletion(["dev_orch", "tDup", "9999", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(log, /dup_skip task_id=tDup/, "the dup-guard short-circuits");
      assert.doesNotMatch(
        log,
        /token_record_skipped/,
        "a dup reap must NOT re-fire the token POST (hincrby would double-count)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a pipeline completion with a worktree branch fires a SECOND token POST keyed on the branch (issue #3187)", () => {
    const tmp = makeTmp();
    try {
      // The slot carries a synthesised worktree branch — the id the #2964 trend
      // join reads token counts by (the metrics record is branch-keyed, not
      // task_id-keyed). Before #3187 the token POST fired only under the bare
      // task_id, so the trend's branch-keyed lookup missed and tokenCost was
      // null on ~44% of pipeline cycles.
      const branch = "worktree-agent-3187ffff-t1-dev_orch";
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tBranch",
            anchor: "issue-3187",
            branch,
          },
        },
      });

      const r = runCompletion(["dev_orch", "tBranch", "7777", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      // Both POSTs are attempted (and swallowed against the dead port): one keyed
      // on the bare task_id, one on the branch-keyed id the trend reads by.
      assert.match(
        log,
        /token_record_skipped cycleId=tBranch skill=hydra-dev tokens=7777/,
        "the task_id-keyed token POST still fires (unchanged)",
      );
      assert.match(
        log,
        new RegExp(`token_record_skipped cycleId=${branch} skill=hydra-dev tokens=7777`),
        "a SECOND token POST fires keyed on the branch the trend join reads (issue #3187)",
      );
      // Exactly two POSTs — the task_id write plus the branch mirror, never more.
      const posts = (log.match(/token_record_skipped cycleId=/g) || []).length;
      assert.equal(posts, 2, "exactly two token POSTs: task_id + branch mirror");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a pipeline completion whose branch EQUALS the task_id fires only ONE token POST (no redundant self-mirror)", () => {
    const tmp = makeTmp();
    try {
      // Defensive: if the synthesised branch happens to equal the task_id, the
      // mirror must not fan out a redundant identical-key POST.
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000),
            task_id: "tSame",
            anchor: "issue-3187",
            branch: "tSame",
          },
        },
      });

      const r = runCompletion(["dev_orch", "tSame", "4242", "hydra-dev"], tmp);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      const posts = (log.match(/token_record_skipped cycleId=tSame/g) || []).length;
      assert.equal(posts, 1, "branch == task_id → a single token POST, no self-mirror");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
