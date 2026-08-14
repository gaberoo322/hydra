/**
 * Regression tests for the hydra-branch-prune skill's classifier — pass 3,
 * dead-branch GC (issue #1784), plus the driver-ordering guard (issue #2115).
 *
 * Pass 1 (test/hydra-branch-prune.test.mts) only fires on [gone] upstreams;
 * pass 2 (worktree-orphan GC) is keyed on the worktree. A branch from a dead
 * dispatch that NEVER opened a PR has no upstream at all, and once its
 * worktree is reaped neither pass can ever reclaim it — run f00da325 found
 * two stale issue-1676 branches a later dispatch had to liveness-check by
 * hand (cue dead-prior-dispatch-branches-no-pr, cross-run recurrence 4).
 * These tests guard the third pass that closes the gap, plus a text-level
 * guard on scripts/branch-prune.sh's destructive-op ordering (the classifier
 * is pure shell-glue that can't be unit-tested through it directly).
 *
 * Split out of the former single hydra-branch-prune.test.mts into five
 * siblings by classifier pass (issue #4062) to shrink the per-file
 * top-level-entry count that drives the `--test-force-exit` suite-count-drop
 * race — see test/_helpers/branch-prune-fixtures.mts's header for the
 * measured evidence. This file (pass 3 + driver-ordering guard) is sibling 3
 * of 5.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isDispatchBranchName,
  classifyDeadBranch,
  classifyDeadBranches,
  renderDeadBranchReport,
  HARD_CAP_DELETIONS_PER_RUN,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type BranchRow,
} from "../scripts/ci/branch-prune.ts";
import {
  branch,
  localBranch,
  wt,
  deadCtx,
  NEVER_LIVE,
  ALWAYS_LIVE,
  OLD,
  YOUNG,
} from "./_helpers/branch-prune-fixtures.mts";

describe("isDispatchBranchName — name-pattern rail (issue #1784)", () => {
  test("matches dispatch-generated branch shapes", () => {
    assert.equal(isDispatchBranchName("issue-1676-dev"), true);
    assert.equal(isDispatchBranchName("issue-1676-per-run-redis-db"), true);
    assert.equal(isDispatchBranchName("issue-1667-cue-fuzzy-dedup-r1718000000"), true);
    assert.equal(isDispatchBranchName("worktree-agent-acaf7dba565448c37"), true);
    assert.equal(isDispatchBranchName("agent-qa-123"), true);
    assert.equal(isDispatchBranchName("pr-1515-qa"), true);
  });

  test("rejects operator-shaped branch names", () => {
    assert.equal(isDispatchBranchName("master"), false);
    assert.equal(isDispatchBranchName("scratch"), false);
    assert.equal(isDispatchBranchName("feat/manual-experiment"), false);
    assert.equal(isDispatchBranchName("my-issue-123"), false); // prefix-anchored
  });
});

describe("classifyDeadBranch — never-touch rails", () => {
  test("branch WITH an upstream (healthy) → skip-has-upstream (pass 1's domain)", () => {
    const r = classifyDeadBranch(branch("issue-5-pushed", { gone: false, upstream: true }), deadCtx());
    assert.equal(r.action, "skip-has-upstream");
  });

  test("branch WITH a [gone] upstream → skip-has-upstream (pass 1 deletes it)", () => {
    const r = classifyDeadBranch(branch("issue-6-merged", { gone: true, upstream: true }), deadCtx());
    assert.equal(r.action, "skip-has-upstream");
  });

  test("current branch → skip-current-branch", () => {
    const r = classifyDeadBranch(localBranch("issue-7-cur", { current: true }), deadCtx());
    assert.equal(r.action, "skip-current-branch");
    assert.match(r.reason, /current branch/);
  });

  test("non-dispatch name → skip-not-dispatch-branch (never auto-delete operator branches)", () => {
    const r = classifyDeadBranch(
      { name: "scratch-experiment", upstreamGone: false, isCurrent: false, hasUpstream: false, ageSeconds: OLD },
      deadCtx(),
    );
    assert.equal(r.action, "skip-not-dispatch-branch");
    assert.match(r.reason, /operator branches/);
  });

  test("AC (b): no upstream + checked out in a live-PID worktree → skip-live-agent", () => {
    const w = wt("/wt/live-dispatch", "issue-8-live", 4242, { ageSeconds: OLD });
    const r = classifyDeadBranch(
      localBranch("issue-8-live"),
      deadCtx({ worktrees: [w], isLivePid: ALWAYS_LIVE }),
    );
    assert.equal(r.action, "skip-live-agent");
    assert.match(r.reason, /live PID 4242/);
  });

  test("AC (c): no upstream but head of an OPEN PR (pushed without -u) → skip-open-pr-head", () => {
    const r = classifyDeadBranch(
      localBranch("issue-9-pr-head"),
      deadCtx({ openPrHeads: new Set(["issue-9-pr-head"]) }),
    );
    assert.equal(r.action, "skip-open-pr-head");
    assert.match(r.reason, /open PR/);
  });

  test("no upstream + attached worktree with DEAD pid → skip-attached-worktree (orphan GC owns it)", () => {
    const w = wt("/wt/dead-but-attached", "issue-10-attached", 99999, { ageSeconds: OLD });
    const r = classifyDeadBranch(
      localBranch("issue-10-attached"),
      deadCtx({ worktrees: [w], isLivePid: NEVER_LIVE }),
    );
    assert.equal(r.action, "skip-attached-worktree");
    assert.match(r.reason, /worktree-orphan GC/);
  });

  test("AC (d): no upstream + younger than the age floor → skip-too-young", () => {
    const r = classifyDeadBranch(localBranch("issue-11-fresh", { ageSeconds: YOUNG }), deadCtx());
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /in-flight dispatch/);
  });

  test("no upstream + UNKNOWN age (null) → skip-too-young (conservative)", () => {
    const r = classifyDeadBranch(localBranch("issue-12-noage", { ageSeconds: null }), deadCtx());
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /unknown age/);
  });

  test("hard cap → skip-cap", () => {
    const r = classifyDeadBranch(
      localBranch("issue-13-capped"),
      deadCtx({ deletionCount: () => HARD_CAP_DELETIONS_PER_RUN }),
    );
    assert.equal(r.action, "skip-cap");
    assert.match(r.reason, /hard cap/);
  });

  test("live-PID rail beats the age floor — fresh LIVE dispatch is skip-live-agent, not skip-too-young", () => {
    const w = wt("/wt/fresh-live", "issue-14-fresh-live", 7, { ageSeconds: YOUNG });
    const r = classifyDeadBranch(
      localBranch("issue-14-fresh-live", { ageSeconds: YOUNG }),
      deadCtx({ worktrees: [w], isLivePid: ALWAYS_LIVE }),
    );
    assert.equal(r.action, "skip-live-agent");
  });
});

describe("classifyDeadBranch — reclaim path (AC (a), the actual fix)", () => {
  test("no upstream, worktree already reaped, no open PR, past the age floor → delete-branch-no-upstream", () => {
    // The exact run-f00da325 shape: issue-1676-dev / issue-1676-per-run-redis-db
    // from prior dead dispatches — ~4h+ idle, no live processes, no PR, no
    // upstream, worktree long reaped.
    const r = classifyDeadBranch(localBranch("issue-1676-dev", { ageSeconds: OLD }), deadCtx());
    assert.equal(r.action, "delete-branch-no-upstream");
    assert.match(r.reason, /no upstream/);
    assert.match(r.reason, /no open PR/);
  });

  test("worktree-agent-* leftover is also reclaimed", () => {
    const r = classifyDeadBranch(localBranch("worktree-agent-deadbeef"), deadCtx());
    assert.equal(r.action, "delete-branch-no-upstream");
  });
});

describe("classifyDeadBranches — batch + cap accounting", () => {
  test("buckets delete vs skip, silently drops has-upstream rows, preserves order", () => {
    const liveWt = wt("/wt/live", "issue-22-live", 5, { ageSeconds: OLD });
    const rows: BranchRow[] = [
      branch("master", { gone: false, current: true }),       // has upstream → dropped silently
      branch("issue-20-merged", { gone: true }),               // has upstream → dropped silently
      localBranch("issue-21-dead"),                            // → delete
      localBranch("issue-22-live"),                            // live worktree → skip
      localBranch("issue-23-young", { ageSeconds: YOUNG }),    // → skip
      localBranch("scratch"),                                  // not dispatch-shaped → skip
    ];
    const buckets = classifyDeadBranches(rows, {
      currentBranch: "master",
      worktrees: [liveWt],
      isLivePid: (pid) => pid === 5,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteBranch.length, 1);
    assert.equal(buckets.deleteBranch[0].name, "issue-21-dead");
    // live + young + scratch → three skips; the two upstream-bearing rows are
    // NOT in the skip list (pass 1's report already covers them).
    assert.equal(buckets.skip.length, 3);
    assert.deepEqual(
      buckets.skip.map((s) => s.action),
      ["skip-live-agent", "skip-too-young", "skip-not-dispatch-branch"],
    );
    assert.equal(buckets.cappedOut, false);
  });

  test("priorDeletions seeds the shared hard cap — earlier passes already at cap → all skip-cap", () => {
    const rows = [localBranch("issue-30-a"), localBranch("issue-31-b")];
    const buckets = classifyDeadBranches(rows, {
      currentBranch: "master",
      worktrees: [],
      isLivePid: NEVER_LIVE,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
      priorDeletions: HARD_CAP_DELETIONS_PER_RUN,
    });
    assert.equal(buckets.deleteBranch.length, 0);
    assert.equal(buckets.cappedOut, true);
    assert.ok(buckets.skip.every((s) => s.action === "skip-cap"));
  });

  test("hard cap fires within the pass once its own deletions accumulate", () => {
    const rows: BranchRow[] = [];
    for (let i = 0; i < HARD_CAP_DELETIONS_PER_RUN + 4; i++) {
      rows.push(localBranch(`issue-${i}-dead`));
    }
    const buckets = classifyDeadBranches(rows, {
      currentBranch: "master",
      worktrees: [],
      isLivePid: NEVER_LIVE,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteBranch.length, HARD_CAP_DELETIONS_PER_RUN);
    assert.equal(buckets.cappedOut, true);
    assert.equal(buckets.skip.length, 4);
  });
});

describe("renderDeadBranchReport — deterministic output", () => {
  test("lists deleted + skipped branches", () => {
    const buckets = {
      deleteBranch: [localBranch("issue-40-dead"), localBranch("worktree-agent-old")],
      skip: [
        {
          row: localBranch("issue-41-young", { ageSeconds: YOUNG }),
          action: "skip-too-young" as const,
          reason: "issue-41-young has no upstream but is 60s old, under the floor — defer.",
        },
      ],
      cappedOut: false,
    };
    const out = renderDeadBranchReport(buckets, false);
    assert.match(out, /### Dead-branch GC \(issue #1784\)/);
    assert.match(out, /#### Deleted \(no-upstream dead-dispatch branches\)/);
    assert.match(out, /- issue-40-dead/);
    assert.match(out, /- worktree-agent-old/);
    assert.match(out, /#### Skipped — dead-branch GC/);
    assert.match(out, /- issue-41-young: .*under the floor/);
  });

  test("audit-only mode says 'Would delete'", () => {
    const buckets = { deleteBranch: [], skip: [], cappedOut: false };
    const out = renderDeadBranchReport(buckets, true);
    assert.match(out, /#### Would delete/);
    assert.doesNotMatch(out, /#### Deleted/);
  });

  test("notes the cap when cappedOut is true", () => {
    const buckets = { deleteBranch: [], skip: [], cappedOut: true };
    const out = renderDeadBranchReport(buckets, false);
    assert.match(out, /hard cap/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Driver-ordering guard (issue #2115)
//
// The classifier is pure shell-glue can't be unit-tested through it, so this
// guard reads scripts/branch-prune.sh as text and asserts the destructive-op
// ORDERING invariant the fix establishes: `git worktree prune` must run at the
// START of each repo pass — after `git fetch origin --prune`, before the first
// `git branch -D` — so a branch git still believes is bound to a vanished
// /dev/shm worktree has its metadata released before any delete attempt.
//
// Today's bug: the only `git worktree prune` ran LAST (end-of-pass), so the
// branch-delete passes hit `git branch -D ... used by worktree at /dev/shm/...`
// before the stale binding was ever pruned. The early prune fixes that.
// ───────────────────────────────────────────────────────────────────────────

describe("branch-prune.sh — prune-before-delete ordering (issue #2115)", () => {
  const driverPath = fileURLToPath(
    new URL("../scripts/branch-prune.sh", import.meta.url),
  );
  const driver = readFileSync(driverPath, "utf8");

  // Match only the executable git invocations, never the explanatory comments
  // (which legitimately mention `git branch -D` / `git worktree prune` in
  // prose). A real call line is indented code where `git ` is the command —
  // either at the start of the line (`git worktree prune ...`, `git fetch ...`)
  // or guarded by an `if ! ` test (`if ! git branch -D "$br" ...`). Comment
  // lines begin with `#`, so anchoring on `git ` after optional `if ! `
  // excludes prose.
  const codeLines = driver
    .split("\n")
    .map((l, i) => ({ i, text: l }))
    .filter(({ text }) => /^\s+(if\s+!\s+)?git\s/.test(text));

  const firstPruneIdx = codeLines.findIndex(({ text }) =>
    /git worktree prune\b/.test(text),
  );
  const firstFetchIdx = codeLines.findIndex(({ text }) =>
    /git fetch origin --prune\b/.test(text),
  );
  const firstBranchDeleteIdx = codeLines.findIndex(({ text }) =>
    /git branch -D\b/.test(text),
  );

  test("an early `git worktree prune` exists (not only the end-of-pass one)", () => {
    const pruneCount = codeLines.filter(({ text }) =>
      /git worktree prune\b/.test(text),
    ).length;
    // Original driver had exactly one (end-of-pass); the fix adds the early
    // one, so the executable count must be at least two.
    assert.ok(
      pruneCount >= 2,
      `expected ≥2 \`git worktree prune\` call lines (early + end-of-pass), found ${pruneCount}`,
    );
  });

  test("the first `git worktree prune` runs AFTER `git fetch origin --prune`", () => {
    assert.ok(firstFetchIdx >= 0, "no `git fetch origin --prune` call line found");
    assert.ok(firstPruneIdx >= 0, "no `git worktree prune` call line found");
    assert.ok(
      firstPruneIdx > firstFetchIdx,
      "the early `git worktree prune` must run after `git fetch origin --prune`",
    );
  });

  test("the first `git worktree prune` runs BEFORE the first `git branch -D`", () => {
    assert.ok(firstBranchDeleteIdx >= 0, "no `git branch -D` call line found");
    assert.ok(firstPruneIdx >= 0, "no `git worktree prune` call line found");
    assert.ok(
      firstPruneIdx < firstBranchDeleteIdx,
      "`git worktree prune` must release stale worktree metadata BEFORE any `git branch -D` runs (issue #2115)",
    );
  });

  test("the fix does NOT introduce a raw `rm -rf` of a /dev/shm worktree dir", () => {
    // HARD CONSTRAINT from the grill: stale-metadata reclamation goes through
    // `git worktree prune`, never directory deletion. Guard against a future
    // regression that reaches for `rm -rf /dev/shm/...`.
    assert.doesNotMatch(
      driver,
      /rm\s+-rf?[^\n]*\/dev\/shm/,
      "branch-prune.sh must never `rm -rf` a /dev/shm worktree dir — use `git worktree prune`",
    );
  });
});
