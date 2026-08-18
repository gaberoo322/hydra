/**
 * Regression tests for issue #4045 — reap.py: nothing advances
 * `ready-for-agent` -> `needs-qa` after a `dev_orch` completion opens a PR
 * that actually closes the anchor issue.
 *
 * Motivating incident: measured during autopilot run f1347b80 — 9 of 10 open
 * PRs with a resolvable linked issue still had that issue labelled
 * `ready-for-agent`. This silently starves `qa_orch` (gates on `needs-qa`,
 * finds ~0 reviewable PRs) AND corrupts `dev_orch`'s own unpinned
 * `ready-for-agent` self-selection (no open-PR check anywhere in its path),
 * inviting a duplicate build on an issue that already has a PR waiting for
 * review. Operator memory records "check for an open PR before a dev
 * dispatch" as a standing MANUAL workaround — this is the defect it exists
 * to compensate for.
 *
 * The fix (`_handle_dev_orch_needs_qa_promotion` in
 * `scripts/autopilot/reap.py`, using `pr-refs.py`'s new `closing_issues()`
 * predicate):
 *   - only applies to `dev_orch` completions carrying a resolved anchor;
 *   - promotes on a CLOSING PR-body reference ONLY (Closes/Fixes/Resolves,
 *     any tense) — deliberately narrower than `_handle_dev_orch_stall`'s
 *     PR-existence check, which also counts a bare branch-name match or a
 *     non-closing `Refs #N` as "found" (enough to say the dispatch didn't
 *     stall, not enough to say the work is done and reviewable);
 *   - re-reads the issue's current labels immediately before editing, and
 *     only relabels when it is STILL `ready-for-agent` — so a repeated reap
 *     on the same anchor (or an issue another actor already advanced) is a
 *     safe, idempotent no-op;
 *   - fails OPEN (no mutation at all) on any `gh` hiccup, an unclosed PR, or
 *     no anchor — this suite pins the positive case plus every no-op case
 *     the issue's acceptance criteria calls out by name: no anchor, no PR,
 *     a PR that references but does not close, and an issue already
 *     `needs-qa`.
 *
 * INV-5 (PR #4090 design-concept reconciliation, closed in this revision):
 * `run_completion` fetches `gh pr list --json
 * headRefName,body,closingIssuesReferences --limit 200` ONCE per qualifying
 * dev_orch completion and shares the parsed JSON with BOTH this check and
 * the sibling #3866 stall check (`_handle_dev_orch_stall`) — no more
 * doubling the `gh` call volume. A single fetch failure now fails BOTH
 * checks open. See the "SHARED FETCH" and the PROMOTE test's trailing
 * assertion below for the regression coverage.
 *
 * A stub `gh` binary (HYDRA_AUTOPILOT_GH_CLI override, mirroring
 * test/autopilot-dev-resume-stall.test.mts's injection pattern) replaces the
 * real CLI so these tests run hermetically — no network, no real repo.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAP = join(REPO_ROOT, "scripts", "autopilot", "reap.py");

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
 *   - answers `issue view ...` with $STUB_ISSUE_VIEW_JSON on stdout, exit
 *     $STUB_ISSUE_VIEW_EXIT (default 0)
 *   - answers `issue edit ...` with exit $STUB_ISSUE_EDIT_EXIT (default 0)
 */
