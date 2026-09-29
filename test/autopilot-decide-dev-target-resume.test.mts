/**
 * Regression tests for issue #4739 — the Target dev-resume path.
 *
 * A Target issue whose PR got a QA FAIL plus an operator "fix forward on
 * PR #N, push to its existing branch" decision carries `needs-dev-resume`
 * (written ONLY by /hydra-review's per-Target fix-forward resolution). The
 * #4474 in-flight exclusion subtracts every `ready-for-agent` issue
 * referenced by an open Target PR from `target_ready_for_agent`, and the
 * resume issue deliberately does NOT carry that label — so the board signal
 * never fires for it and `dev_target` never dispatches (observed: 11 held
 * CSB PRs with fix-forward decisions, zero pushes since). The fix is a
 * durable, label-derived pin in the same shape as #4518's
 * `orch_dev_resume_pick`:
 *
 *   collect-state.sh → `target_dev_resume_pick=issue-<N>:<pr>:<head.ref>`
 *                     (or `=none`, fail closed on any degraded read)
 *   decide.py        → `_select_slot_dev_target` checks the pick FIRST,
 *                      before and independent of the board signals, and
 *                      dispatches hydra-target-build with resume:true +
 *                      resume_issue / resume_pr / resume_branch.
 *
 * Both halves are pinned here, mirroring the two-harness discipline of
 * test/autopilot-decide.test.mts (decide.py through its `decide` CLI so the
 * JSON wire contract is what's pinned) and test/collect-state-inflight-
 * exclusion.test.mts (collect-state.sh is NEVER executed — the python
 * heredoc block is extracted textually from the committed script and run
 * directly, so the tests exercise the committed logic, not a
 * re-implementation, without a live gh / Target repo).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const PR_REFS = join(REPO_ROOT, "scripts", "autopilot", "pr-refs.py");

// ---------------------------------------------------------------------------
// decide.py harness (the test/autopilot-decide.test.mts shape)
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dev-target-resume-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

/**
 * The minimal autopilot state fixture — same shape as
 * test/autopilot-decide.test.mts's baseState(): all slots free, `scope: all`
 * (dev_target dispatches on either board lane), no burned classes, no
 * cooldowns, and the #4411 fail-closed risk-surface gate satisfied by a
 * resolved surface. The class-level pre-selector guards (#1059 cost cap,
 * #4475 WIP saturation) read absent state here and stay inert, so what each
 * case below pins is the SELECTOR's own precedence, per INV-5's scoping.
 */
function baseState(overrides: Record<string, unknown> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      context_compaction_turns: 0,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
    },
    signals: (overrides.signals as Record<string, unknown>) ?? {},
    research_force_counter: {},
    target_risk_surface: {
      ok: true,
      appSubdir: "web",
      surface: ["src/lib/execution/", "src/bin/"],
      surfaceRepoRelative: ["web/src/lib/execution/", "web/src/bin/"],
    },
    ...overrides,
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
      encoding: "utf-8",
      env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function devTargetDispatches(plan: any): any[] {
  return (plan.actions ?? []).filter(
    (a: any) => a.type === "dispatch" && a.slot === "dev_target",
  );
}

// ---------------------------------------------------------------------------
// collect-state.sh harness (the extract-and-run discipline — the script is
// never executed; the committed python block runs verbatim)
// ---------------------------------------------------------------------------

/**
 * Pull a `python3 -c "<code>"` block out of collect-state.sh by its bash
 * assignment LHS. `withStderrGuard` selects the terminator variant: the
 * #4474 subtraction block pipes stderr to /dev/null, the #4739 resume block
 * keeps its fail-closed stderr notes visible on purpose (they are the
 * operator-visible degrade signal). Returns the literal python source.
 */
function extractPythonBlock(lhs: string, withStderrGuard: boolean): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const tail = withStderrGuard
    ? `" 2>/dev/null \\|\\| true\\)`
    : `" \\|\\| true\\)`;
  const re = new RegExp(
    `${lhs}=[\\s\\S]*?python3 -c "\\$\\(cat <<'PY'([\\s\\S]*?)\\nPY\\n\\)${tail}`,
  );
  const m = src.match(re);
  assert.ok(m, `could not locate the ${lhs} python3 block in collect-state.sh`);
  return m[1];
}

