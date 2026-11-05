/**
 * Reviewer commit, class A (issue #5267, ADR-0046 Decision 2): the pure
 * decideReviewerCommit() rule, its qa-verdict phase, the trailer qa-fixes
 * passthrough and the hydra-qa playbook step 9.4 pins.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import {
  checkBodyScopeEdit,
  diffHasHunkNearLine,
  decideReviewerCommit,
  parseFilesOutOfScope,
  reviewerCommitLocationPath,
  type ReviewerCommitInput,
} from "../src/qa/round-action.ts";
import { createGhQaVerdictFetchers } from "../src/qa/fetchers.ts";
import { runQaVerdictPhase, type QaVerdictFetchers } from "../src/qa/phases.ts";
import { buildQaVerdictTrailer, parseQaVerdictTrailer } from "../src/qa/verdict-trailer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = readFileSync(join(ROOT, "docs", "operator-playbooks", "hydra-qa.md"), "utf8");

const TWO_WAY_DIFF = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1,1 +1,1 @@",
  "-old",
  "+new",
  "diff --git a/src/widget.ts b/src/widget.ts",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1,1 +1,1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");

function input(over: Partial<ReviewerCommitInput> = {}): ReviewerCommitInput {
  return {
    stage: "A",
    tier: 3,
    changedPaths: ["docs/guide.md", "src/widget.ts"],
    diff: TWO_WAY_DIFF,
    blocking: [{ location: "docs/guide.md:3" }],
    outOfScope: [],
    ...over,
  };
}

describe("decideReviewerCommit: gating and fences", () => {
  test("stage off returns none with reason stage-off", () => {
    const d = decideReviewerCommit(input({ stage: "off" }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "stage-off");
  });

  test("stage A and A+B both permit the commit path", () => {
    assert.equal(decideReviewerCommit(input({ stage: "A" })).action, "commit-a");
    assert.equal(decideReviewerCommit(input({ stage: "A+B" })).action, "commit-a");
  });

  test("T4 and an unknown tier never commit", () => {
    assert.equal(decideReviewerCommit(input({ tier: 4 })).reason, "tier-fence");
    assert.equal(decideReviewerCommit(input({ tier: null })).reason, "tier-fence");
  });

  test("a Verifier Core path in the PR refuses", () => {
    const d = decideReviewerCommit(input({ changedPaths: ["docs/guide.md", "src/untouchable.ts"] }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "verifier-core");
  });

  test("an empty diff (door unknown) refuses", () => {
    const d = decideReviewerCommit(input({ diff: "" }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "one-way-door");
  });

  test("a one-way diff refuses", () => {
    const diff = [
      "diff --git a/scripts/sync-skills.sh b/scripts/sync-skills.sh",
      "--- a/scripts/sync-skills.sh",
      "+++ b/scripts/sync-skills.sh",
      "@@ -1,1 +1,2 @@",
      " const a = 1;",
      "+await redis.del(key);",
      "",
    ].join("\n");
    const d = decideReviewerCommit(input({ diff, changedPaths: ["scripts/sync-skills.sh", "docs/guide.md"] }));
    assert.equal(d.action, "none");
  });
});

describe("decideReviewerCommit: all-or-nothing eligibility", () => {
  test("every blocking finding class A returns commit-a with the paths", () => {
    const d = decideReviewerCommit(
      input({ blocking: [{ location: "docs/guide.md:3" }, { location: "PR body" }, { location: ".changelog/5267-x.md" }] }),
    );
    assert.equal(d.action, "commit-a");
    assert.equal(d.bodyFix, true);
    assert.deepEqual(d.blockingPaths, ["docs/guide.md", ".changelog/5267-x.md"]);
  });

  test("a LOW follow-up at PR body never forces bodyFix; a blocking PR body row still does", () => {
    const low = decideReviewerCommit(
      input({ blocking: [{ location: "docs/guide.md:3" }], followUps: [{ location: "PR body" }] }),
    );
    assert.equal(low.action, "commit-a");
    assert.equal(low.bodyFix, false);
    const blocking = decideReviewerCommit(
      input({ blocking: [{ location: "docs/guide.md:3" }, { location: "PR body" }] }),
    );
    assert.equal(blocking.bodyFix, true);
  });

  test("one blocking finding in src/ makes the whole round none", () => {
    const d = decideReviewerCommit(input({ blocking: [{ location: "docs/guide.md:3" }, { location: "src/widget.ts:1" }] }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "ineligible-finding");
    assert.deepEqual(d.blockingPaths, []);
    assert.deepEqual(d.followUpPaths, []);
  });

  test("playbooks, ADRs, CODING_STANDARDS.md and class-B test files are not class A", () => {
    for (const location of [
      "docs/operator-playbooks/hydra-qa.md:9",
      "docs/adr/0046-x.md",
      "CODING_STANDARDS.md:2",
      "test/foo.test.mts:4",
      "(no location)",
    ]) {
      assert.equal(decideReviewerCommit(input({ blocking: [{ location }] })).action, "none", location);
    }
  });

  test("a path listed under Files out of scope refuses; unreadable scope refuses", () => {
    assert.equal(decideReviewerCommit(input({ outOfScope: ["docs/guide.md"] })).reason, "out-of-scope");
    assert.equal(decideReviewerCommit(input({ outOfScope: ["docs/"] })).reason, "out-of-scope");
    assert.equal(decideReviewerCommit(input({ outOfScope: null })).reason, "out-of-scope");
  });

  test("a PR-body-only fix does not need a readable scope", () => {
    const d = decideReviewerCommit(input({ blocking: [{ location: "PR body" }], outOfScope: null }));
    assert.equal(d.action, "commit-a");
    assert.deepEqual(d.blockingPaths, []);
  });

  test("no blocking findings returns none", () => {
    assert.equal(decideReviewerCommit(input({ blocking: [] })).reason, "no-blocking");
  });

  test("low follow-ups at class-A locations are returned SEPARATELY from blocking paths; others never affect eligibility", () => {
    const d = decideReviewerCommit(
      input({ followUps: [{ location: "docs/other.md:1" }, { location: "src/widget.ts:9" }, { location: "docs/guide.md:8" }] }),
    );
    assert.equal(d.action, "commit-a");
    assert.deepEqual(d.blockingPaths, ["docs/guide.md"]);
    // docs/guide.md is already required; src/widget.ts is not class A.
    assert.deepEqual(d.followUpPaths, ["docs/other.md"]);
  });

  test("a directory out-of-scope entry without a trailing slash covers its children", () => {
    assert.equal(decideReviewerCommit(input({ outOfScope: ["docs"] })).reason, "out-of-scope");
    // sibling shape: a different path sharing the prefix is still in scope
    assert.equal(decideReviewerCommit(input({ outOfScope: ["doc"] })).action, "commit-a");
  });

  test("never throws on hostile input", () => {
    const d = decideReviewerCommit({ stage: "A", tier: 3, changedPaths: null, diff: "", blocking: [], outOfScope: [] } as never);
    assert.equal(d.action, "none");
  });
});

describe("location and scope parsing", () => {
  test("reviewerCommitLocationPath strips line refs and decoration", () => {
    assert.equal(reviewerCommitLocationPath("docs/a.md:12"), "docs/a.md");
    assert.equal(reviewerCommitLocationPath("`docs/a.md#L12`"), "docs/a.md");
    assert.equal(reviewerCommitLocationPath("docs/a.md:12-18"), "docs/a.md");
    assert.equal(reviewerCommitLocationPath("CONTEXT.md:3 (term)"), "CONTEXT.md");
    assert.equal(reviewerCommitLocationPath("PR body"), null);
  });

  test("parseFilesOutOfScope reads the section only", () => {
    const body = "## Files in scope\n\n- `a.ts`\n\n## Files out of scope\n\n- `docs/x.md`\n- src/y.ts\n\n## Other\n\n- `z.ts`\n";
    assert.deepEqual(parseFilesOutOfScope(body), ["docs/x.md", "src/y.ts"]);
  });
});

describe("step 9.4 deterministic re-verify helpers", () => {
  const BODY = "Intro\n\n## Files in scope\n\n- `a.ts`\n\n## Files out of scope\n\n- `b.ts`\n\nCloses #5\n";

  test("checkBodyScopeEdit accepts only added Files in scope bullets", () => {
    const ok = BODY.replace("- `a.ts`\n", "- `a.ts`\n- `docs/x.md`\n");
    assert.equal(checkBodyScopeEdit(BODY, ok).ok, true);
    assert.equal(checkBodyScopeEdit(BODY, BODY).ok, true);
  });

  test("checkBodyScopeEdit refuses edits to out-of-scope, preamble, or removed/non-bullet lines", () => {
    assert.equal(checkBodyScopeEdit(BODY, BODY.replace("- `b.ts`", "- `b.ts`\n- `c.ts`")).ok, false);
    assert.equal(checkBodyScopeEdit(BODY, BODY.replace("Closes #5", "Closes #6")).ok, false);
    assert.equal(checkBodyScopeEdit(BODY, BODY.replace("Intro", "Intro2")).ok, false);
    assert.equal(checkBodyScopeEdit(BODY, BODY.replace("- `a.ts`\n", "")).ok, false);
    assert.equal(checkBodyScopeEdit(BODY, BODY.replace("- `a.ts`\n", "- `a.ts`\nprose\n")).ok, false);
    assert.equal(checkBodyScopeEdit(BODY, BODY + "## Extra\n").ok, false);
  });

  test("diffHasHunkNearLine matches a touching or adjacent hunk, not a distant one", () => {
    const d = "--- a/f\n+++ b/f\n@@ -10,2 +10,3 @@\n-a\n-b\n+c\n+d\n+e\n";
    assert.equal(diffHasHunkNearLine(d, 10), true);
    assert.equal(diffHasHunkNearLine(d, 12), true);
    assert.equal(diffHasHunkNearLine(d, 9), true);
    assert.equal(diffHasHunkNearLine(d, 40), false);
    assert.equal(diffHasHunkNearLine("", 10), false);
    assert.equal(diffHasHunkNearLine(d, 0), false);
    // pure insertion: "+5 lines after line 20" reports -20,0
    assert.equal(diffHasHunkNearLine("@@ -20,0 +21,5 @@\n", 20), true);
  });
});

describe("qa-verdict phases for the reviewer commit", () => {
  function fetchers(over: Partial<QaVerdictFetchers> = {}): QaVerdictFetchers {
    return {
      async rollup() { return []; },
      async requiredContexts() { return []; },
      async headSha() { return "0123456789abcdef0123456789abcdef01234567"; },
      async mergeStateStatus() { return "CLEAN"; },
      async changedFiles() { return ["docs/guide.md", "src/widget.ts"]; },
      async priorBodies() { return []; },
      async ancestry() { return { isAncestor: true, changedSince: [] }; },
      async rolloutStage() { return "A"; },
      async prDiff() { return TWO_WAY_DIFF; },
      async prBody() { return "## Files out of scope\n\n- `src/untouchable.ts`\n"; },
      ...over,
    };
  }
  const phaseInput = { pr: 7, tier: 3, blocking: [{ location: "docs/guide.md:3" }] };

  test("reads stage, diff and body through the port", async () => {
    const out = (await runQaVerdictPhase("reviewer-commit", phaseInput, fetchers())) as any;
    assert.equal(out.action, "commit-a");
    assert.deepEqual(out.degraded, []);
  });

  test("stage off (or an unreadable stage) makes no diff, changed-files or body read", async () => {
    const reads: string[] = [];
    const spy = (stage: any) =>
      fetchers({
        rolloutStage: async () => stage,
        prDiff: async () => { reads.push("diff"); return TWO_WAY_DIFF; },
        prBody: async () => { reads.push("body"); return ""; },
        changedFiles: async () => { reads.push("changed"); return []; },
      });
    const off = (await runQaVerdictPhase("reviewer-commit", phaseInput, spy("off"))) as any;
    assert.equal(off.action, "none");
    assert.equal(off.reason, "stage-off");
    await runQaVerdictPhase("reviewer-commit", phaseInput, spy(null));
    assert.deepEqual(reads, []);
    // sibling shape: an enabled stage still reads all three facts
    await runQaVerdictPhase("reviewer-commit", phaseInput, spy("A"));
    assert.deepEqual(reads.sort(), ["body", "changed", "diff"]);
  });

  test("an adapter without the new getters degrades to none", async () => {
    const f = fetchers();
    delete (f as any).rolloutStage;
    const out = (await runQaVerdictPhase("reviewer-commit", phaseInput, f)) as any;
    assert.equal(out.action, "none");
    assert.ok(out.degraded.includes("rollout-stage"));
  });

  test("an unreadable diff or body degrades to none", async () => {
    const noDiff = (await runQaVerdictPhase("reviewer-commit", phaseInput, fetchers({ prDiff: async () => null }))) as any;
    assert.equal(noDiff.action, "none");
    assert.ok(noDiff.degraded.includes("diff"));
    const noBody = (await runQaVerdictPhase("reviewer-commit", phaseInput, fetchers({ prBody: async () => null }))) as any;
    assert.equal(noBody.action, "none");
    assert.ok(noBody.degraded.includes("pr-body"));
  });

  test("the trailer phase renders qa-fixes= and the explicit new head", async () => {
    const out = (await runQaVerdictPhase(
      "trailer",
      { pr: 7, verdict: "PASS-pending-CI", blockers: 0, maxSeverity: "none", headSha: "fedcba9876543210fedc", qaFixes: ["fedcba987654aa"] },
      fetchers(),
    )) as any;
    const t = parseQaVerdictTrailer(out.trailer);
    assert.equal(t?.verdict, "PASS-pending-CI");
    assert.equal(t?.sha, "fedcba987654");
    assert.deepEqual(t?.qaFixes, ["fedcba987654"]);
    assert.equal(t?.blockers, 0);
  });

  test("buildQaVerdictTrailer without qaFixes is unchanged", () => {
    const line = buildQaVerdictTrailer({
      verdict: "PASS", pr: 7, headSha: "0123456789abcdef", blockers: 0, maxSeverity: "none", priorBodies: [],
    });
    assert.ok(!line.includes("qa-fixes="));
  });
});

describe("playbook step 9.4 pins", () => {
  const start = PLAYBOOK.indexOf("### 9.4 Reviewer commit (class A)");
  const end = PLAYBOOK.indexOf("### 9.5 ");
  const step94 = PLAYBOOK.slice(start, end);

  test("step 9.4 sits between step 9 and step 9.5", () => {
    assert.ok(start > PLAYBOOK.indexOf("### 9. Classify"));
    assert.ok(end > start);
  });

  test("never force-pushes and uses no plus refspec", () => {
    assert.ok(!/--force|force-with-lease/.test(step94.replace(/never force-push/g, "")));
    assert.ok(!/\+refs|\+HEAD/.test(step94));
    assert.ok(step94.includes('git push origin "HEAD:refs/heads/$HEAD_REF"'));
  });

  test("the commit carries the QA-Fix: A trailer, is detached and runs the local proof before the push", () => {
    assert.ok(step94.includes('-m "QA-Fix: A"'));
    assert.ok(step94.includes("git worktree add --detach"));
    assert.ok(step94.indexOf("scripts/ci/qa-fix-proof.ts") < step94.indexOf("git push origin"));
    assert.ok(step94.indexOf("gh pr edit") < step94.indexOf("git push origin"));
  });

  test("the phase runs only on a FAIL verdict and is gated before the RC_JSON reads", () => {
    const gate = step94.indexOf('if [ "$REVIEW_VERDICT" = "FAIL" ]; then');
    assert.ok(gate !== -1 && gate < step94.indexOf('qa-verdict.ts" reviewer-commit'));
  });

  test("only blocking paths must be staged; follow-up paths are an optional subset", () => {
    assert.ok(step94.includes("RC_BLOCKING_PATHS") && step94.includes("RC_FOLLOWUP_PATHS"));
    assert.ok(step94.includes('grep -qvxF -f <(printf \'%s\\n\' "$RC_BLOCKING_PATHS" "$RC_FOLLOWUP_PATHS")'));
    assert.ok(!step94.includes("RC_PATHS"));
  });

  test("the proof and regenerators run from the master-based session tree against a separate PR worktree", () => {
    assert.ok(step94.includes('SESSION_ROOT=$(git rev-parse --show-toplevel)'));
    assert.ok(step94.includes('"$MASTER_WT"/scripts/ci/qa-fix-proof.ts --base "$REVIEWED_HEAD" --head HEAD'));
    assert.ok(step94.includes('"$MASTER_WT"/scripts/ci/qa-fix-proof.ts --base "$FIXED_SHA" --head HEAD'), "stage is read from master");
    assert.ok(step94.includes('git worktree add --detach "$PR_WT"'));
    assert.ok(!/node [^\n]*[ "]scripts\/ci\/qa-fix-proof\.ts/.test(step94), "no PR-tree relative script path");
    assert.ok(!step94.includes("git checkout --detach"), "the session tree is never switched to the PR head");
  });

  test("a claimed body fix requires BODY_CHANGED unconditionally, and only Files in scope bullets may be added", () => {
    assert.ok(step94.includes('[ "$BODY_FIX" != true ] || [ "$BODY_CHANGED" = 1 ] || RC_OK=0'));
    assert.ok(step94.includes("body-scope-check"));
  });

  test("each blocking row with a line has an executable diff-hunk check", () => {
    assert.ok(step94.includes("-U0"));
    assert.ok(step94.includes("ROW_FILE") && step94.includes("ROW_LINE"));
  });

  test("cleanup is gated on a created PR worktree, leaves the session tree untouched, and removes tempfiles", () => {
    assert.ok(step94.includes('[ "$CHECKED_OUT" = 1 ]'));
    assert.ok(step94.includes("SESSION_HEAD") && !step94.includes("ORIG_HEAD"));
    assert.ok(step94.includes('rm -f "$ORIG_BODY_FILE" "$RC_BODY_FILE"'));
    assert.ok(step94.includes("--allow-empty"));
  });

  test("step 9.4 adds no second fold call and no prior-findings variables", () => {
    assert.ok(!step94.includes("scripts/ci/qa-verdict.ts fold"));
    assert.ok(!/PRIOR_FINDINGS|REREVIEW_DIFF_BASE/.test(step94));
  });

  test("step 9.5 passes the new head and qaFixes explicitly to the trailer phase", () => {
    const step95 = PLAYBOOK.slice(end, PLAYBOOK.indexOf("### 9.6 "));
    assert.ok(step95.includes("qaFixes"));
    assert.ok(step95.includes("headSha: $newhead"));
  });

  test("the rollout switch ships off", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "config", "orchestrator", "qa-rollout.json"), "utf8"));
    assert.equal(cfg["reviewer-commits"], "off");
  });
});

describe("step 9.4 trust: scripts run from a master worktree, regenerators target the PR worktree (round 4)", () => {
  const start = PLAYBOOK.indexOf("### 9.4 Reviewer commit");
  const step94 = PLAYBOOK.slice(start, PLAYBOOK.indexOf("\n### ", start + 10));

  test("a master worktree of FIXED_SHA is built, every script is invoked under it, and the session tree is asserted unchanged", () => {
    assert.ok(step94.includes('git worktree add --detach "$MASTER_ROOT_DIR/master" "$FIXED_SHA"'));
    assert.ok(step94.includes('"$MASTER_WT/scripts/ci/qa-verdict.ts" reviewer-commit'));
    assert.ok(!/ scripts\/ci\/qa-verdict\.ts reviewer-commit/.test(step94), "no relative qa-verdict path");
    assert.ok(!step94.includes("$SESSION_ROOT/scripts"), "no script runs from the session tree");
    assert.ok(step94.includes('git -C "$SESSION_ROOT" status --porcelain'));
  });

  test("regenerators are pointed at the PR worktree via HYDRA_REPO_ROOT", () => {
    assert.ok(step94.includes('HYDRA_REPO_ROOT="$PR_WT"'));
  });
});

describe("HYDRA_REPO_ROOT retargets the trusted regenerators (round 4)", () => {
  test("suite-count-check --update-baseline writes the target checkout, not its own", () => {
    const own = join(ROOT, "test", "fixtures", "suite-count-baseline.json");
    const before = readFileSync(own, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "qa5267-root-"));
    try {
      mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
      writeFileSync(join(dir, "test", "x.test.mts"), 'import { test } from "node:test";\ntest("a", () => {});\n');
      writeFileSync(join(dir, "test", "fixtures", "suite-count-baseline.json"), "{}\n");
      const r = spawnSync(
        process.execPath,
        [join(ROOT, "scripts", "test", "suite-count-check.mjs"), "--update-baseline", "--only", "test/x.test.mts"],
        { env: { ...process.env, HYDRA_REPO_ROOT: dir }, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const written = JSON.parse(readFileSync(join(dir, "test", "fixtures", "suite-count-baseline.json"), "utf8"));
      assert.equal(written["test/x.test.mts"], 1);
      assert.equal(readFileSync(own, "utf8"), before, "the script's own checkout is untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without HYDRA_REPO_ROOT the script still targets its own checkout (sibling shape)", () => {
    const src = readFileSync(join(ROOT, "scripts", "test", "suite-count-check.mjs"), "utf8");
    assert.ok(src.includes("process.env.HYDRA_REPO_ROOT") && src.includes('"..", ".."'));
  });
});

describe("reviewer-commits rollout stage authority (INV-1, #5267 round 5)", () => {
  function treeWithStage(stage: string): string {
    const dir = mkdtempSync(join(tmpdir(), "qa-rollout-"));
    mkdirSync(join(dir, "config", "orchestrator"), { recursive: true });
    mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
    writeFileSync(join(dir, "test", "fixtures", "qa-cohort-baseline.json"), JSON.stringify({ metrics: { tripped: false } }));
    writeFileSync(
      join(dir, "config", "orchestrator", "qa-rollout.json"),
      JSON.stringify({ "two-way-pair": "off", "reviewer-commits": stage }),
    );
    return dir;
  }

  test("the real adapter reads the stage from cwd: master (off) wins over a PR tree saying A", async () => {
    const master = treeWithStage("off");
    const prTree = treeWithStage("A");
    const prev = process.cwd();
    try {
      const f = createGhQaVerdictFetchers("o/r");
      process.chdir(master);
      assert.equal(await f.rolloutStage!(), "off");
      // sibling shape: run from the tree that says A, the adapter reports A
      process.chdir(prTree);
      assert.equal(await f.rolloutStage!(), "A");
    } finally {
      process.chdir(prev);
      rmSync(master, { recursive: true, force: true });
      rmSync(prTree, { recursive: true, force: true });
    }
  });

  test("playbook runs the phase with cwd = $MASTER_WT and the pinned master tsx, not npx", () => {
    const start = PLAYBOOK.indexOf("### 9.4 Reviewer commit");
    const step94 = PLAYBOOK.slice(start, PLAYBOOK.indexOf("\n### ", start + 10));
    assert.ok(/\(cd "\$MASTER_WT" && node [^\n]*qa-verdict\.ts" reviewer-commit\)/.test(step94));
    assert.ok(step94.includes('"$MASTER_WT/node_modules/.bin/tsx"'));
    assert.ok(!step94.includes("npx tsx"));
  });
});
