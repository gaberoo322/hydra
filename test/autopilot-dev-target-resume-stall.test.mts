/**
 * Regression tests for issue #4195 — reap.py: a `dev_target` completion whose
 * anchor has NO open PR closing it is a STALL, not a finished cycle.
 *
 * Motivating deadlock (autopilot run b0253320, 2026-08-21): a dev_target
 * dispatch ended without opening a PR, leaving its Target anchor labelled
 * `in-progress` forever. hydra-target-build Step 1 refuses to claim new work
 * while 3 issues carry `in-progress` (ADR-0031 Decision 4's WIP cap), so
 * three orphaned claims (hydra-betting #864/#840/#836 — verified: no open
 * PR, no matching remote branch, no live agent session) structurally
 * dead-armed the ENTIRE dev_target class. It is a deadlock, not a leak:
 * nothing on the Target side ever cleared them, because the #3866 no-PR
 * stall backstop was gated on `cls == "dev_orch"` only.
 *
 * The fix (`_handle_dev_target_stall` in `scripts/autopilot/reap.py`) is the
 * dev_target mirror of `_handle_dev_orch_stall` with three deliberate
 * divergences pinned by this suite (design-concept #4195):
 *   - every gh call targets TARGET_REPO (HYDRA_TARGET_GITHUB_REPO override),
 *     never the orch REPO — the anchor's issue number is a hydra-betting
 *     number (INV-2);
 *   - PR-existence uses pr-refs.py's `closing_issues()` (Closes/Fixes/
 *     Resolves only), never `referenced_issues()` — Target build branches
 *     are always `feature/<cycle-id>`, so the branch-name half of the wider
 *     predicate can never match, while ADR-0031 Decision 5 (amended #3700)
 *     already enforces a `Closes #N` body line on every board-picked build
 *     (INV-4);
 *   - a confirmed stall relabels `in-progress` -> `ready-for-agent` ONLY —
 *     `needs-dev-resume` is an orch-repo label that does not exist on
 *     hydra-betting, no resume-pin queue is appended, and no new label is
 *     created: Step 2's board-picker already searches `ready-for-agent`,
 *     so the WIP slot frees on the next board read (INV-5/INV-7).
 *
 * The #4057 disambiguator transfers verbatim: a CLOSED anchor is a
 * legitimate terminal outcome for dev_target too (observed hydra-betting
 * #1247 — a triage/research issue closed directly with a bucketed list +
 * filed follow-ons as its done-when criterion, no PR by design), so the
 * handler reads the anchor's live state on the TARGET repo before any
 * mutation and short-circuits on CLOSED.
 *
 * Fail-open is pinned as broadly as on the orch side: a `gh` hiccup on the
 * PR-list fetch OR the issue-state read at ANY point means NO mutation.
 *
 * Same hermetic stub-`gh` harness as test/autopilot-dev-resume-stall.test.mts
 * (HYDRA_AUTOPILOT_GH_CLI override recording full argv per call) — no
 * network, no real repo. HYDRA_TARGET_GITHUB_REPO is pointed at a fixture
 * value so every `--repo` flag this handler issues is assertable, and the
 * orch repo override stays at its own distinct fixture so a call aimed at
 * the WRONG repo is detectable.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

const ORCH_REPO_FIXTURE = "hydra-test/nonexistent-fixture";
const TARGET_REPO_FIXTURE = "target-test/nonexistent-fixture";

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
      HYDRA_AUTOPILOT_REPO: ORCH_REPO_FIXTURE,
      HYDRA_TARGET_GITHUB_REPO: TARGET_REPO_FIXTURE,
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

describe("reap.py completion → dev_target no-PR stall detection (issue #4195)", () => {
  test("STALL: no closing PR + anchor OPEN → release in-progress → ready-for-agent on the TARGET repo", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d1",
            anchor: "issue-864",
            branch: "feature/cyc-b0253320",
          },
        },
      });

      const r = runCompletion(["dev_target", "d1", "67000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]", // no open PRs on the Target repo at all
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}', // orphaned claim, not terminal
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dev_target_stall_no_pr anchor=issue-864 task_id=d1 branch=feature\/cyc-b0253320 relabelled=True/,
        "a confirmed no-PR stall must log dev_target_stall_no_pr with relabelled=True",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some(
          (c) => c.startsWith("pr list") && c.includes(`--repo ${TARGET_REPO_FIXTURE}`),
        ),
        `must query open PRs on the TARGET repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.includes(`--repo ${ORCH_REPO_FIXTURE}`)),
        `no gh call may target the orch repo (INV-2): ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue edit 864") &&
            c.includes(`--repo ${TARGET_REPO_FIXTURE}`) &&
            c.includes("--remove-label in-progress") &&
            c.includes("--add-label ready-for-agent"),
        ),
        `must release issue #864 in-progress -> ready-for-agent on the TARGET repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.includes("needs-dev-resume")),
        `needs-dev-resume is an orch-only label and must never be applied on the Target repo (INV-5): ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some((c) => c.startsWith("issue comment 864") && c.includes(`--repo ${TARGET_REPO_FIXTURE}`)),
        `must post an explanatory comment on issue #864 on the TARGET repo: ${JSON.stringify(calls)}`,
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.ok(
        !s.dev_resume_pending || s.dev_resume_pending.length === 0,
        "no Target resume-pin queue may be appended (INV-7)",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLEAN: an open PR CLOSES the anchor → no mutation at all", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d2",
            anchor: "issue-865",
            branch: "feature/cyc-f1347b80",
          },
        },
      });

      // ADR-0031 Decision 5 (amended #3700): every board-picked-issue Target
      // build carries a `Closes #N` body line — the enforced, sufficient
      // signal that the anchor is legitimately in flight.
      const prJson = JSON.stringify([
        { headRefName: "feature/cyc-f1347b80", body: "Implements the fix.\n\nCloses #865" },
      ]);
      const r = runCompletion(["dev_target", "d2", "60000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "a found closing PR must never log a stall");

      const calls = ghCalls(tmp);
      assert.ok(calls.some((c) => c.startsWith("pr list")), "must still check for an open closing PR");
      assert.ok(
        !calls.some((c) => c.startsWith("issue view")),
        `the issue-state read must never fire when a closing PR was found: ${JSON.stringify(calls)}`,
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

  test("INV-4: a branch-name match WITHOUT a closing verb is NOT a found PR for dev_target", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d3",
            anchor: "issue-866",
          },
        },
      });

      // This payload WOULD satisfy dev_orch's wider referenced_issues()
      // (branch-name half matches "issue-866-fix") — for dev_target it must
      // NOT count: Target build branches are always feature/<cycle-id>, so
      // only the strict closing verb is the documented, enforced signal.
      const prJson = JSON.stringify([
        { headRefName: "issue-866-fix", body: "Work in progress, see also Refs #866" },
      ]);
      const r = runCompletion(["dev_target", "d3", "40000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: prJson,
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}',
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.match(
        log,
        /dev_target_stall_no_pr anchor=issue-866 task_id=d3/,
        "a non-closing reference must fall through to the stall path (closing_issues() only)",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("issue edit 866") && c.includes("--add-label ready-for-agent")),
        `the stall release must fire: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("CLOSED ANCHOR: no closing PR but the anchor issue is CLOSED → no mutation (hydra-betting #1247 shape)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d4",
            anchor: "issue-1247",
            branch: "feature/cyc-closed-direct",
          },
        },
      });

      // The exact motivating shape: a triage/research issue whose done-when is
      // a bucketed list + filed follow-ons — the dispatch closed it directly,
      // no PR was the CORRECT outcome.
      const r = runCompletion(["dev_target", "d4", "50000", "hydra-target-build"], tmp, {
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
        /dev_target_stall_no_pr_skipped_closed anchor=issue-1247 task_id=d4/,
        "the closed-anchor skip must be logged so a no-op reap is distinguishable from a missed check",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some(
          (c) => c.startsWith("issue view 1247") && c.includes(`--repo ${TARGET_REPO_FIXTURE}`),
        ),
        `must read the anchor issue's own state on the TARGET repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `must NOT relabel a CLOSED anchor (finished work must not re-enter the pick order): ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue comment")),
        `must NOT comment on a CLOSED anchor: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN: gh pr list fails → fail OPEN, no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d5",
            anchor: "issue-867",
          },
        },
      });

      const r = runCompletion(["dev_target", "d5", "30000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_EXIT: "1", // simulate gh auth/network failure
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "an unknown PR-existence result must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "must NOT relabel when gh pr list failed");
      assert.ok(!calls.some((c) => c.startsWith("issue comment")), "must NOT comment when gh pr list failed");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN STATE: gh issue view fails → fail OPEN, no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d6",
            anchor: "issue-868",
          },
        },
      });

      const r = runCompletion(["dev_target", "d6", "30000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_EXIT: "1", // simulate gh auth/network failure on the state read
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "an unreadable issue state must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "must NOT relabel when the issue state is unreadable");
      assert.ok(!calls.some((c) => c.startsWith("issue comment")), "must NOT comment when the issue state is unreadable");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN STATE: gh issue view returns unparseable output → fail OPEN, no mutation", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d7",
            anchor: "issue-869",
          },
        },
      });

      const r = runCompletion(["dev_target", "d7", "30000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: "not-json-at-all", // exit 0 but garbage stdout
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_target_stall_no_pr"), "unparseable state must never be treated as a stall");

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `unparseable state output must fail open, not guess a stall: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO ANCHOR: a dev_target completion with no resolvable anchor never calls gh at all", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d8",
            // no anchor field, and no reflection-deposit file for d8 either
          },
        },
      });

      const r = runCompletion(["dev_target", "d8", "10000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "no anchor means no PR-existence check at all");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NON-dev_target class: a qa_target completion never triggers the stall check", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {});

      const r = runCompletion(["qa_target", "d9", "20000", "hydra-target-qa"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "only dev_target completions run the no-PR stall check");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NON-ISSUE anchor: a non-issue-<N> anchor never calls gh (failing-tests / priorities-doc picks)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_target: {
            skill: "hydra-target-build",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "d10",
            anchor: "failing-tests",
          },
        },
      });

      const r = runCompletion(["dev_target", "d10", "10000", "hydra-target-build"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "a non-issue anchor carries no GitHub issue number — nothing to check");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

describe("reap.py completion → dev_orch path unchanged by the #4195 extraction (INV-6)", () => {
  test("dev_orch stall still targets the ORCH repo and applies needs-dev-resume + resume queue", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {
        slots: {
          dev_orch: {
            skill: "hydra-dev",
            started_epoch: Math.floor(Date.now() / 1000) - 600,
            task_id: "o1",
            anchor: "issue-3726",
            branch: "issue-3726-fix",
          },
        },
      });

      const r = runCompletion(["dev_orch", "o1", "50000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
        STUB_ISSUE_VIEW_JSON: '{"state":"OPEN"}',
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dev_stall_no_pr anchor=issue-3726 task_id=o1 branch=issue-3726-fix relabelled=True/,
        "the dev_orch stall path must behave exactly as before the _fetch_pr_list_json extraction",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("pr list") && c.includes(`--repo ${ORCH_REPO_FIXTURE}`)),
        `dev_orch must keep querying the ORCH repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.includes(`--repo ${TARGET_REPO_FIXTURE}`)),
        `dev_orch must never target the TARGET repo: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue edit 3726") &&
            c.includes("--remove-label in-progress") &&
            c.includes("--add-label needs-dev-resume"),
        ),
        `dev_orch keeps its needs-dev-resume relabel: ${JSON.stringify(calls)}`,
      );

      const s = JSON.parse(readFileSync(tmp.state, "utf-8"));
      assert.equal(s.dev_resume_pending.length, 1, "dev_orch keeps its resume-pin queue append");
      assert.equal(s.dev_resume_pending[0].anchor, "issue-3726");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
