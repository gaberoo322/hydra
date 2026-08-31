/**
 * Regression tests for issue #4195 — reap.py: a `dev_target` completion whose
 * Target-board anchor has NO open PR closing it is an orphaned claim, and must
 * be released `in-progress` → `ready-for-agent` on the TARGET repo.
 *
 * Motivating incident (autopilot run b0253320, 2026-08-21): dev_target burned
 * 67k tokens stopping at pre-flight because hydra-target-build Step 1's WIP
 * gate (ADR-0031 Decision 4) refused to claim work at 3/3 `in-progress`
 * issues — hydra-betting #864/#840/#836, all three verified orphaned claims
 * (no open PR, no matching branch, no live session). Three orphaned claims
 * don't just lose three issues: no slot can free because nothing is actually
 * in flight, so the lane deadlocks at zero throughput indefinitely. The
 * stale-claim recovery that eventually released #864 ran only
 * opportunistically and the deadlock re-formed within hours.
 *
 * The fix (`_handle_dev_target_stall` in `scripts/autopilot/reap.py`) is the
 * Target-side mirror of the #3866 dev_orch stall backstop, with the
 * differences the approved design concept for this issue pins:
 *
 *   - every gh call targets TARGET_REPO (HYDRA_TARGET_GITHUB_REPO, default
 *     gaberoo322/hydra-betting — collect-state.sh's existing env var), never
 *     the orch REPO: a dev_target anchor like "issue-864" is a hydra-betting
 *     board issue, and relabelling that number against the orch repo would
 *     mutate an unrelated orchestrator issue;
 *   - the PR predicate is pr-refs.py's closing_issues() (Closes/Fixes/
 *     Resolves only, #4045), NOT referenced_issues() — Target build branches
 *     are always `feature/<cycle-id>` so the branch-name half can never match
 *     a Target PR anyway, and ADR-0031 Decision 5 (as amended by #3700)
 *     already enforces a `Closes #<ANCHOR_NUM>` body line for board-picked
 *     Target builds;
 *   - a confirmed stall releases in-progress → ready-for-agent ONLY — never
 *     `needs-dev-resume` (an orch-only label that does not exist on
 *     hydra-betting) — so the WIP-gate slot frees on the next board read with
 *     zero new label taxonomy;
 *   - no resume-pin queue: nothing is appended to state.dev_resume_pending
 *     (drained by the dev_orch selector only) and no Target-side label is
 *     invented — both explicitly out of scope per the issue's open questions;
 *   - #4057 parity: a CLOSED anchor (hydra-betting #1247 — a triage/research
 *     cycle legitimately closed directly, no PR by design) short-circuits
 *     with a log line only, and any gh failure/unparseable output fails OPEN
 *     (no mutation).
 *
 * A stub `gh` binary (HYDRA_AUTOPILOT_GH_CLI override) replaces the real CLI
 * so these tests run hermetically — no network, no real repo. The orch-repo
 * env (HYDRA_AUTOPILOT_REPO) and the Target-repo env
 * (HYDRA_TARGET_GITHUB_REPO) are pointed at DIFFERENT fixture names so every
 * assertion can tell which board a call actually targeted.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

const ORCH_FIXTURE_REPO = "hydra-test/nonexistent-fixture";
const TARGET_FIXTURE_REPO = "target-test/nonexistent-fixture";

interface Paths {
  dir: string;
  state: string;
  log: string;
  ghStub: string;
  ghCallsLog: string;
}

/**
 * Writes an executable stub `gh` that:
 *   - records every invocation (space-joined argv) as one line in ghCallsLog
 *   - answers `pr list ...` with $STUB_PR_LIST_JSON on stdout, exit
 *     $STUB_PR_LIST_EXIT (default 0)
 *   - answers `issue view ...` with $STUB_ISSUE_VIEW_JSON on stdout (default
 *     {"state":"OPEN"}), exit $STUB_ISSUE_VIEW_EXIT (default 0)
 *   - answers `issue edit ...` / `issue comment ...` with exit
 *     $STUB_ISSUE_EDIT_EXIT / $STUB_ISSUE_COMMENT_EXIT (default 0)
 */
