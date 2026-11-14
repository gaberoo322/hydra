/**
 * Reviewer commit, class B (issue #5268, ADR-0046 Decision 2 / Decision 6): the
 * A+B bucket of decideReviewerCommit(), countTestCases(), the case-count-check
 * subcommand, the vacuous-test proof refusal, commit graduation and the
 * hydra-qa playbook step 9.4 class-B pins.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { countTestCases, decideReviewerCommit, type ReviewerCommitInput } from "../src/qa/round-action.ts";
import { parseTapAssertionProof } from "../src/qa/fix-proof.ts";
import {
  assessCommitGraduation,
  escapeFixtureStale,
  GRADUATION_MIN_CLEAN_A,
  planFlipItem,
  FLIP_ITEM_MARKER,
  type CommitGraduationInputs,
  type CommitGraduationPr,
} from "../scripts/qa/commit-graduation.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = readFileSync(join(ROOT, "docs", "operator-playbooks", "_fragments", "hydra-qa-reference.md"), "utf8");

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
  "diff --git a/test/widget.test.mts b/test/widget.test.mts",
  "--- a/test/widget.test.mts",
  "+++ b/test/widget.test.mts",
  "@@ -1,1 +1,1 @@",
  "-const t = 1;",
  "+const t = 2;",
  "",
].join("\n");

function input(over: Partial<ReviewerCommitInput> = {}): ReviewerCommitInput {
  return {
    stage: "A+B",
    tier: 3,
    changedPaths: ["docs/guide.md", "src/widget.ts", "test/widget.test.mts"],
    diff: TWO_WAY_DIFF,
    blocking: [{ location: "test/widget.test.mts:12" }],
    outOfScope: [],
    ...over,
  };
}

describe("decideReviewerCommit: class-B stage gating (INV-1)", () => {
  test("stage A refuses a class-B blocking row as ineligible-finding", () => {
    const d = decideReviewerCommit(input({ stage: "A" }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "ineligible-finding");
    assert.deepEqual(d.blockingTestPaths, []);
  });

  test("stage off answers stage-off before any read", () => {
    const d = decideReviewerCommit(input({ stage: "off" }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "stage-off");
  });

  test("stage A+B with only class-B rows is commit-b", () => {
    const d = decideReviewerCommit(input());
    assert.equal(d.action, "commit-b");
    assert.equal(d.reason, "class-b-fixable");
    assert.deepEqual(d.blockingTestPaths, ["test/widget.test.mts"]);
    assert.deepEqual(d.blockingPaths, []);
    assert.equal(d.bodyFix, false);
  });

  test("the shipped rollout config stays off", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "config", "orchestrator", "qa-rollout.json"), "utf8"));
    assert.equal(cfg["reviewer-commits"], "off");
  });
});

describe("decideReviewerCommit: all-or-nothing across classes (INV-2..4)", () => {
  test("a class-A and a class-B blocking row make commit-ab", () => {
    const d = decideReviewerCommit(
      input({ blocking: [{ location: "docs/guide.md:3" }, { location: "test/widget.test.mts:12" }] }),
    );
    assert.equal(d.action, "commit-ab");
    assert.equal(d.reason, "class-ab-fixable");
    assert.deepEqual(d.blockingPaths, ["docs/guide.md"]);
    assert.deepEqual(d.blockingTestPaths, ["test/widget.test.mts"]);
  });

  test("a PR-body row plus a class-B row is commit-ab with bodyFix", () => {
    const d = decideReviewerCommit(input({ blocking: [{ location: "PR body" }, { location: "test/widget.test.mts" }] }));
    assert.equal(d.action, "commit-ab");
    assert.equal(d.bodyFix, true);
  });

  test("one blocking row in src/ refuses the whole round (a test edit cannot satisfy it)", () => {
    const d = decideReviewerCommit(
      input({ blocking: [{ location: "test/widget.test.mts:12" }, { location: "src/widget.ts:1" }] }),
    );
    assert.equal(d.action, "none");
    assert.equal(d.reason, "ineligible-finding");
  });

  test("a class-B path listed under Files out of scope refuses", () => {
    const d = decideReviewerCommit(input({ outOfScope: ["test/widget.test.mts"] }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "out-of-scope");
  });

  test("an unreadable body (outOfScope null) refuses a class-B row", () => {
    const d = decideReviewerCommit(input({ outOfScope: null }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "out-of-scope");
  });

  test("test/helpers/ is not class B", () => {
    const d = decideReviewerCommit(input({ blocking: [{ location: "test/helpers/util.mts:1" }] }));
    assert.equal(d.action, "none");
    assert.equal(d.reason, "ineligible-finding");
  });

  test("a blocking row at an AB baseline stays in the class-A bucket", () => {
    const d = decideReviewerCommit(input({ blocking: [{ location: "test/fixtures/suite-count-baseline.json" }] }));
    assert.equal(d.action, "commit-a");
    assert.deepEqual(d.blockingTestPaths, []);
    assert.deepEqual(d.blockingPaths, ["test/fixtures/suite-count-baseline.json"]);
  });

  test("fences run before any class: Verifier Core and T4 refuse class B too", () => {
    assert.equal(decideReviewerCommit(input({ tier: 4 })).reason, "tier-fence");
    assert.equal(decideReviewerCommit(input({ changedPaths: ["src/untouchable.ts"] })).reason, "verifier-core");
  });

  test("low follow-ups at a test path ride along as optional, never widening the class set", () => {
    const d = decideReviewerCommit(
      input({
        blocking: [{ location: "docs/guide.md:3" }],
        followUps: [{ location: "test/widget.test.mts:9" }],
      }),
    );
    assert.equal(d.action, "commit-a");
    assert.deepEqual(d.followUpTestPaths, ["test/widget.test.mts"]);
    assert.deepEqual(d.blockingTestPaths, []);
  });

  test("a path both blocking and follow-up is required, not optional", () => {
    const d = decideReviewerCommit(input({ followUps: [{ location: "test/widget.test.mts:30" }] }));
    assert.deepEqual(d.followUpTestPaths, []);
  });

  test("a throwing input fails closed and never throws", () => {
    const d = decideReviewerCommit({ ...input(), blocking: null as unknown as [] });
    assert.equal(d.action, "none");
  });

  test("the decision takes no clean-fix count input (INV-11)", () => {
    const keys = Object.keys(input()).join(",");
    assert.ok(!/count|clean|graduat/i.test(keys));
  });
});

describe("countTestCases and case-count-check (INV-8)", () => {
  test("counts test( / it( / modifiers and ignores comments and identifiers", () => {
    const text = [
      'test("a", () => {});',
      '  it("b", () => {});',
      'test.skip("c", () => {});',
      '// test("commented", () => {});',
      "const latest = (x) => x;",
      "contest(1);",
      "",
    ].join("\n");
    assert.equal(countTestCases(text), 3);
  });

  test("never throws on non-string input", () => {
    assert.equal(countTestCases(undefined as unknown as string), 0);
  });

  function run(before: string, after: string): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "qa-case-count-"));
    try {
      writeFileSync(join(dir, "before.mts"), before);
      writeFileSync(join(dir, "after.mts"), after);
      const r = spawnSync(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", join(ROOT, "scripts/ci/qa-commit-checks.ts"),
          "case-count-check", join(dir, "before.mts"), join(dir, "after.mts")],
        { encoding: "utf8" },
      );
      return { status: r.status, out: r.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("exit 0 when no case is lost, exit 1 when a case is deleted", () => {
    const two = 'test("a", () => {});\ntest("b", () => {});\n';
    const one = 'test("a", () => {});\n';
    assert.equal(run(one, two).status, 0);
    assert.equal(run(two, two).status, 0);
    const lost = run(two, one);
    assert.equal(lost.status, 1);
    assert.deepEqual(JSON.parse(lost.out), { ok: false, before: 2, after: 1 });
  });

  test("an unreadable input fails closed", () => {
    const r = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", join(ROOT, "scripts/ci/qa-commit-checks.ts"),
        "case-count-check", "/nonexistent/before", "/nonexistent/after"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1);
  });
});

describe("class-B proof refuses a vacuous test (INV-7)", () => {
  const FILE = "test/widget.test.mts";
  const vacuousTap = ["TAP version 13", "ok 1 - widget", "  ---", `  location: '${FILE}:3:1'`, "  ..."].join("\n");
  const provenTap = [
    "TAP version 13",
    `not ok 1 - widget case`,
    "  ---",
    `  location: '${FILE}:3:1'`,
    "  code: 'ERR_ASSERTION'",
    "  ...",
  ].join("\n");
  const crashTap = [
    "TAP version 13",
    `not ok 1 - ${FILE}`,
    "  ---",
    "  exitCode: 1",
    "  code: 'ERR_MODULE_NOT_FOUND'",
    "  ...",
  ].join("\n");

  test("zero ERR_ASSERTION for the class-B file is unproven", () => {
    const r = parseTapAssertionProof(vacuousTap, [FILE]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.unproven, [FILE]);
  });

  test("a sibling with one ERR_ASSERTION is proven", () => {
    const r = parseTapAssertionProof(provenTap, [FILE]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.unproven, []);
  });

  test("a file-level crash at the merge-base is unproven", () => {
    const r = parseTapAssertionProof(crashTap, [FILE]);
    assert.equal(r.ok, false);
  });
});

describe("assessCommitGraduation (INV-10)", () => {
  const A_MSG = "fix(qa): reviewer fix\n\nQA-Fix: A";
  const mk = (n: number, over: Partial<CommitGraduationPr> = {}): CommitGraduationPr => ({
    number: n,
    mergedAt: "2026-10-10T00:00:00Z",
    latestQaFixes: ["abcdef123456"],
    commitMessages: ["feat: x", A_MSG],
    ...over,
  });
  const base = (prs: CommitGraduationPr[], over: Partial<CommitGraduationInputs> = {}): CommitGraduationInputs => ({
    prs,
    until: "2026-11-13T00:00:00Z",
    pending: [],
    escapes: [],
    switches: { configured: "A", trip: "not-tripped" },
    ...over,
  });
  const many = (n: number) => Array.from({ length: n }, (_, i) => mk(100 + i));

  test("the threshold is 10", () => {
    assert.equal(GRADUATION_MIN_CLEAN_A, 10);
  });

  test("ten clean class-A fixes in stage A is ready", () => {
    const { report } = assessCommitGraduation(base(many(10)));
    assert.equal(report.state, "ready");
    assert.equal(report.ready, true);
    assert.equal(report.cleanA.count, 10);
  });

  test("nine is collecting", () => {
    assert.equal(assessCommitGraduation(base(many(9))).report.state, "collecting");
  });

  test("a PR with a QA-Fix: B commit is not a clean class-A fix", () => {
    const prs = [...many(9), mk(200, { commitMessages: [A_MSG, "fix: t\n\nQA-Fix: B"] })];
    const { report } = assessCommitGraduation(base(prs));
    assert.equal(report.cleanA.count, 9);
    assert.equal(report.excluded.notClassA, 1);
  });

  test("a PR whose trailer has no qa-fixes is not counted", () => {
    const prs = [...many(9), mk(200, { latestQaFixes: [] })];
    assert.equal(assessCommitGraduation(base(prs)).report.cleanA.count, 9);
  });

  test("pending, immature and escaped PRs are excluded", () => {
    const prs = [...many(7), mk(300), mk(301, { mergedAt: "2026-11-10T00:00:00Z" }), mk(302)];
    const { report } = assessCommitGraduation(base(prs, { pending: [300], escapes: [302] }));
    assert.equal(report.cleanA.count, 7);
    assert.deepEqual(report.excluded, { immature: 2, escaped: 1, notClassA: 0 });
  });

  test("tripped, not-in-a and already-a+b states", () => {
    assert.equal(assessCommitGraduation(base(many(10), { switches: { configured: "A", trip: "tripped" } })).report.state, "tripped");
    assert.equal(assessCommitGraduation(base(many(10), { switches: { configured: "off", trip: "not-tripped" } })).report.state, "not-in-a");
    assert.equal(assessCommitGraduation(base(many(10), { switches: { configured: "A+B", trip: "not-tripped" } })).report.state, "already-a+b");
  });

  test("malformed and duplicate rows warn and are skipped", () => {
    const { warnings, report } = assessCommitGraduation(
      base([...many(10), mk(100), { number: 0 } as unknown as CommitGraduationPr]),
    );
    assert.equal(warnings.length, 2);
    assert.equal(report.cleanA.count, 10);
  });

  test("the flip item files once, carries the marker, and never repeats", () => {
    const { report } = assessCommitGraduation(base(many(10)));
    const plan = planFlipItem(report, []);
    assert.equal(plan.file, true);
    if (plan.file) {
      assert.ok(plan.body.includes(FLIP_ITEM_MARKER));
      assert.deepEqual(plan.labels, ["ready-for-human"]);
    }
    const again = planFlipItem(report, [{ number: 9, title: "x", body: FLIP_ITEM_MARKER }]);
    assert.equal(again.file, false);
    assert.equal(planFlipItem(assessCommitGraduation(base(many(3))).report, []).file, false);
  });
});

describe("playbook step 9.4 class-B pins (INV-5, INV-6, INV-13)", () => {
  const start = PLAYBOOK.indexOf("### 9.4 Reviewer commit");
  const step94 = PLAYBOOK.slice(start, PLAYBOOK.indexOf("\n### ", start + 10));

  test("the step is retitled to cover classes A and B", () => {
    assert.ok(/### 9\.4 Reviewer commit \(class A\) and class B/.test(step94));
  });

  test("class B is a separate commit with its own trailer", () => {
    assert.ok(step94.includes('-m "QA-Fix: B"'));
    assert.ok(step94.includes('-m "QA-Fix: A"'));
    assert.ok(!/QA-Fix: A,? ?B|QA-Fix: AB/.test(step94), "never a combined trailer");
  });

  test("case-count-check runs before the class-B commit", () => {
    assert.ok(step94.includes("qa-commit-checks.ts\" case-count-check"));
    assert.ok(step94.indexOf("case-count-check") < step94.indexOf('-m "QA-Fix: B"'));
  });

  test("a class-B round runs exactly one proof, based on $FIXED_SHA", () => {
    const branch = step94.slice(
      step94.indexOf('[ "$RC_HAS_B" = 1 ]; then\n    node'),
      step94.indexOf("elif", step94.indexOf('[ "$RC_HAS_B" = 1 ]; then\n    node')),
    );
    assert.ok(branch.includes('--base "$FIXED_SHA" --head HEAD'));
    assert.ok(!branch.includes("$REVIEWED_HEAD"));
  });

  test("the qa-fixes list names every reviewer commit and still adds no force push", () => {
    assert.ok(step94.includes("RC_SHAS"));
    assert.ok(!/--force|force-with-lease/.test(step94.replace(/never force-push/g, "")));
    assert.ok(!/\+refs|\+HEAD/.test(step94));
  });

  test("step 9.5 splits the comma-separated qa-fixes into the trailer array", () => {
    const step95 = PLAYBOOK.slice(PLAYBOOK.indexOf("### 9.5 "), PLAYBOOK.indexOf("### 9.6 "));
    assert.ok(step95.includes('split(",")'));
  });
});

describe("commit graduation: harvest source (QA round 1 finding 1)", () => {
  const FIXTURE_UNTIL = Date.parse("2026-10-28T00:48:59Z");
  const DAY = 86_400_000;

  test("a PR merged after the fixture, whose escape window has closed, makes the fixture stale", () => {
    // Merged 2026-10-30, mature on 2026-11-13; the fixture (until 10-28) predates the whole window.
    assert.equal(escapeFixtureStale("2026-10-30T00:00:00Z", Date.parse("2026-11-20T00:00:00Z"), FIXTURE_UNTIL), true);
  });

  test("sibling shape: a PR whose window the fixture covers keeps the fixture usable", () => {
    assert.equal(escapeFixtureStale("2026-10-01T00:00:00Z", FIXTURE_UNTIL + DAY, FIXTURE_UNTIL), false);
  });

  test("sibling shape: an immature PR is never stale (the fold counts it as immature)", () => {
    assert.equal(escapeFixtureStale("2026-11-10T00:00:00Z", Date.parse("2026-11-13T00:00:00Z"), FIXTURE_UNTIL), false);
  });

  test("harvest no longer reads candidate PRs from the fixture", () => {
    const src = readFileSync(join(ROOT, "scripts", "qa", "commit-graduation.ts"), "utf8");
    assert.ok(!src.includes("fixture?.inputs?.prs"));
    assert.ok(!src.includes("fixture?.metrics?.pending"));
  });
});

describe("hydra-qa step 9.4: a reviewer-added new test file (QA round 1 finding 2)", () => {
  test("the case-count loop skips a file absent at the reviewed head instead of refusing the round", () => {
    assert.ok(/git cat-file -e "\$REVIEWED_HEAD:\$p"[^\n]*\|\| continue/.test(PLAYBOOK));
  });

  test("sibling shape: an existing file still fails closed when its before-copy cannot be read", () => {
    assert.ok(PLAYBOOK.includes('git show "$REVIEWED_HEAD:$p" > "$BEFORE_FILE" 2>/dev/null || { RC_OK=0;'));
  });
});
