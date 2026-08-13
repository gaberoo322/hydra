/**
 * Regression test for issue #3675 — `testsAfter` never reached `/api/metrics`
 * even though the grounding deposits feeding it were written correctly.
 *
 * Root cause: the deposit READ key and the deposit WRITE key are derived by two
 * different actors from two different identifiers, and they disagreed by exactly
 * one prefix.
 *
 *   WRITE — `scripts/reflection-deposit.sh derive_task_id()` runs INSIDE the
 *   worktree subagent and keys on the `agent-<HASH>` worktree-dir basename with
 *   the `agent-` prefix STRIPPED, so every deposit on disk is a BARE hex hash.
 *
 *   READ — `reap.py` keys on the autopilot slot `task_id`, which measured live
 *   (2026-07-27) as `worktree-agent-<HASH>` on the occupied slots, with an older
 *   `agent-<HASH>` generation still present in the trend. Both miss the
 *   bare-hash file, so `_read_grounding_tests` returned {} on every pipeline
 *   dispatch: 0/50 trend rows carried `testsAfter` while ~90 fully-populated
 *   grounding deposits sat unread in /tmp.
 *
 * Fix: `reap.py::_resolve_deposit_path` (+ `_deposit_key_candidates`) resolves
 * the read key against an ORDERED candidate list — the verbatim `task_id` first,
 * then the `worktree-agent-` / `agent-` stripped forms — uniformly for all four
 * deposit kinds.
 *
 * These cases pin BOTH ENDS so they cannot drift apart again:
 *   - the WRITE end is exercised for real by running `reflection-deposit.sh
 *     reflect` from an `agent-<HASH>` cwd and asserting the filename it produces
 *     is the BARE hash (the `reflect` mode writes the anchor deposit without
 *     running `npm test`, so this is a cheap true round-trip);
 *   - the READ end is exercised by driving the real `reap.py completion` CLI
 *     against a DEAD orchestrator (HYDRA_API_BASE → a closed port) so every POST
 *     fails fast and is swallowed, and asserting on the run log.
 *
 * The cycle-record POST itself is fired through dispatch.sh and cannot be
 * inspected from a test, so the run log is the observable surface — hence the
 * `grounding_tests_resolved` / `grounding_tests_deposit_absent` /
 * `deposit_key_fallback` lines this asserts on.
 *
 * #3391 is explicitly NOT touched: the cycle-record WRITE key stays
 * `worktree_branch or task_id`. A case below pins that the branch is still the
 * cycleId even when the deposit resolved via a stripped read key — the two are
 * deliberately different identifiers.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");
const DEPOSIT_SH = join(REPO_ROOT, "scripts", "reflection-deposit.sh");

// A closed port — every reap-path POST fails fast and must be swallowed.
const DEAD_API_BASE = "http://127.0.0.1:1";

// 17 pure-hex chars: the shape `derive_task_id` accepts (12+ hex).
const HASH = "a3675deadbeef0011";

interface Paths {
  dir: string;
  state: string;
  log: string;
}

function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-deposit-key-"));
  return { dir, state: join(dir, "state.json"), log: join(dir, "nightly.log") };
}

function writeState(path: string, slot: Record<string, unknown>): void {
  writeFileSync(
    path,
    JSON.stringify({
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
        dev_orch: slot,
        qa_orch: null,
        research_orch: null,
        dev_target: null,
        qa_target: null,
        research_target: null,
      },
      signal_last_fired: {},
      failure_log: [],
    }),
  );
}

function depositGrounding(dir: string, key: string, body: Record<string, number>): void {
  writeFileSync(join(dir, `hydra-grounding-tests-${key}`), JSON.stringify(body));
}

function runCompletion(paths: Paths, taskId: string): { status: number; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", "dev_orch", taskId, "1000", "hydra-dev"], {
    env: {
      ...process.env,
      HYDRA_API_BASE: DEAD_API_BASE,
      // dispatch.sh's `hydra` CLI / curl fallback read these, not HYDRA_API_BASE
      // — pin them to the dead port too so no POST can leak to the live
      // orchestrator on :4000 (issue #2635).
      HYDRA_BASE_URL: DEAD_API_BASE,
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      HYDRA_AUTOPILOT_REFL_DIR: paths.dir,
      HYDRA_REAP_WORKTREE_GC: "0",
      // Issue #3866: reap.py's dev_orch no-PR-stall check shells out to a REAL
      // `gh pr list`/`gh issue edit`/`gh issue comment` against
      // HYDRA_AUTOPILOT_REPO whenever a dev_orch completion carries an anchor
      // with no open PR — and this suite deposits real-looking anchor refs
      // (e.g. "issue-3675"). Point it at a nonexistent fixture repo with an
      // invalid token (same pattern as test/autopilot-reap-task-id-mismatch.
      // test.mts) so it can never touch the real gaberoo322/hydra repo.
      HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
      GH_TOKEN: "invalid-test-token",
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

describe("deposit key resolution — WRITE end (scripts/reflection-deposit.sh, issue #3675)", () => {
  test("an agent-<HASH> worktree cwd deposits under the BARE hash, with no agent- prefix", () => {
    const tmp = makeTmp();
    try {
      // A worktree checkout exactly as the harness lays it out.
      const worktree = join(tmp.dir, "worktrees", `agent-${HASH}`);
      mkdirSync(worktree, { recursive: true });
      const depositDir = join(tmp.dir, "deposits");
      mkdirSync(depositDir, { recursive: true });

      const r = spawnSync("bash", [DEPOSIT_SH, "reflect", "hydra-dev", "issue-3675", "{}"], {
        cwd: worktree,
        env: {
          ...process.env,
          HYDRA_AUTOPILOT_REFL_DIR: depositDir,
          // The cwd-derived key must win outright; blank the fallbacks so a
          // leaked env var cannot mask a broken cwd derivation.
          HYDRA_AUTOPILOT_TASK_ID: "",
          CLAUDE_CODE_SESSION_ID: "",
        },
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `deposit helper must always exit 0, got ${r.status}; stderr=${r.stderr}`);

      const written = readdirSync(depositDir);
      assert.ok(
        written.includes(`hydra-refl-anchor-${HASH}`),
        `the deposit must be keyed on the BARE hash; got ${JSON.stringify(written)}`,
      );
      assert.ok(
        !written.some((f) => f.includes("agent-")),
        `no deposit may carry an agent-/worktree-agent- prefix; got ${JSON.stringify(written)}`,
      );
      assert.equal(
        readFileSync(join(depositDir, `hydra-refl-anchor-${HASH}`), "utf-8").trim(),
        "issue-3675",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("reap strips exactly the prefixes the writer can leave in front of that bare hash", () => {
    // The drift pin: the writer strips `agent-` off its cwd basename, and the
    // harness stamps the slot task_id as `worktree-agent-<HASH>`. Both prefixes
    // must be in reap's strip list or the join silently misses again.
    const reap = readFileSync(REAP, "utf-8");
    const writer = readFileSync(DEPOSIT_SH, "utf-8");
    assert.match(
      reap,
      /DEPOSIT_KEY_STRIP_PREFIXES\s*=\s*\(\s*"worktree-agent-"\s*,\s*"agent-"\s*,?\s*\)/,
      "reap must strip both the worktree-agent- (live slot task_id) and agent- (older generation) prefixes",
    );
    assert.match(
      writer,
      /\$\{PWD##\*\/agent-\}/,
      "the writer must still derive its key by stripping agent- off the worktree cwd basename",
    );
  });
});

describe("deposit key resolution — READ end (scripts/autopilot/reap.py, issue #3675)", () => {
  test("a worktree-agent-<HASH> slot task_id resolves the BARE-hash grounding deposit", () => {
    const tmp = makeTmp();
    try {
      const taskId = `worktree-agent-${HASH}`;
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
        branch: taskId,
      });
      // Written by the subagent under the BARE hash — the live corpus shape.
      depositGrounding(tmp.dir, HASH, { testsAfter: 6692, testsPassingAfter: 6686 });

      const r = runCompletion(tmp, taskId);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        new RegExp(`deposit_key_fallback kind=hydra-grounding-tests task_id=${taskId} resolved_key=${HASH}`),
        "the read key must fall back to the worktree-agent--stripped bare hash",
      );
      assert.match(
        log,
        /grounding_tests_resolved .*fields=testsAfter=6692,testsPassingAfter=6686/,
        "the resolved counts must be forwarded to the cycle-record write",
      );
      assert.doesNotMatch(
        log,
        /grounding_tests_deposit_absent/,
        "a resolvable deposit must not report absent",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an agent-<HASH> slot task_id (the older generation) also resolves it", () => {
    const tmp = makeTmp();
    try {
      const taskId = `agent-${HASH}`;
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
      });
      depositGrounding(tmp.dir, HASH, { testsAfter: 42 });

      const r = runCompletion(tmp, taskId);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        new RegExp(`deposit_key_fallback kind=hydra-grounding-tests task_id=${taskId} resolved_key=${HASH}`),
      );
      assert.match(log, /grounding_tests_resolved .*fields=testsAfter=42/);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("an already-aligned task_id resolves by EXACT match, with no fallback", () => {
    const tmp = makeTmp();
    try {
      // The signal-class / bare-hash generation, whose task_id already IS the
      // deposit key. It must keep resolving without touching the fallback path.
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: HASH,
      });
      depositGrounding(tmp.dir, HASH, { testsAfter: 7 });

      const r = runCompletion(tmp, HASH);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(log, /grounding_tests_resolved .*fields=testsAfter=7/);
      assert.doesNotMatch(
        log,
        /deposit_key_fallback/,
        "an exact match must not report a fallback resolution",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("the anchor deposit resolves through the SAME resolver", () => {
    const tmp = makeTmp();
    try {
      const taskId = `worktree-agent-${HASH}`;
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
        branch: taskId,
      });
      writeFileSync(join(tmp.dir, `hydra-refl-anchor-${HASH}`), "issue-3675");

      const r = runCompletion(tmp, taskId);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.match(
        runLog(tmp),
        new RegExp(`deposit_key_fallback kind=hydra-refl-anchor task_id=${taskId} resolved_key=${HASH}`),
        "all four deposit kinds must share ONE key-derivation seam",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a genuinely missing deposit stays best-effort: no throw, no recorded 0, and it is LOGGED", () => {
    const tmp = makeTmp();
    try {
      const taskId = `worktree-agent-${HASH}`;
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
        branch: taskId,
      });
      // No deposit written at all — the honest-absence case.

      const r = runCompletion(tmp, taskId);
      assert.equal(r.status, 0, `a missing deposit must never fail the reap, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        new RegExp(`grounding_tests_deposit_absent task_id=${taskId} tried=${taskId},${HASH}`),
        "the exhausted candidate list must be logged — this branch was silent for months (#3675)",
      );
      assert.doesNotMatch(
        log,
        /grounding_tests_resolved/,
        "an absent deposit must not synthesise a resolved (0-valued) read",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("#3391 is unchanged: the cycle-record is still keyed on the worktree BRANCH, not the resolved deposit key", () => {
    const tmp = makeTmp();
    try {
      const taskId = `worktree-agent-${HASH}`;
      const branch = "worktree-agent-442cb1e8-t1-dev_orch";
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
        branch,
      });
      depositGrounding(tmp.dir, HASH, { testsAfter: 6692 });

      const r = runCompletion(tmp, taskId);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        new RegExp(`cycle_record_fired cycleId=${branch} task_id=${taskId} skill=hydra-dev`),
        "the cycle-record WRITE key must remain the worktree branch (#3391) — only the deposit READ key changed",
      );
      assert.doesNotMatch(
        log,
        new RegExp(`cycle_record_fired cycleId=${HASH} `),
        "the resolved deposit key must never leak into the cycleId — that would undo #3391",
      );
      assert.match(
        log,
        /grounding_tests_resolved .*fields=testsAfter=6692/,
        "and the deposit must still have resolved on the stripped read key",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a path separator in the task_id can never escape the deposit directory", () => {
    const tmp = makeTmp();
    try {
      const taskId = "worktree-agent-../../etc";
      writeState(tmp.state, {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000),
        task_id: taskId,
      });

      const r = runCompletion(tmp, taskId);
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      assert.match(
        runLog(tmp),
        new RegExp(`grounding_tests_deposit_absent task_id=${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} tried=-`),
        "a separator-bearing key must be dropped outright, leaving NO candidate to probe",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
