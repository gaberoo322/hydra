/**
 * Reviewer commit, class A (issue #5267, ADR-0046 Decision 2): the pure
 * decideReviewerCommit() rule, its qa-verdict phase, the trailer qa-fixes
 * passthrough and the hydra-qa playbook step 9.4 pins.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  decideReviewerCommit,
  parseFilesOutOfScope,
  reviewerCommitLocationPath,
  type ReviewerCommitInput,
} from "../src/qa/round-action.ts";
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
    for (const stage of ["off"] as const) {
      const d = decideReviewerCommit(input({ stage }));
      assert.equal(d.action, "none");
      assert.equal(d.reason, "stage-off");
    }
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
    assert.deepEqual(d.paths, ["docs/guide.md", ".changelog/5267-x.md"]);
  });

  test("one blocking finding in src/ makes the whole round none", () => {
    const d = decideReviewerCommit(input({ blocking: [{ location: "docs/guide.md:3" }, { location: "src/widget.ts:1" }] }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "ineligible-finding");
    assert.deepEqual(d.paths, []);
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
    assert.deepEqual(d.paths, []);
  });

  test("no blocking findings returns none", () => {
    assert.equal(decideReviewerCommit(input({ blocking: [] })).reason, "no-blocking");
  });

  test("low follow-ups at class-A locations ride along; others never affect eligibility", () => {
    const d = decideReviewerCommit(
      input({ followUps: [{ location: "docs/other.md:1" }, { location: "src/widget.ts:9" }] }),
    );
    assert.equal(d.action, "commit-a");
    assert.deepEqual(d.paths, ["docs/guide.md", "docs/other.md"]);
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
    assert.ok(step94.includes("git checkout --detach"));
    assert.ok(step94.indexOf("scripts/ci/qa-fix-proof.ts") < step94.indexOf("git push origin"));
    assert.ok(step94.indexOf("gh pr edit") < step94.indexOf("git push origin"));
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