interface TargetPr {
  number: number;
  draft?: boolean;
  headRef: string;
  body: string | null;
}

interface TargetIssue {
  number: number;
  /** Present ⇒ the REST issues payload's PR-shaped entry (filtered out). */
  isPr?: boolean;
}

/**
 * Run the extracted #4733 resume-pick block exactly the way collect-state.sh
 * invokes it: `{issues, prs}` two-document payload on STDIN (never argv/env —
 * PR bodies can exceed the exec limit), pr-refs.py path + the fail-closed OK
 * flag through the environment.
 */
function runResumePick(
  issues: TargetIssue[],
  prs: TargetPr[],
  opts: { ok?: string } = {},
): { stdout: string; stderr: string } {
  const code = extractPythonBlock("TARGET_DEV_RESUME_PICK", false);
  const stdin = JSON.stringify({
    issues: issues.map((i) => ({
      number: i.number,
      ...(i.isPr ? { pull_request: { url: `https://example/issue/${i.number}` } } : {}),
    })),
    prs: prs.map((p) => ({
      number: p.number,
      draft: p.draft ?? false,
      head: { ref: p.headRef },
      body: p.body,
      html_url: `https://example/pull/${p.number}`,
    })),
  });
  const r = spawnSync("python3", ["-c", code], {
    input: stdin,
    encoding: "utf-8",
    env: {
      ...process.env,
      TARGET_PR_REFS_PY: PR_REFS,
      TARGET_DEV_RESUME_OK: opts.ok ?? "1",
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// decide.py — the resume pin in _select_slot_dev_target
// ---------------------------------------------------------------------------

describe("decide.py — Target dev resume pick (issue #4739)", () => {
  const RESUME_PICK = "issue-176:57:feature/resume-176";

  test("a resume pick produces a dev_target dispatch with resume:true and the correct resume_branch", () => {
    const plan = runDecide(baseState({ signals: { target_dev_resume_pick: RESUME_PICK } }), null);
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1, `expected exactly one pinned dispatch: ${JSON.stringify(d)}`);
    assert.equal(d[0].skill, "hydra-target-build");
    assert.deepEqual(d[0].prompt_args, {
      anchor: "issue-176",
      resume: true,
      resume_issue: 176,
      resume_pr: 57,
      resume_branch: "feature/resume-176",
    });
    assert.match(d[0].reason, /#4739/);
  });

  test("resume pick wins ahead of ordinary board work", () => {
    // BOTH lanes armed (legacy Redis + GitHub board) AND a pick present: the
    // pinned resume must be the dispatch, not the board pick (which carries
    // no resume key at all).
    const plan = runDecide(
      baseState({
        signals: {
          target_work_available: true,
          target_board_work_available: true,
          target_dev_resume_pick: RESUME_PICK,
        },
      }),
      null,
    );
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1);
    assert.equal(d[0].prompt_args.resume, true, "the resume pin outranks the board pick");
    assert.equal(d[0].prompt_args.anchor, "issue-176");
    assert.equal(d[0].prompt_args.resume_branch, "feature/resume-176");
  });

  test("the pin fires with BOTH board signals absent — the resume issue carries needs-dev-resume, not ready-for-agent (#4739 premise)", () => {
    const plan = runDecide(baseState({ signals: { target_dev_resume_pick: RESUME_PICK } }), null);
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1);
    assert.equal(d[0].prompt_args.resume, true);
  });

  test("`none` / absent / malformed pick spellings fall through to the ordinary board path", () => {
    for (const bad of ["none", "", "issue-176:57", "176:57:feature/x", "issue-x:57:feature/x", "issue-0:57:feature/x", "issue-176:0:feature/x", "issue-176:57:"]) {
      const plan = runDecide(
        baseState({
          signals: {
            target_board_work_available: true,
            target_dev_resume_pick: bad,
          },
        }),
        null,
      );
      const d = devTargetDispatches(plan);
      assert.equal(d.length, 1, `signal "${bad}" must fall through to the board path, not suppress it`);
      assert.equal(d[0].prompt_args.resume, undefined, `signal "${bad}" must never pin a resume`);
      assert.equal(d[0].prompt_args.anchor, undefined, "the ordinary board path carries no anchor from the pick");
    }
    // Absent entirely + no board signal ⇒ no dispatch at all.
    assert.equal(devTargetDispatches(runDecide(baseState(), null)).length, 0);
  });

  test("signal EVENTS take precedence over state.signals for the resume pick", () => {
    const plan = runDecide(
      baseState({ signals: { target_dev_resume_pick: "none" } }),
      null,
      [{ type: "signal", name: "target_dev_resume_pick", value: RESUME_PICK }],
    );
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1, "the event-borne signal wins");
    assert.equal(d[0].prompt_args.resume_pr, 57);
  });

  test("a busy dev_target slot means no resume pin (the pick rides the normal slot-free pipeline)", () => {
    const state = baseState({ signals: { target_dev_resume_pick: RESUME_PICK } });
    state.slots.dev_target = { task_id: "abc", status: "running" };
    assert.equal(devTargetDispatches(runDecide(state, null)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh — the target_dev_resume_pick emission (extracted block)
// ---------------------------------------------------------------------------

describe("collect-state target_dev_resume_pick (issue #4739)", () => {
  const PR_57: TargetPr = { number: 57, headRef: "feature/resume-176", body: "Closes #176" };

  test("needs-dev-resume issue + referencing open PR yields the pick (lowest issue number wins)", () => {
    // Two labelled issues, each with exactly one qualifying closing PR: the
    // pick must be the LOWER issue number (#176), even though PR #901 (the
    // newer issue's PR) is higher and the REST payload order puts #4452
    // first — the #4739 pick is oldest-issue-first, not payload-order-first.
    const r = runResumePick(
      [{ number: 4452 }, { number: 176 }],
      [
        { number: 901, headRef: "feature/resume-4452", body: "Closes #4452" },
        PR_57,
      ],
    );
    assert.equal(r.stdout.trim(), "issue-176:57:feature/resume-176");
  });

  test("needs-dev-resume issue with no PR yields none", () => {
    const r = runResumePick([{ number: 176 }], []);
    assert.equal(r.stdout.trim(), "none");
  });

  test("a PR that REFERENCES but does not CLOSE the issue never qualifies", () => {
    // closing_issues(), not referenced_issues() — Target build branches are
    // feature/<cycle-id>, so the branch half can never match; a bare
    // `Refs #N` must not spend a dispatch either (INV-2, same rationale as
    // #4195 INV-4).
    const r = runResumePick(
      [{ number: 176 }],
      [{ number: 57, headRef: "feature/resume-176", body: "Refs #176" }],
    );
    assert.equal(r.stdout.trim(), "none");
  });

  test("a PR closing TWO issues never qualifies (the pin must be unambiguous)", () => {
    const r = runResumePick(
      [{ number: 176 }, { number: 177 }],
      [{ number: 57, headRef: "feature/resume-176", body: "Closes #176\n\nCloses #177" }],
    );
    assert.equal(r.stdout.trim(), "none");
  });

  test("empty or unreadable payload yields none", () => {
    // Healthy empty lane (`[]`) — distinguishable from a failed read.
    assert.equal(runResumePick([], []).stdout.trim(), "none");
    // Failed-read flag (empty REST payload on either side): fail CLOSED to
    // none with the stderr note naming #4739.
    const degraded = runResumePick([{ number: 176 }], [PR_57], { ok: "0" });
    assert.equal(degraded.stdout.trim(), "none");
    assert.match(degraded.stderr, /#4739/);
    // Unparseable stdin payload (jq failure upstream): fail CLOSED to none.
    const code = extractPythonBlock("TARGET_DEV_RESUME_PICK", false);
    const garbage = spawnSync("python3", ["-c", code], {
      input: "not json{",
      encoding: "utf-8",
      env: { ...process.env, TARGET_PR_REFS_PY: PR_REFS, TARGET_DEV_RESUME_OK: "1" },
    });
    assert.equal((garbage.stdout ?? "").trim(), "none");
    assert.match(garbage.stderr ?? "", /#4739/);
    // A missing pr-refs.py (import failure): fail CLOSED to none.
    const noRefs = spawnSync("python3", ["-c", code], {
      input: JSON.stringify({ issues: [{ number: 176 }], prs: [PR_57] }),
      encoding: "utf-8",
      env: { ...process.env, TARGET_PR_REFS_PY: "/nonexistent/pr-refs.py", TARGET_DEV_RESUME_OK: "1" },
    });
    assert.equal((noRefs.stdout ?? "").trim(), "none");
    assert.match(noRefs.stderr ?? "", /#4739/);
  });

  test("draft PR yields none", () => {
    const r = runResumePick(
      [{ number: 176 }],
      [{ number: 57, headRef: "feature/resume-176", body: "Closes #176", draft: true }],
    );
    assert.equal(r.stdout.trim(), "none");
  });

  test("two PRs closing one issue yield none (ambiguous pin)", () => {
    const r = runResumePick(
      [{ number: 176 }],
      [
        { number: 57, headRef: "feature/resume-176", body: "Closes #176" },
        { number: 58, headRef: "feature/other-176", body: "Closes #176" },
      ],
    );
    assert.equal(r.stdout.trim(), "none");
  });

  test("PR-shaped entries in the issues payload are filtered out (.pull_request)", () => {
    const r = runResumePick(
      [{ number: 176, isPr: true }],
      [PR_57],
    );
    assert.equal(r.stdout.trim(), "none");
  });

  test("a head.ref containing ':' never qualifies (wire-shape poison)", () => {
    // The wire shape is issue-<N>:<pr>:<head.ref>; a ':' inside the branch
    // would corrupt the parse downstream — reject at the source.
    const r = runResumePick(
      [{ number: 176 }],
      [{ number: 57, headRef: "we:ird", body: "Closes #176" }],
    );
    assert.equal(r.stdout.trim(), "none");
  });

  test("the emission is exactly one key=value line with a none fallback", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /echo "target_dev_resume_pick=\$\{TARGET_DEV_RESUME_PICK:-none\}"/,
      "INV-1: exactly one line, `none` fallback even if the python block crashes",
    );
  });

  test("the resume block never flips TARGET_LANE_DEGRADED (INV-4)", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    const start = src.indexOf("Issue #4739 — Target dev resume pick");
    const end = src.indexOf('echo "target_dev_resume_pick=');
    assert.ok(start > 0 && end > start, "the #4739 block must be locatable");
    const block = src.slice(start, end);
    // Prose may NAME the flag (the comment above the block explains why it
    // must not flip it); what is forbidden is a WRITE — the script's only
    // writer form is `TARGET_LANE_DEGRADED=1`.
    assert.doesNotMatch(
      block,
      /TARGET_LANE_DEGRADED\s*=/,
      "the board reads above own that flag; a resume-read failure must never write it",
    );
    // And the block reuses the single #4474 PR payload rather than a second
    // pulls read (INV-3).
    assert.ok(block.includes("TARGET_PRS_RAW_JSON"), "the PR side must reuse the #4474 payload");
  });

  test("needs-dev-resume issues are not subtracted into the in-flight exclusion", () => {
    // INV-6: the #4474 subtraction subtracts (R ∩ P) where R is the
    // ready-for-agent-labelled issue set. A needs-dev-resume issue held by
    // an open PR (P contains it) must NOT enter R, so the count stays whole.
    // Run the committed #4474 block: R = [42] (a plain ready-for-agent
    // issue), P (TARGET_INFLIGHT_ISSUES) = "12" (the held resume issue).
    const code = extractPythonBlock("TARGET_READY_FOR_AGENT_ADJUSTED", true);
    const r = spawnSync("python3", ["-c", code], {
      input: JSON.stringify([42]),
      encoding: "utf-8",
      env: {
        ...process.env,
        TARGET_INFLIGHT_ISSUES: "12",
        TARGET_GLM_WITHHELD: "",
        TARGET_BASE_READY_FOR_AGENT: "1",
      },
    });
    assert.equal(r.status, 0, `#4474 block exited non-zero: ${r.stderr}`);
    assert.equal(
      (r.stdout ?? "").trim(),
      "1",
      "a needs-dev-resume issue in P but not in R subtracts nothing",
    );
  });
});