function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-dev-target-"));
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
    printf '%s' "$out"
    exit 0
    ;;
  "issue edit")
    exit "\${STUB_ISSUE_EDIT_EXIT:-0}"
    ;;
  "issue comment")
    exit "\${STUB_ISSUE_COMMENT_EXIT:-0}"
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
  ghEnv: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("python3", [REAP, "completion", ...args], {
    env: {
      ...process.env,
      HYDRA_API_BASE: "http://127.0.0.1:1", // dead port — no real orchestrator calls
      HYDRA_BASE_URL: "http://127.0.0.1:1",
      HYDRA_AUTOPILOT_STATE: paths.state,
      HYDRA_AUTOPILOT_LOG: paths.log,
      HYDRA_AUTOPILOT_REPO: ORCH_FIXTURE_REPO,
      HYDRA_TARGET_GITHUB_REPO: TARGET_FIXTURE_REPO,
      HYDRA_REAP_WORKTREE_GC: "0", // keep the worktree-GC side-effect out of the test
      HYDRA_AUTOPILOT_GH_CLI: paths.ghStub,
      ...ghEnv,
    },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runLog(paths: Paths): string {
  return existsSync(paths.log) ? readFileSync(paths.log, "utf-8") : "";
}

function ghCalls(paths: Paths): string[] {
  return existsSync(paths.ghCallsLog)
    ? readFileSync(paths.ghCallsLog, "utf-8").trim().split("\n").filter(Boolean)
    : [];
}

describe("reap.py completion → dev_target no-PR stall release (issue #4195)", () => {
  test("STALL: no closing PR on TARGET_REPO + issue OPEN → release in-progress → ready-for-agent + comment", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t1",
            anchor: "issue-864",
            branch: "feature/cycle-b0253320",
          },
        },
      });

      const r = runCompletion(["dev_target", "t1", "67000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]", // no open PRs on the Target board at all
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}', // the orphaned-claim shape: still open
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dev_target_stall_no_pr anchor=issue-864 task_id=t1 branch=feature\/cycle-b0253320 relabelled=True/,
        "a confirmed no-PR stall must log dev_target_stall_no_pr with relabelled=True",
      );

      const calls = ghCalls(tmp);
      assert.ok(calls.length > 0, "the stall check must have run gh calls");
      // The stub's `echo "$*"` flattens the multi-line comment body into
      // continuation lines; only lines that OPEN a gh invocation are calls.
      const callStarts = calls.filter((c) =>
        /^(pr list|issue (view|edit|comment))\b/.test(c),
      );
      assert.ok(callStarts.length >= 4, `expected the full gh call sequence, saw: ${JSON.stringify(calls)}`);
      for (const c of callStarts) {
        assert.ok(
          c.includes(`--repo ${TARGET_FIXTURE_REPO}`),
          `every gh call the dev_target stall check makes must target the TARGET repo, saw: ${JSON.stringify(calls)}`,
        );
      }
      assert.ok(
        calls.some((c) => c.startsWith("pr list") && c.includes(`--repo ${TARGET_FIXTURE_REPO}`)),
        `must query the TARGET repo's open PRs: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue view 864") &&
            c.includes(`--repo ${TARGET_FIXTURE_REPO}`),
        ),
        `must read the Target anchor issue's state on the TARGET repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue edit 864") &&
            c.includes("--remove-label in-progress") &&
            c.includes("--add-label ready-for-agent"),
        ),
        `must release the orphaned claim in-progress → ready-for-agent: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.includes("needs-dev-resume")),
        `needs-dev-resume is an orch-only label and must never be applied on the Target board: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some((c) => c.startsWith("issue comment 864")),
        `must post an explanatory comment on the Target issue: ${JSON.stringify(calls)}`,
      );

      // INV-7 (design concept): no resume-pin queue — the Target release
      // must not append anything to state.dev_resume_pending (that queue is
      // drained by the dev_orch selector only).
      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "a dev_target stall must never queue a dev_resume_pending record",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLEAN: an open PR on TARGET_REPO CLOSES the anchor → no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t2",
            anchor: "issue-840",
            branch: "feature/cycle-aa17",
          },
        },
      });

      // ADR-0031 Decision 5 (as amended by #3700) enforces this body shape
      // for every board-picked-issue Target build.
      const prJson = JSON.stringify([
        { headRefName: "feature/cycle-aa17", body: "Implements the fix.\n\nCloses #840" },
      ]);
      const r = runCompletion(["dev_target", "t2", "50000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "a found closing PR must never log a stall");

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("pr list") && c.includes(`--repo ${TARGET_FIXTURE_REPO}`)),
        "must still check the TARGET repo's open PRs",
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue view")),
        `the #4057 issue-state read must never fire when a closing PR was found: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel when a closing PR was found: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue comment")),
        `must NOT comment when a closing PR was found: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("PREDICATE: a branch-name-only PR reference does not count — closing verb required", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t3",
            anchor: "issue-870",
            branch: "feature/cycle-bb29",
          },
        },
      });

      // This payload references #870 under referenced_issues()'s BROADER
      // predicate (branch-name half: "issue-870-fix" matches _BRANCH_RE) but
      // carries no closing verb, so closing_issues() excludes it. The
      // dev_target check must use the NARROW predicate (design concept INV-4)
      // and still treat the anchor as stalled.
      const prJson = JSON.stringify([
        { headRefName: "issue-870-fix", body: "" },
      ]);
      const r = runCompletion(["dev_target", "t3", "40000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: prJson,
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}',
      });
      assert.equal(r.status, 0);

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue edit 870") &&
            c.includes("--remove-label in-progress") &&
            c.includes("--add-label ready-for-agent"),
        ),
        `a branch-name-only reference is NOT a closing PR — the stall must fire: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLOSED ANCHOR: no closing PR but the Target issue is CLOSED → log-only skip, no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t4",
            anchor: "issue-1247",
            branch: "feature/cycle-cc31",
          },
        },
      });

      // The exact motivating shape (design concept INV-3): hydra-betting
      // #1247 — a dev_target triage/research cycle whose done-when criterion
      // was bucketing + filing follow-ons, closed directly with no PR by
      // design. No closing PR + CLOSED state = terminal outcome, not a stall.
      const r = runCompletion(["dev_target", "t4", "30000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: '{"state":"CLOSED"}',
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.ok(
        !log.includes("dev_target_stall_no_pr anchor="),
        "a correctly-CLOSED anchor must never be recorded as a stall",
      );
      assert.match(
        log,
        /dev_target_stall_no_pr_skipped_closed anchor=issue-1247 task_id=t4/,
        "the closed-anchor skip must be logged so a no-op reap is distinguishable from a missed check",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("issue view 1247") && c.includes(`--repo ${TARGET_FIXTURE_REPO}`)),
        `must read the Target anchor's own state via a per-issue call: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel a CLOSED anchor (it re-queues finished work): ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue comment")),
        `must NOT comment on a CLOSED anchor: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("FAIL-OPEN: gh pr list non-zero exit → no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t5",
            anchor: "issue-836",
            branch: "feature/cycle-dd43",
          },
        },
      });

      const r = runCompletion(["dev_target", "t5", "20000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_EXIT: "1", // simulate gh auth/network failure
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "an unknown PR-closing result must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel when gh pr list failed: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("FAIL-OPEN: gh issue view non-zero exit → no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t6",
            anchor: "issue-838",
            branch: "feature/cycle-ee55",
          },
        },
      });

      const r = runCompletion(["dev_target", "t6", "20000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_EXIT: "1", // state read fails on the no-PR branch
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "an unreadable issue state must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel when the issue state is unreadable: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("FAIL-OPEN: unparseable pr list payload (exit 0, garbage stdout) → no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t7",
            anchor: "issue-842",
            branch: "feature/cycle-ff67",
          },
        },
      });

      // pr-refs.py's closing_issues() deliberately swallows JSON parse
      // errors as an empty set — which would read as "no closing PR". The
      // handler must validate the payload shape itself and treat garbage as
      // UNKNOWN, never as a stall.
      const r = runCompletion(["dev_target", "t7", "20000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "not-json-at-all",
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "an unparseable payload must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `unparseable pr list output must fail open, not guess a stall: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NON-ISSUE ANCHOR: a non-issue anchor never calls gh at all", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t8",
            // failing-tests / typecheck / priorities-doc picks carry no
            // GitHub issue number — nothing to release, nothing to query.
            anchor: "failing-tests",
            branch: "feature/cycle-gg79",
          },
        },
      });

      const r = runCompletion(["dev_target", "t8", "10000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "a non-issue anchor means no PR-existence check at all");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NON-dev_target class: a dev_orch completion with an issue anchor never queries TARGET_REPO", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "t9",
            anchor: "issue-864", // same number as the STALL case — wrong board by construction
            branch: "issue-864-fix",
          },
        },
      });

      const r = runCompletion(["dev_orch", "t9", "10000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}',
      });
      assert.equal(r.status, 0);

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("pr list") && c.includes(`--repo ${ORCH_FIXTURE_REPO}`)),
        `dev_orch's own stall check still queries the ORCH repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.includes(`--repo ${TARGET_FIXTURE_REPO}`)),
        `only dev_target completions may query the TARGET repo (mutual exclusion): ${JSON.stringify(calls)}`,
      );

      // dev_orch's OWN #3866 stall handling firing on the orch board here is
      // correct behaviour (no open PR references the anchor on THAT board) —
      // what must never happen is the dev_target release path: no
      // in-progress → ready-for-agent edit on the TARGET board and no
      // dev_target_stall log line.
      const log = runLog(tmp);
      assert.ok(
        !log.includes("dev_target_stall_no_pr"),
        `the dev_target release must never fire on a dev_orch completion: log=${JSON.stringify(log)}`,
      );
      assert.ok(
        !calls.some(
          (c) =>
            c.startsWith("issue edit 864") &&
            c.includes(`--repo ${TARGET_FIXTURE_REPO}`),
        ),
        `dev_orch's relabel must stay on the ORCH repo: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