function makeTmp(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-reap-needs-qa-"));
  const ghStub = join(dir, "gh-stub.sh");
  const ghCallsLog = join(dir, "gh-calls.log");
  writeFileSync(
    ghStub,
    `#!/usr/bin/env bash
set -u
echo "$*" >> "${ghCallsLog}"
# Default is assigned to a plain variable first (rather than inlined into a
# \${VAR:-default} expansion) — a literal-brace JSON default word inside the
# expansion itself confuses bash's brace-matching for the substitution and
# leaks trailing characters onto stdout.
default_view_json='{"labels":[{"name":"ready-for-agent"}]}'
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
    printf '%s' "\${STUB_ISSUE_VIEW_JSON:-\$default_view_json}"
    exit 0
    ;;
  "issue edit")
    exit "\${STUB_ISSUE_EDIT_EXIT:-0}"
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
      HYDRA_AUTOPILOT_REPO: "hydra-test/nonexistent-fixture",
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

function baseSlotState(taskId: string, anchor?: string): Record<string, unknown> {
  return {
    slots: {
      dev_orch: {
        skill: "hydra-dev",
        started_epoch: Math.floor(Date.now() / 1000) - 600,
        task_id: taskId,
        ...(anchor ? { anchor } : {}),
      },
    },
  };
}

describe("reap.py completion → dev_orch ready-for-agent → needs-qa promotion (issue #4045)", () => {
  test("PROMOTE: an open PR CLOSES the anchor and the issue is still ready-for-agent → relabel to needs-qa", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t1", "issue-4001"));

      const prJson = JSON.stringify([
        { headRefName: "issue-4001-fix", body: "Implements the fix.\n\nCloses #4001" },
      ]);
      const r = runCompletion(["dev_orch", "t1", "50000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
        STUB_ISSUE_VIEW_JSON: JSON.stringify({ labels: [{ name: "ready-for-agent" }] }),
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const log = runLog(tmp);
      assert.match(
        log,
        /dev_pr_closes_anchor anchor=issue-4001 relabelled=True/,
        "a confirmed closing PR against a ready-for-agent issue must log the promotion",
      );

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("issue view 4001")),
        `must re-check current labels before relabelling: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        calls.some(
          (c) =>
            c.startsWith("issue edit 4001") &&
            c.includes("--remove-label ready-for-agent") &&
            c.includes("--add-label needs-qa"),
        ),
        `must relabel issue #4001 ready-for-agent -> needs-qa: ${JSON.stringify(calls)}`,
      );

      // Issue #4045 INV-5 (PR #4090 design-concept reconciliation): this
      // completion qualifies for BOTH the sibling #3866 stall check
      // (_handle_dev_orch_stall, which finds the PR and no-ops) AND this
      // needs-qa promotion — exactly the case that used to fire TWO
      // independent `gh pr list` subprocesses. Assert exactly one.
      const prListCalls = calls.filter((c) => c.startsWith("pr list"));
      assert.equal(
        prListCalls.length,
        1,
        `the #3866 stall check and the #4045 promotion check must share ONE ` +
          `gh pr list call, not one each: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("SHARED FETCH: exactly one gh pr list subprocess serves both the #3866 stall check and the #4045 promotion check, even when neither fires (issue #4045 INV-5)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t10", "issue-4010"));

      // A PR that neither closes (no closing verb) nor is fully absent — a
      // bare branch-name match. This trips the #3866 stall check's "found"
      // path (no-op) and the #4045 promotion check's "not closing" path
      // (no-op) — both handlers still run, both still consult the SAME
      // fetched payload, so the assertion below would catch a regression to
      // the old two-independent-calls shape even when neither mutates.
      const prJson = JSON.stringify([{ headRefName: "issue-4010-fix", body: "" }]);
      const r = runCompletion(["dev_orch", "t10", "35000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0, `reap must exit 0, got ${r.status}; stderr=${r.stderr}`);

      const calls = ghCalls(tmp);
      const prListCalls = calls.filter((c) => c.startsWith("pr list"));
      assert.equal(
        prListCalls.length,
        1,
        `exactly one gh pr list subprocess must serve both checks per ` +
          `qualifying dev_orch completion: ${JSON.stringify(calls)}`,
      );
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "neither check should relabel in this scenario");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO-OP: an open PR only REFERENCES the anchor (Refs #N, non-closing) → no relabel", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t2", "issue-4002"));

      const prJson = JSON.stringify([
        { headRefName: "some-other-branch", body: "Related work. Refs #4002" },
      ]);
      const r = runCompletion(["dev_orch", "t2", "40000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_pr_closes_anchor"), "a non-closing Refs must never promote");

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue view")),
        `a non-closing reference must never even check current labels: ${JSON.stringify(calls)}`,
      );
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "a non-closing reference must never relabel");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO-OP: an open PR matches only by branch name (no closing keyword in body) → no relabel", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t3", "issue-4003"));

      const prJson = JSON.stringify([{ headRefName: "issue-4003-fix", body: "" }]);
      const r = runCompletion(["dev_orch", "t3", "40000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
      });
      assert.equal(r.status, 0);

      const calls = ghCalls(tmp);
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `a branch-name-only match must never promote to needs-qa: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO-OP: no open PR at all → no needs-qa promotion (the sibling #3866 stall-relabel is a separate concern)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t4", "issue-4004"));

      // No PR at all also trips the SIBLING #3866 stall check
      // (_handle_dev_orch_stall), which legitimately relabels the issue to
      // `needs-dev-resume` — that behavior is pinned by
      // test/autopilot-dev-resume-stall.test.mts and is out of scope here.
      // This test only pins that the #4045 needs-qa PROMOTION path never
      // fires without a PR to promote on.
      const r = runCompletion(["dev_orch", "t4", "30000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_pr_closes_anchor"), "no PR means no needs-qa promotion");

      const calls = ghCalls(tmp);
      // Scoped to the LABELS read specifically, not every `issue view`: issue
      // #4057 deliberately added a `--json state` read on this same no-PR path
      // (the sibling #3866 stall check disambiguating a real stall from an
      // anchor the dispatch correctly closed itself). A bare
      // `startsWith("issue view")` here would pin the pre-#4057 behaviour that
      // #4057 exists to change, which is out of scope for this test — it only
      // pins that the #4045 needs-qa PROMOTION path never fires without a PR.
      assert.ok(
        !calls.some((c) => c.startsWith("issue view") && c.includes("--json labels")),
        `no PR means no reason to check labels: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit") && c.includes("--add-label needs-qa")),
        "no PR means no needs-qa relabel",
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO-OP: the closing PR exists but the issue is already needs-qa → no relabel (idempotent)", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t5", "issue-4005"));

      const prJson = JSON.stringify([{ headRefName: "issue-4005-fix", body: "Fixes #4005" }]);
      const r = runCompletion(["dev_orch", "t5", "45000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
        STUB_ISSUE_VIEW_JSON: JSON.stringify({ labels: [{ name: "needs-qa" }] }),
      });
      assert.equal(r.status, 0);

      const log = runLog(tmp);
      assert.ok(!log.includes("dev_pr_closes_anchor"), "an already-needs-qa issue must never re-log a promotion");

      const calls = ghCalls(tmp);
      assert.ok(
        calls.some((c) => c.startsWith("issue view 4005")),
        `must still check current labels: ${JSON.stringify(calls)}`,
      );
      assert.ok(
        !calls.some((c) => c.startsWith("issue edit")),
        `an issue no longer on ready-for-agent must never be relabelled: ${JSON.stringify(calls)}`,
      );
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN: gh pr list fails → fail OPEN, no relabel", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t6", "issue-4006"));

      const r = runCompletion(["dev_orch", "t6", "20000", "hydra-dev"], tmp, {
        STUB_PR_LIST_EXIT: "1", // simulate gh auth/network failure
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "must NOT relabel when gh pr list failed");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("UNKNOWN: gh issue view fails after a closing PR is found → fail OPEN, no relabel", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t7", "issue-4007"));

      const prJson = JSON.stringify([{ headRefName: "issue-4007-fix", body: "Resolves #4007" }]);
      const r = runCompletion(["dev_orch", "t7", "20000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: prJson,
        STUB_ISSUE_VIEW_EXIT: "1", // simulate gh auth/network failure on the label re-check
      });
      assert.equal(r.status, 0, "an unreachable gh must never fail the reap");

      const calls = ghCalls(tmp);
      assert.ok(!calls.some((c) => c.startsWith("issue edit")), "must NOT relabel when the label re-check failed");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NO ANCHOR: a dev_orch completion with no resolvable anchor never calls gh at all for promotion", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, baseSlotState("t8"));

      const r = runCompletion(["dev_orch", "t8", "10000", "hydra-dev"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "no anchor means no gh call at all (stall check + promotion both skip)");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("NON-dev_orch class: a qa_orch completion never triggers the promotion check", () => {
    const tmp = makeTmp();
    try {
      writeState(tmp.state, {});

      const r = runCompletion(["qa_orch", "t9", "20000", "hydra-qa"], tmp, {
        STUB_PR_LIST_JSON: "[]",
      });
      assert.equal(r.status, 0);
      assert.deepEqual(ghCalls(tmp), [], "only dev_orch completions run the needs-qa promotion check");
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});
