/**
 * Regression tests for the hydra-branch-prune skill's classifier — pass 5,
 * master-tracking-orphan GC (issue #2459), plus the driver wiring guard.
 *
 * A dispatch branch that INHERITED `origin/master` as its upstream (via
 * `git worktree add` / `checkout -b`) and was never pushed under its own
 * name. The upstream is healthy and non-[gone] forever (origin/master is the
 * most-alive ref in the repo) AND the name was never a PR head, so passes
 * 1/3/4 all skip it permanently: pass 1 → skip-not-gone, pass 3 →
 * skip-has-upstream, pass 4 → skip-pr-unresolved. The distinguishing signal
 * is the FOREIGN-upstream test: the tracked ref's branch segment differs
 * from the branch's own name. This pass deletes the LOCAL ref only (no
 * origin/<name> ref exists to touch).
 *
 * Split out of the former single hydra-branch-prune.test.mts into five
 * siblings by classifier pass (issue #4062) to shrink the per-file
 * top-level-entry count that drives the `--test-force-exit` suite-count-drop
 * race — see test/_helpers/branch-prune-fixtures.mts's header for the
 * measured evidence. This file (pass 5 + wiring guard) is sibling 5 of 5.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  upstreamBranchName,
  tracksForeignUpstream,
  classifyMasterTrackingOrphan,
  classifyMasterTrackingOrphans,
  renderMasterTrackingOrphanReport,
  HARD_CAP_DELETIONS_PER_RUN,
  DEFAULT_WORKTREE_MIN_AGE_SECONDS,
  type BranchRow,
} from "../scripts/ci/branch-prune.ts";
import {
  branch,
  localBranch,
  wt,
  masterOrphanBranch,
  masterCtx,
  NEVER_LIVE,
  ALWAYS_LIVE,
  OLD,
  YOUNG,
} from "./_helpers/branch-prune-fixtures.mts";

describe("upstreamBranchName — remote-prefix stripping", () => {
  test("strips the remote prefix on a simple ref", () => {
    assert.equal(upstreamBranchName("origin/master"), "master");
  });

  test("splits on the FIRST slash so slashed branch names survive", () => {
    assert.equal(upstreamBranchName("origin/feature/x"), "feature/x");
    assert.equal(upstreamBranchName("upstream/feature/x"), "feature/x");
  });

  test("a bare name with no slash is the branch name itself", () => {
    assert.equal(upstreamBranchName("master"), "master");
  });

  test("null/undefined/empty → null", () => {
    assert.equal(upstreamBranchName(null), null);
    assert.equal(upstreamBranchName(undefined), null);
    assert.equal(upstreamBranchName(""), null);
  });
});

describe("tracksForeignUpstream — the distinguishing predicate", () => {
  test("worktree-agent-* tracking origin/master is foreign", () => {
    assert.equal(tracksForeignUpstream(masterOrphanBranch("worktree-agent-abc")), true);
  });

  test("a branch self-tracking origin/<own-name> is NOT foreign", () => {
    assert.equal(
      tracksForeignUpstream(masterOrphanBranch("issue-443-foo", { upstreamRef: "origin/issue-443-foo" })),
      false,
    );
  });

  test("no upstream → not foreign (out of this pass's scope)", () => {
    assert.equal(tracksForeignUpstream(localBranch("issue-9-local")), false);
  });

  test("upstream uncollected (null upstreamRef) → not foreign (conservative)", () => {
    assert.equal(tracksForeignUpstream(masterOrphanBranch("worktree-agent-x", { upstreamRef: null })), false);
  });

  test("a slashed branch self-tracking its slashed upstream is NOT foreign", () => {
    assert.equal(
      tracksForeignUpstream(masterOrphanBranch("feature/x", { upstreamRef: "origin/feature/x" })),
      false,
    );
  });
});

describe("classifyMasterTrackingOrphan — pass-ownership rails", () => {
  test("no-upstream branch → skip-no-upstream (dead-branch GC's domain)", () => {
    const r = classifyMasterTrackingOrphan(localBranch("issue-1-local"), masterCtx());
    assert.equal(r.action, "skip-no-upstream");
  });

  test("[gone] upstream → skip-gone (pass 1's domain)", () => {
    const r = classifyMasterTrackingOrphan(branch("issue-2-gone", { gone: true, upstream: true }), masterCtx());
    assert.equal(r.action, "skip-gone");
  });

  test("self-tracking origin/<own-name> → skip-self-tracking (genuine work branch)", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("issue-443-work", { upstreamRef: "origin/issue-443-work" }),
      masterCtx(),
    );
    assert.equal(r.action, "skip-self-tracking");
    assert.match(r.reason, /self-tracking/);
  });

  test("upstream uncollected (null) → skip-self-tracking (conservative, never reaped on missing info)", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-noinfo", { upstreamRef: null }),
      masterCtx(),
    );
    assert.equal(r.action, "skip-self-tracking");
  });
});

describe("classifyMasterTrackingOrphan — never-touch rails", () => {
  test("current branch → skip-current-branch", () => {
    // A foreign-upstream branch that is somehow the current branch is still
    // never deleted. (currentBranch defaults to master; use a foreign upstream.)
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-cur", { current: true }),
      masterCtx(),
    );
    assert.equal(r.action, "skip-current-branch");
    assert.match(r.reason, /current branch/);
  });

  test("non-dispatch name → skip-not-dispatch-branch (never auto-delete operator branches)", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("refactor/adr-0009-cleanup"),
      masterCtx(),
    );
    assert.equal(r.action, "skip-not-dispatch-branch");
    assert.match(r.reason, /operator branches/);
  });

  test("live-PID worktree → skip-live-agent", () => {
    const w = wt("/wt/live", "worktree-agent-live", 4242, { ageSeconds: OLD });
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-live"),
      masterCtx({ worktrees: [w], isLivePid: ALWAYS_LIVE }),
    );
    assert.equal(r.action, "skip-live-agent");
    assert.match(r.reason, /live PID 4242/);
  });

  test("heads an OPEN PR → skip-open-pr-head (negative guard, no positive merge signal)", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-openpr"),
      masterCtx({ openPrHeads: new Set(["worktree-agent-openpr"]) }),
    );
    assert.equal(r.action, "skip-open-pr-head");
    assert.match(r.reason, /open PR/);
  });

  test("attached to a (dead-PID) worktree → skip-attached-worktree (orphan GC owns it)", () => {
    const w = wt("/wt/dead-attached", "worktree-agent-attached", 99999, { ageSeconds: OLD });
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-attached"),
      masterCtx({ worktrees: [w], isLivePid: NEVER_LIVE }),
    );
    assert.equal(r.action, "skip-attached-worktree");
    assert.match(r.reason, /worktree-orphan GC/);
  });

  test("younger than the age floor → skip-too-young", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-fresh", { ageSeconds: YOUNG }),
      masterCtx(),
    );
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /in-flight dispatch/);
  });

  test("UNKNOWN age (null) → skip-too-young (conservative)", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-noage", { ageSeconds: null }),
      masterCtx(),
    );
    assert.equal(r.action, "skip-too-young");
    assert.match(r.reason, /unknown age/);
  });

  test("hard cap → skip-cap", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-capped"),
      masterCtx({ deletionCount: () => HARD_CAP_DELETIONS_PER_RUN }),
    );
    assert.equal(r.action, "skip-cap");
    assert.match(r.reason, /hard cap/);
  });

  test("live-PID rail beats the delete path — fresh live dispatch is skip-live-agent", () => {
    const w = wt("/wt/fresh-live", "worktree-agent-fresh-live", 7, { ageSeconds: YOUNG });
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-fresh-live", { ageSeconds: YOUNG }),
      masterCtx({ worktrees: [w], isLivePid: ALWAYS_LIVE }),
    );
    assert.equal(r.action, "skip-live-agent");
  });
});

describe("classifyMasterTrackingOrphan — reclaim path (the actual fix)", () => {
  test("worktree-agent-* tracking origin/master, no PR, no worktree, past the floor → delete", () => {
    // The 2026-06-25 standing shape: 104 worktree-agent-* branches showing
    // [origin/master: ahead N, behind M] that the first four passes all skip.
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-a0109977"),
      masterCtx(),
    );
    assert.equal(r.action, "delete-branch-master-tracking-orphan");
    assert.match(r.reason, /master-tracking dispatch orphan/);
    assert.match(r.reason, /LOCAL branch/);
  });

  test("an issue-* dispatch branch that inherited origin/master is also reclaimed", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("issue-99-stuck", { upstreamRef: "origin/master" }),
      masterCtx(),
    );
    assert.equal(r.action, "delete-branch-master-tracking-orphan");
  });

  test("a foreign upstream other than master (e.g. origin/develop) still qualifies", () => {
    const r = classifyMasterTrackingOrphan(
      masterOrphanBranch("worktree-agent-dev", { upstreamRef: "origin/develop" }),
      masterCtx(),
    );
    assert.equal(r.action, "delete-branch-master-tracking-orphan");
  });
});

describe("classifyMasterTrackingOrphans — batch + cap accounting", () => {
  test("buckets delete vs skip, silently drops no-upstream/gone/self-tracking rows, preserves order", () => {
    const liveWt = wt("/wt/live", "worktree-agent-live", 5, { ageSeconds: OLD });
    const rows: BranchRow[] = [
      branch("master", { gone: false, current: true }),                           // current + self → skip-self-tracking? no — has its own upstream; dropped
      branch("issue-20-gone", { gone: true }),                                     // [gone] → dropped silently
      localBranch("issue-19-local"),                                               // no upstream → dropped silently
      masterOrphanBranch("issue-18-self", { upstreamRef: "origin/issue-18-self" }), // self-tracking → dropped silently
      masterOrphanBranch("worktree-agent-zombie"),                                 // → delete
      masterOrphanBranch("worktree-agent-live"),                                   // live worktree → skip
      masterOrphanBranch("worktree-agent-young", { ageSeconds: YOUNG }),           // young → skip
      masterOrphanBranch("scratch-orphan"),                                        // not dispatch-shaped → skip
    ];
    const buckets = classifyMasterTrackingOrphans(rows, {
      currentBranch: "master",
      worktrees: [liveWt],
      isLivePid: (pid) => pid === 5,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteBranch.length, 1);
    assert.equal(buckets.deleteBranch[0].name, "worktree-agent-zombie");
    // skips surfaced (not silently dropped): live + young + not-dispatch = 3.
    // The master row self-tracks origin/master → skip-self-tracking → dropped.
    assert.deepEqual(
      buckets.skip.map((s) => s.action),
      ["skip-live-agent", "skip-too-young", "skip-not-dispatch-branch"],
    );
    assert.equal(buckets.cappedOut, false);
  });

  test("priorDeletions seeds the shared hard cap — earlier passes already at cap → all skip-cap", () => {
    const rows = [masterOrphanBranch("worktree-agent-a"), masterOrphanBranch("worktree-agent-b")];
    const buckets = classifyMasterTrackingOrphans(rows, {
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

  test("no upstream info collected (every upstreamRef null) deletes NOTHING", () => {
    const rows = [
      masterOrphanBranch("worktree-agent-a", { upstreamRef: null }),
      masterOrphanBranch("issue-41-b", { upstreamRef: null }),
    ];
    const buckets = classifyMasterTrackingOrphans(rows, {
      currentBranch: "master",
      worktrees: [],
      isLivePid: NEVER_LIVE,
      openPrHeads: new Set<string>(),
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
    });
    assert.equal(buckets.deleteBranch.length, 0);
    // Null upstreamRef → tracksForeignUpstream false → skip-self-tracking → dropped silently.
    assert.equal(buckets.skip.length, 0);
  });
});

describe("renderMasterTrackingOrphanReport — deterministic output", () => {
  test("lists deleted + skipped branches", () => {
    const buckets = {
      deleteBranch: [masterOrphanBranch("worktree-agent-50"), masterOrphanBranch("worktree-agent-old")],
      skip: [
        {
          row: masterOrphanBranch("worktree-agent-51", { ageSeconds: YOUNG }),
          action: "skip-too-young" as const,
          reason: "worktree-agent-51 tracks a foreign upstream but is too young.",
        },
      ],
      cappedOut: false,
    };
    const out = renderMasterTrackingOrphanReport(buckets, false);
    assert.match(out, /### Master-tracking-orphan GC \(issue #2459\)/);
    assert.match(out, /#### Deleted \(dispatch branches tracking origin\/master/);
    assert.match(out, /- worktree-agent-50/);
    assert.match(out, /- worktree-agent-old/);
    assert.match(out, /#### Skipped — master-tracking-orphan GC/);
    assert.match(out, /- worktree-agent-51: .*too young/);
  });

  test("audit-only mode says 'Would delete'", () => {
    const buckets = { deleteBranch: [], skip: [], cappedOut: false };
    const out = renderMasterTrackingOrphanReport(buckets, true);
    assert.match(out, /#### Would delete/);
    assert.doesNotMatch(out, /#### Deleted/);
  });

  test("notes the cap when cappedOut is true", () => {
    const buckets = { deleteBranch: [], skip: [], cappedOut: true };
    const out = renderMasterTrackingOrphanReport(buckets, false);
    assert.match(out, /hard cap/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Shell-driver wiring guards (issue #2459)
//
// The driver must (a) collect the per-branch upstream short-names and pass them
// as branchUpstreams in INPUT_JSON, (b) consume the new plan key, and (c) STILL
// never push a remote-branch deletion — the master-tracking pass is LOCAL-only,
// like every other pass.
// ───────────────────────────────────────────────────────────────────────────

describe("branch-prune.sh — master-tracking-orphan wiring (issue #2459)", () => {
  const driverPath = fileURLToPath(new URL("../scripts/branch-prune.sh", import.meta.url));
  const driver = readFileSync(driverPath, "utf8");

  const codeOnly = driver
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  test("collects per-branch upstreams and passes branchUpstreams into INPUT_JSON", () => {
    assert.match(driver, /%\(upstream:short\)/, "must enumerate per-branch upstream short-names");
    assert.match(driver, /branchUpstreams:/, "must pass branchUpstreams into the runner INPUT_JSON");
  });

  test("the master-tracking apply arm consumes the new plan key", () => {
    assert.match(
      driver,
      /deleteBranchMasterTrackingOrphan/,
      "the driver must consume the master-tracking-orphan plan key",
    );
  });

  test("the master-tracking pass never pushes a remote-branch deletion", () => {
    // Local-only invariant (ADR-0005) — same guard as the merged-remote pass.
    assert.doesNotMatch(
      codeOnly,
      /git\s+push[^\n]*--delete/,
      "branch-prune.sh must never `git push --delete` — the master-tracking pass is LOCAL-only",
    );
  });
});
