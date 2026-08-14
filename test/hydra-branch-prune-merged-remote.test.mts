/**
 * Regression tests for the hydra-branch-prune skill's classifier — pass 4,
 * merged-remote GC (issue #2029).
 *
 * A dispatch branch whose PR is MERGED/CLOSED but whose `origin/<name>`
 * remote ref still exists (squash-merge without --delete-branch) — the
 * upstream never goes [gone], so pass 1 (skip-not-gone) and pass 3
 * (skip-has-upstream) both miss it. This pass keys on a positive
 * merged/closed-PR signal and deletes the LOCAL ref only.
 *
 * Split out of the former single hydra-branch-prune.test.mts into five
 * siblings by classifier pass (issue #4062) to shrink the per-file
 * top-level-entry count that drives the `--test-force-exit` suite-count-drop
 * race — see test/_helpers/branch-prune-fixtures.mts's header for the
 * measured evidence. This file (pass 4 + local-only invariant guard) is
 * sibling 4 of 5.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyMergedRemote,
  classifyMergedRemotes,
  renderMergedRemoteReport,
  HARD_CAP_DELETIONS_PER_RUN,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type BranchRow,
} from "../scripts/ci/branch-prune.ts";
import {
  branch,
  localBranch,
  wt,
  liveUpstreamBranch,
  mergedCtx,
  NEVER_LIVE,
  ALWAYS_LIVE,
  OLD,
  YOUNG,
} from "./_helpers/branch-prune-fixtures.mts";

describe("classifyMergedRemote — pass-ownership rails", () => {
  test("no-upstream branch → skip-no-upstream (dead-branch GC's domain)", () => {
    const r = classifyMergedRemote(localBranch("issue-1-local"), mergedCtx());
    assert.equal(r.action, "skip-no-upstream");
  });

  test("[gone] upstream → skip-gone (pass 1's domain)", () => {
    const r = classifyMergedRemote(branch("issue-2-gone", { gone: true, upstream: true }), mergedCtx());
    assert.equal(r.action, "skip-gone");
  });
});

describe("classifyMergedRemote — never-touch rails", () => {
  test("current branch → skip-current-branch", () => {
    const r = classifyMergedRemote(liveUpstreamBranch("issue-3-cur", { current: true }), mergedCtx());
    assert.equal(r.action, "skip-current-branch");
    assert.match(r.reason, /current branch/);
  });

  test("non-dispatch name → skip-not-dispatch-branch (never auto-delete operator branches)", () => {
    const r = classifyMergedRemote(
      liveUpstreamBranch("refactor/adr-0009-cleanup"),
      mergedCtx({ mergedOrClosedPrHeads: new Set(["refactor/adr-0009-cleanup"]) }),
    );
    assert.equal(r.action, "skip-not-dispatch-branch");
    assert.match(r.reason, /operator branches/);
  });

  test("live-PID worktree → skip-live-agent", () => {
    const w = wt("/wt/live", "issue-4-live", 4242, { ageSeconds: OLD });
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-4-live"),
      mergedCtx({
        worktrees: [w],
        isLivePid: ALWAYS_LIVE,
        mergedOrClosedPrHeads: new Set(["issue-4-live"]),
      }),
    );
    assert.equal(r.action, "skip-live-agent");
    assert.match(r.reason, /live PID 4242/);
  });

  test("heads an OPEN PR → skip-pr-unresolved (still in-flight)", () => {
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-5-open"),
      mergedCtx({ openPrHeads: new Set(["issue-5-open"]) }),
    );
    assert.equal(r.action, "skip-pr-unresolved");
    assert.match(r.reason, /OPEN PR/);
  });

  test("no merged/closed signal (gh absent / PR still open) → skip-pr-unresolved (never delete on absence)", () => {
    const r = classifyMergedRemote(liveUpstreamBranch("issue-6-unknown"), mergedCtx());
    assert.equal(r.action, "skip-pr-unresolved");
    assert.match(r.reason, /no MERGED\/CLOSED PR signal/);
  });

  test("merged/closed but attached to a (dead-PID) worktree → skip-attached-worktree (orphan GC owns it)", () => {
    const w = wt("/wt/dead-attached", "issue-7-attached", 99999, { ageSeconds: OLD });
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-7-attached"),
      mergedCtx({
        worktrees: [w],
        isLivePid: NEVER_LIVE,
        mergedOrClosedPrHeads: new Set(["issue-7-attached"]),
      }),
    );
    assert.equal(r.action, "skip-attached-worktree");
    assert.match(r.reason, /worktree-orphan GC/);
  });

  test("merged/closed but younger than the age floor → skip-too-young", () => {
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-8-fresh", { ageSeconds: YOUNG }),
      mergedCtx({ mergedOrClosedPrHeads: new Set(["issue-8-fresh"]) }),
    );
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /in-flight cycle/);
  });

  test("merged/closed but UNKNOWN age (null) → skip-too-young (conservative)", () => {
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-9-noage", { ageSeconds: null }),
      mergedCtx({ mergedOrClosedPrHeads: new Set(["issue-9-noage"]) }),
    );
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /unknown age/);
  });

  test("hard cap → skip-cap", () => {
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-10-capped"),
      mergedCtx({
        mergedOrClosedPrHeads: new Set(["issue-10-capped"]),
        deletionCount: () => HARD_CAP_DELETIONS_PER_RUN,
      }),
    );
    assert.equal(r.action, "skip-cap");
    assert.match(r.reason, /hard cap/);
  });

  test("live-PID rail beats the merge signal — fresh live dispatch is skip-live-agent", () => {
    const w = wt("/wt/fresh-live", "issue-11-fresh-live", 7, { ageSeconds: YOUNG });
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-11-fresh-live", { ageSeconds: YOUNG }),
      mergedCtx({
        worktrees: [w],
        isLivePid: ALWAYS_LIVE,
        mergedOrClosedPrHeads: new Set(["issue-11-fresh-live"]),
      }),
    );
    assert.equal(r.action, "skip-live-agent");
  });
});

describe("classifyMergedRemote — reclaim path (the actual fix)", () => {
  test("dispatch name, live upstream, PR merged/closed, no worktree, past the floor → delete-branch-merged-remote", () => {
    // The 2026-06-19 standing shape: ~160 squash-merged-without-delete-branch
    // dispatch branches whose origin/<name> ref still exists.
    const r = classifyMergedRemote(
      liveUpstreamBranch("issue-2029-merged-remote-prune"),
      mergedCtx({ mergedOrClosedPrHeads: new Set(["issue-2029-merged-remote-prune"]) }),
    );
    assert.equal(r.action, "delete-branch-merged-remote");
    assert.match(r.reason, /merged\/closed/);
    assert.match(r.reason, /LOCAL branch only/);
  });

  test("worktree-agent-* zombie-remote leftover is also reclaimed", () => {
    const r = classifyMergedRemote(
      liveUpstreamBranch("worktree-agent-deadbeef"),
      mergedCtx({ mergedOrClosedPrHeads: new Set(["worktree-agent-deadbeef"]) }),
    );
    assert.equal(r.action, "delete-branch-merged-remote");
  });
});

describe("classifyMergedRemotes — batch + cap accounting", () => {
  test("buckets delete vs skip, silently drops no-upstream + gone rows, preserves order", () => {
    const liveWt = wt("/wt/live", "issue-22-live", 5, { ageSeconds: OLD });
    const merged = new Set([
      "issue-21-zombie",
      "issue-22-live",
      "issue-24-young",
      "scratch-merged",
    ]);
    const rows: BranchRow[] = [
      branch("master", { gone: false, current: true }),          // current + live upstream, not merged → skip-pr-unresolved? no — current first
      branch("issue-20-gone", { gone: true }),                   // [gone] → dropped silently
      localBranch("issue-19-local"),                             // no upstream → dropped silently
      liveUpstreamBranch("issue-21-zombie"),                     // → delete
      liveUpstreamBranch("issue-22-live"),                       // live worktree → skip
      liveUpstreamBranch("issue-23-unknown"),                    // not in merged set → skip-pr-unresolved
      liveUpstreamBranch("issue-24-young", { ageSeconds: YOUNG }), // merged but young → skip
      liveUpstreamBranch("scratch-merged"),                      // not dispatch-shaped → skip
    ];
    const buckets = classifyMergedRemotes(rows, {
      currentBranch: "master",
      worktrees: [liveWt],
      isLivePid: (pid) => pid === 5,
      mergedOrClosedPrHeads: merged,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteBranch.length, 1);
    assert.equal(buckets.deleteBranch[0].name, "issue-21-zombie");
    // skips: master(current) + live + unknown + young + scratch = 5; the
    // [gone] and no-upstream rows are dropped (passes 1 and 3 own them).
    assert.deepEqual(
      buckets.skip.map((s) => s.action),
      [
        "skip-current-branch",
        "skip-live-agent",
        "skip-pr-unresolved",
        "skip-too-young",
        "skip-not-dispatch-branch",
      ],
    );
    assert.equal(buckets.cappedOut, false);
  });

  test("priorDeletions seeds the shared hard cap — earlier passes already at cap → all skip-cap", () => {
    const rows = [liveUpstreamBranch("issue-30-a"), liveUpstreamBranch("issue-31-b")];
    const buckets = classifyMergedRemotes(rows, {
      currentBranch: "master",
      worktrees: [],
      isLivePid: NEVER_LIVE,
      mergedOrClosedPrHeads: new Set(["issue-30-a", "issue-31-b"]),
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
      priorDeletions: HARD_CAP_DELETIONS_PER_RUN,
    });
    assert.equal(buckets.deleteBranch.length, 0);
    assert.equal(buckets.cappedOut, true);
    assert.ok(buckets.skip.every((s) => s.action === "skip-cap"));
  });

  test("empty merged set (gh absent) deletes NOTHING", () => {
    const rows = [
      liveUpstreamBranch("issue-40-a"),
      liveUpstreamBranch("issue-41-b"),
      liveUpstreamBranch("worktree-agent-c"),
    ];
    const buckets = classifyMergedRemotes(rows, {
      currentBranch: "master",
      worktrees: [],
      isLivePid: NEVER_LIVE,
      mergedOrClosedPrHeads: new Set<string>(),
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteBranch.length, 0);
    assert.ok(buckets.skip.every((s) => s.action === "skip-pr-unresolved"));
  });
});

describe("renderMergedRemoteReport — deterministic output", () => {
  test("lists deleted + skipped branches", () => {
    const buckets = {
      deleteBranch: [liveUpstreamBranch("issue-50-zombie"), liveUpstreamBranch("worktree-agent-old")],
      skip: [
        {
          row: liveUpstreamBranch("issue-51-unknown"),
          action: "skip-pr-unresolved" as const,
          reason: "issue-51-unknown has a live upstream but no MERGED/CLOSED PR signal — never delete.",
        },
      ],
      cappedOut: false,
    };
    const out = renderMergedRemoteReport(buckets, false);
    assert.match(out, /### Merged-remote GC \(issue #2029\)/);
    assert.match(out, /#### Deleted \(local refs of merged\/closed PRs/);
    assert.match(out, /- issue-50-zombie/);
    assert.match(out, /- worktree-agent-old/);
    assert.match(out, /#### Skipped — merged-remote GC/);
    assert.match(out, /- issue-51-unknown: .*no MERGED\/CLOSED PR signal/);
  });

  test("audit-only mode says 'Would delete'", () => {
    const buckets = { deleteBranch: [], skip: [], cappedOut: false };
    const out = renderMergedRemoteReport(buckets, true);
    assert.match(out, /#### Would delete/);
    assert.doesNotMatch(out, /#### Deleted/);
  });

  test("notes the cap when cappedOut is true", () => {
    const buckets = { deleteBranch: [], skip: [], cappedOut: true };
    const out = renderMergedRemoteReport(buckets, false);
    assert.match(out, /hard cap/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Local-only invariant guard (issue #2029)
//
// The merged-remote pass MUST delete only LOCAL refs — the zombie origin ref
// is an external-account mutation (ADR-0005) and stays an operator step. Guard
// the shell driver as text: a `git push origin --delete` / `git push --delete`
// would break the invariant the whole design rests on.
// ───────────────────────────────────────────────────────────────────────────

describe("branch-prune.sh — local-only invariant (issue #2029)", () => {
  const driverPath = fileURLToPath(new URL("../scripts/branch-prune.sh", import.meta.url));
  const driver = readFileSync(driverPath, "utf8");

  // Only inspect EXECUTABLE lines, not the explanatory comments (which
  // legitimately mention `git push origin --delete` in prose, exactly to
  // document why the script must NOT do it). A real call line is indented
  // code where `git ` is the command — never a `#`-prefixed comment.
  const codeOnly = driver
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("never pushes a remote-branch deletion", () => {
    assert.doesNotMatch(
      codeOnly,
      /git\s+push[^\n]*--delete/,
      "branch-prune.sh must never `git push --delete` a remote branch — the zombie origin ref is an operator step (ADR-0005)",
    );
    assert.doesNotMatch(
      codeOnly,
      /git\s+push[^\n]*:\s*refs\/heads/,
      "branch-prune.sh must never push a colon-refspec remote-branch deletion",
    );
  });

  test("the merged-remote apply arm exists and deletes a LOCAL branch only", () => {
    assert.match(
      driver,
      /deleteBranchMergedRemote/,
      "the driver must consume the merged-remote plan key",
    );
  });
});
