/**
 * Regression tests for the hydra-branch-prune skill's classifier — pass 2,
 * worktree-orphan GC (issue #911).
 *
 * The original [gone]-upstream classifier (test/hydra-branch-prune.test.mts)
 * only fires on [gone] upstreams. The 2026-06-02 snapshot showed 338
 * local-only branches / 119 reclaimable worktrees that NEVER become [gone]
 * (no upstream), so the branch pass skips them forever. These tests guard the
 * worktree-keyed GC that closes that gap, with the liveness/age/open-PR rails
 * the safety AC demands.
 *
 * Split out of the former single hydra-branch-prune.test.mts into five
 * siblings by classifier pass (issue #4062) to shrink the per-file
 * top-level-entry count that drives the `--test-force-exit` suite-count-drop
 * race — see test/_helpers/branch-prune-fixtures.mts's header for the
 * measured evidence. This file (pass 2) is sibling 2 of 5.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorktreeOrphan,
  classifyWorktreeOrphans,
  renderWorktreeOrphanReport,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  HARD_CAP_DELETIONS_PER_RUN,
  type WorktreeRow,
} from "../scripts/ci/branch-prune.ts";
import {
  owt,
  orphanCtx,
  MAIN_WT,
  NEVER_LIVE,
  ALWAYS_LIVE,
  OLD,
  YOUNG,
} from "./_helpers/branch-prune-fixtures.mts";

// ───────────────────────────────────────────────────────────────────────────
// Worktree-orphan GC (issue #911)
//
// The original classifier only fires on [gone] upstreams. The 2026-06-02
// snapshot showed 338 local-only branches / 119 reclaimable worktrees that
// NEVER become [gone] (no upstream), so the branch pass skips them forever.
// These tests guard the worktree-keyed GC that closes that gap, with the
// liveness/age/open-PR rails the safety AC demands.
// ───────────────────────────────────────────────────────────────────────────

describe("classifyWorktreeOrphan — never-touch rails (issue #911 safety AC)", () => {
  test("main working tree → skip-main-worktree", () => {
    const r = classifyWorktreeOrphan(owt(MAIN_WT, "master"), orphanCtx());
    assert.equal(r.action, "skip-main-worktree");
    assert.match(r.reason, /main working tree/);
  });

  test("worktree holding the current branch → skip-current-worktree", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/cur", "feature-x"),
      orphanCtx({ currentBranch: "feature-x" }),
    );
    assert.equal(r.action, "skip-current-worktree");
  });

  test("worktree held by a LIVE PID → skip-live-agent (even when old + local-only)", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/live", "feat-live", { pid: 12345, ageSeconds: OLD }),
      orphanCtx({ isLivePid: ALWAYS_LIVE }),
    );
    assert.equal(r.action, "skip-live-agent");
    assert.match(r.reason, /live PID 12345/);
  });

  test("worktree whose branch heads an open PR → skip-open-pr-head", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/pr", "issue-500-feat", { pid: 99999, ageSeconds: OLD }),
      orphanCtx({ openPrHeads: new Set(["issue-500-feat"]) }),
    );
    assert.equal(r.action, "skip-open-pr-head");
    assert.match(r.reason, /open PR/);
  });

  test("worktree younger than the age floor → skip-too-young", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/fresh", "feat-fresh", { pid: 99999, ageSeconds: YOUNG }),
      orphanCtx(),
    );
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /in-flight dispatch/);
  });

  test("worktree with UNKNOWN age (null) → skip-too-young (conservative)", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/unknown", "feat-unknown", { pid: null, ageSeconds: null }),
      orphanCtx(),
    );
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /unknown age/);
  });
});

describe("classifyWorktreeOrphan — reclaim path (the actual fix)", () => {
  test("local-only orphan: dead PID, no upstream, not an open-PR head, old → delete-orphan-worktree", () => {
    // This is the exact 119/123 case from the 2026-06-02 snapshot: a worktree
    // whose lock-file PID is dead and whose branch never had an upstream.
    const r = classifyWorktreeOrphan(
      owt("/home/gabe/hydra/.claude/worktrees/agent-dead", "worktree-agent-dead", {
        pid: 99999,
        ageSeconds: OLD,
      }),
      orphanCtx({ isLivePid: NEVER_LIVE }),
    );
    assert.equal(r.action, "delete-orphan-worktree");
    assert.match(r.reason, /dead PID 99999/);
    assert.match(r.reason, /delete branch worktree-agent-dead/);
  });

  test("orphan with NO lock file at all (no PID) → delete-orphan-worktree", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/nolock", "feat-nolock", { pid: null, ageSeconds: OLD }),
      orphanCtx(),
    );
    assert.equal(r.action, "delete-orphan-worktree");
    assert.match(r.reason, /no live agent/);
  });

  test("detached orphan worktree (branch null) → delete-orphan-worktree, no branch -D in reason", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/detached", null, { pid: 99999, ageSeconds: OLD }),
      orphanCtx(),
    );
    assert.equal(r.action, "delete-orphan-worktree");
    assert.match(r.reason, /detached/);
    assert.doesNotMatch(r.reason, /delete branch/);
  });

  test("live-PID rail beats the age floor — a fresh LIVE worktree is skip-live-agent, not deleted", () => {
    const r = classifyWorktreeOrphan(
      owt("/wt/fresh-live", "feat", { pid: 1, ageSeconds: YOUNG }),
      orphanCtx({ isLivePid: ALWAYS_LIVE }),
    );
    assert.equal(r.action, "skip-live-agent");
  });
});

describe("classifyWorktreeOrphans — batch + cap accounting", () => {
  test("buckets reclaim vs skip, preserves input order", () => {
    const rows: WorktreeRow[] = [
      owt(MAIN_WT, "master"),
      owt("/wt/orphan-1", "feat-1", { pid: 99999, ageSeconds: OLD }),
      owt("/wt/live", "feat-live", { pid: 5, ageSeconds: OLD }),
      owt("/wt/young", "feat-young", { ageSeconds: YOUNG }),
      owt("/wt/orphan-2", null, { ageSeconds: OLD }),
    ];
    const buckets = classifyWorktreeOrphans(rows, {
      mainWorktreePath: MAIN_WT,
      currentBranch: "master",
      isLivePid: (pid) => pid === 5,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteOrphan.length, 2);
    assert.equal(buckets.deleteOrphan[0].worktree.path, "/wt/orphan-1");
    assert.equal(buckets.deleteOrphan[0].branch, "feat-1");
    assert.equal(buckets.deleteOrphan[1].worktree.path, "/wt/orphan-2");
    assert.equal(buckets.deleteOrphan[1].branch, null); // detached
    // main + live + young → three skips
    assert.equal(buckets.skip.length, 3);
    assert.equal(buckets.cappedOut, false);
  });

  test("priorDeletions seeds the shared hard cap — branch pass already at cap → all skip-cap", () => {
    const rows: WorktreeRow[] = [
      owt("/wt/a", "a", { ageSeconds: OLD }),
      owt("/wt/b", "b", { ageSeconds: OLD }),
    ];
    const buckets = classifyWorktreeOrphans(rows, {
      mainWorktreePath: MAIN_WT,
      currentBranch: "master",
      isLivePid: NEVER_LIVE,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
      priorDeletions: HARD_CAP_DELETIONS_PER_RUN, // branch pass already maxed
    });
    assert.equal(buckets.deleteOrphan.length, 0);
    assert.equal(buckets.cappedOut, true);
    assert.ok(buckets.skip.every((s) => s.action === "skip-cap"));
  });

  test("hard cap fires within the worktree pass once its own deletions accumulate", () => {
    const rows: WorktreeRow[] = [];
    for (let i = 0; i < HARD_CAP_DELETIONS_PER_RUN + 3; i++) {
      rows.push(owt(`/wt/o-${i}`, `o-${i}`, { ageSeconds: OLD }));
    }
    const buckets = classifyWorktreeOrphans(rows, {
      mainWorktreePath: MAIN_WT,
      currentBranch: "master",
      isLivePid: NEVER_LIVE,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteOrphan.length, HARD_CAP_DELETIONS_PER_RUN);
    assert.equal(buckets.cappedOut, true);
    assert.equal(buckets.skip.length, 3);
  });
});

describe("renderWorktreeOrphanReport — deterministic output", () => {
  test("lists reclaimed + skipped worktrees", () => {
    const buckets = {
      deleteOrphan: [
        { worktree: owt("/wt/o-1", "feat-1"), branch: "feat-1" },
        { worktree: owt("/wt/o-2", null), branch: null },
      ],
      skip: [
        { worktree: owt("/wt/live", "feat-live", { pid: 5 }), action: "skip-live-agent" as const, reason: "/wt/live is held by live PID 5 — leave for next run." },
      ],
      cappedOut: false,
    };
    const out = renderWorktreeOrphanReport(buckets, false);
    assert.match(out, /### Worktree-orphan GC \(issue #911\)/);
    assert.match(out, /#### Reclaimed \(local-only orphan worktrees\)/);
    assert.match(out, /- \/wt\/o-1 {2}\(branch: feat-1\)/);
    assert.match(out, /- \/wt\/o-2 {2}\(detached\)/);
    assert.match(out, /#### Skipped — worktree GC/);
    assert.match(out, /- \/wt\/live: .*live PID 5/);
  });

  test("audit-only mode says 'Would reclaim'", () => {
    const buckets = { deleteOrphan: [], skip: [], cappedOut: false };
    const out = renderWorktreeOrphanReport(buckets, true);
    assert.match(out, /#### Would reclaim/);
    assert.doesNotMatch(out, /#### Reclaimed/);
  });

  test("notes the cap when cappedOut is true", () => {
    const buckets = { deleteOrphan: [], skip: [], cappedOut: true };
    const out = renderWorktreeOrphanReport(buckets, false);
    assert.match(out, /hard cap/);
  });
});
