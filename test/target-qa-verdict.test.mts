/**
 * Regression tests for the independent Target QA verdict logic
 * (issue #1055, parent epic #1052).
 *
 * Pins the depth-routing contract: safe Target changes get a single Standards
 * pass; money-critical changes (providers / execution / staking / bet-math)
 * additionally get a Spec pass and a 2-reviewer adversarial fold. A hard
 * finding from any consulted axis bounces the item to the reframe queue — no
 * deep-QA remediation loop, no operator escalation.
 *
 * Pure tests — no Redis, no network, no spawn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseQaVerdictTrailer } from "../scripts/ci/qa-verdict.ts";
import {
  buildTargetQaVerdictTrailer,
  classifyTargetQaPath as classifyPathRaw,
  classifyTargetQaVerdict as classifyVerdictRaw,
  type TargetReviewVerdicts,
} from "../scripts/target/target-qa-verdict.ts";
import {
  BETTING_RISK_SURFACE,
  BETTING_APP_SUBDIR,
} from "./_helpers/betting-risk-surface.mts";

// Issue #3018: the QA-path/verdict helpers now take the manifest-sourced risk
// surface as (optional) arguments. The tests pass the betting fixture
// explicitly so they stay hermetic. These wrappers preserve the existing call
// shapes below.
const classifyTargetQaPath = (changedPaths: readonly string[]) =>
  classifyPathRaw(changedPaths, BETTING_RISK_SURFACE, BETTING_APP_SUBDIR);
const classifyTargetQaVerdict = (
  changedPaths: readonly string[],
  verdicts: TargetReviewVerdicts,
) => classifyVerdictRaw(changedPaths, verdicts, BETTING_RISK_SURFACE, BETTING_APP_SUBDIR);

describe("classifyTargetQaPath — depth routing on the money-critical flag", () => {
  test("safe path for UI / docs / config changes", () => {
    const r = classifyTargetQaPath(["web/src/components/Button.tsx", "README.md"]);
    assert.equal(r.path, "safe");
    assert.equal(r.moneyCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("money-critical path when any provider path is touched", () => {
    const r = classifyTargetQaPath(["src/lib/providers/betfair.ts", "README.md"]);
    assert.equal(r.path, "money-critical");
    assert.equal(r.moneyCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/providers/betfair.ts"]);
  });

  test("money-critical path for execution / staking / bet-math", () => {
    assert.equal(classifyTargetQaPath(["src/lib/execution/place-bet.ts"]).path, "money-critical");
    assert.equal(classifyTargetQaPath(["src/lib/staking/kelly.ts"]).path, "money-critical");
    assert.equal(classifyTargetQaPath(["src/lib/bet-math/edge.ts"]).path, "money-critical");
  });

  test("empty change set is safe", () => {
    const r = classifyTargetQaPath([]);
    assert.equal(r.path, "safe");
    assert.equal(r.moneyCritical, false);
  });
});

describe("classifyTargetQaVerdict — safe path (Standards-only)", () => {
  const safeChanges = ["web/src/components/Button.tsx"];

  test("Standards PASS → merge", () => {
    const v = classifyTargetQaVerdict(safeChanges, { standards: "PASS" });
    assert.equal(v.verdict, "PASS");
    assert.equal(v.path, "safe");
    assert.equal(v.moneyCritical, false);
    assert.equal(v.action, "merge");
  });

  test("Standards FAIL → bounce-to-reframe", () => {
    const v = classifyTargetQaVerdict(safeChanges, { standards: "FAIL" });
    assert.equal(v.verdict, "FAIL");
    assert.equal(v.action, "bounce-to-reframe");
    assert.match(v.reason, /Standards/);
  });

  test("safe path ignores Spec / adversarial verdicts entirely", () => {
    // Even if money-critical-only reviewers are (spuriously) FAIL, the safe
    // path is governed by Standards alone.
    const v = classifyTargetQaVerdict(safeChanges, {
      standards: "PASS",
      spec: "FAIL",
      adversarialA: "FAIL",
      adversarialB: "FAIL",
    });
    assert.equal(v.verdict, "PASS");
    assert.equal(v.action, "merge");
  });
});

describe("classifyTargetQaVerdict — money-critical path (Standards + Spec + adversarial fold)", () => {
  const moneyChanges = ["src/lib/execution/place-bet.ts"];
  const allPass = {
    standards: "PASS",
    spec: "PASS",
    adversarialA: "PASS",
    adversarialB: "PASS",
  } as const;

  test("all four reviewers PASS → merge", () => {
    const v = classifyTargetQaVerdict(moneyChanges, allPass);
    assert.equal(v.verdict, "PASS");
    assert.equal(v.path, "money-critical");
    assert.equal(v.moneyCritical, true);
    assert.equal(v.action, "merge");
    assert.deepEqual(v.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("Standards FAIL short-circuits → bounce-to-reframe", () => {
    const v = classifyTargetQaVerdict(moneyChanges, { ...allPass, standards: "FAIL" });
    assert.equal(v.verdict, "FAIL");
    assert.equal(v.action, "bounce-to-reframe");
    assert.match(v.reason, /Standards/);
  });

  test("Spec FAIL → bounce-to-reframe", () => {
    const v = classifyTargetQaVerdict(moneyChanges, { ...allPass, spec: "FAIL" });
    assert.equal(v.verdict, "FAIL");
    assert.equal(v.action, "bounce-to-reframe");
    assert.match(v.reason, /Spec/);
  });

  test("a single adversarial FAIL (A) bounces — asymmetric fold", () => {
    const v = classifyTargetQaVerdict(moneyChanges, { ...allPass, adversarialA: "FAIL" });
    assert.equal(v.verdict, "FAIL");
    assert.match(v.reason, /adversarial reviewer A/);
  });

  test("a single adversarial FAIL (B) bounces", () => {
    const v = classifyTargetQaVerdict(moneyChanges, { ...allPass, adversarialB: "FAIL" });
    assert.equal(v.verdict, "FAIL");
    assert.match(v.reason, /adversarial reviewer B/);
  });

  test("both adversarial reviewers FAIL → both named in reason", () => {
    const v = classifyTargetQaVerdict(moneyChanges, {
      ...allPass,
      adversarialA: "FAIL",
      adversarialB: "FAIL",
    });
    assert.equal(v.verdict, "FAIL");
    assert.match(v.reason, /reviewer A/);
    assert.match(v.reason, /reviewer B/);
  });

  test("missing Spec verdict is treated as FAIL (defensive)", () => {
    const v = classifyTargetQaVerdict(moneyChanges, {
      standards: "PASS",
      adversarialA: "PASS",
      adversarialB: "PASS",
    });
    assert.equal(v.verdict, "FAIL");
    assert.equal(v.action, "bounce-to-reframe");
    assert.match(v.reason, /Spec verdict missing/);
  });

  test("missing adversarial verdicts are treated as FAIL (defensive)", () => {
    const v = classifyTargetQaVerdict(moneyChanges, { standards: "PASS", spec: "PASS" });
    assert.equal(v.verdict, "FAIL");
    assert.match(v.reason, /adversarial reviewer A verdict missing/);
    assert.match(v.reason, /adversarial reviewer B verdict missing/);
  });
});

describe("classifyTargetQaVerdict — invariants", () => {
  test("FAIL always routes to bounce-to-reframe, never to escalation", () => {
    // There is intentionally NO operator-escalation action in the type.
    const cases = [
      classifyTargetQaVerdict(["web/x.tsx"], { standards: "FAIL" }),
      classifyTargetQaVerdict(["src/lib/staking/k.ts"], {
        standards: "PASS",
        spec: "FAIL",
        adversarialA: "PASS",
        adversarialB: "PASS",
      }),
    ];
    for (const v of cases) {
      assert.equal(v.verdict, "FAIL");
      assert.equal(v.action, "bounce-to-reframe");
    }
  });

  test("PASS always routes to merge", () => {
    const v = classifyTargetQaVerdict(["docs/x.md"], { standards: "PASS" });
    assert.equal(v.action, "merge");
  });

  describe("QA-Verdict trailer (issue #4796)", () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";

    test("builder output parses with parseQaVerdictTrailer to the expected fields", () => {
      const line = buildTargetQaVerdictTrailer({
        verdict: "FAIL",
        pr: 42,
        headSha: SHA.toUpperCase(),
        blockers: 3,
        priorBodies: [],
      });
      assert.deepEqual(parseQaVerdictTrailer(line), {
        verdict: "FAIL",
        pr: 42,
        round: 1,
        sha: "0123456789ab",
        blockers: 3,
        maxSeverity: "high",
      });
    });

    test("PASS forces blockers=0 / none; FAIL floors blockers at 1 and renders high", () => {
      const pass = parseQaVerdictTrailer(
        buildTargetQaVerdictTrailer({ verdict: "PASS", pr: 7, headSha: SHA, blockers: 5, priorBodies: [] }),
      );
      assert.equal(pass?.verdict, "PASS");
      assert.equal(pass?.blockers, 0);
      assert.equal(pass?.maxSeverity, "none");
      const fail = parseQaVerdictTrailer(
        buildTargetQaVerdictTrailer({ verdict: "FAIL", pr: 7, headSha: SHA, blockers: 0, priorBodies: [] }),
      );
      assert.equal(fail?.blockers, 1);
      assert.equal(fail?.maxSeverity, "high");
    });

    test("round counts only prior trailers naming the same PR", () => {
      const mine = buildTargetQaVerdictTrailer({ verdict: "FAIL", pr: 9, headSha: SHA, blockers: 1, priorBodies: [] });
      const other = buildTargetQaVerdictTrailer({ verdict: "FAIL", pr: 10, headSha: SHA, blockers: 1, priorBodies: [] });
      const next = parseQaVerdictTrailer(
        buildTargetQaVerdictTrailer({
          verdict: "PASS",
          pr: 9,
          headSha: SHA,
          blockers: 0,
          priorBodies: [`human text\n\n${mine}`, other, null, undefined],
        }),
      );
      assert.equal(next?.round, 2);
    });

    test("an empty or non-hex headSha renders sha=unknown", () => {
      for (const headSha of ["", "not-a-sha"]) {
        const line = buildTargetQaVerdictTrailer({ verdict: "PASS", pr: 1, headSha, blockers: 0, priorBodies: [] });
        assert.match(line, / sha=unknown /);
      }
    });

    test("the fold exposes blockers: 0 on PASS, 1 on Standards FAIL, failing-axis count on risk-critical", () => {
      assert.equal(classifyTargetQaVerdict(["docs/x.md"], { standards: "PASS" }).blockers, 0);
      assert.equal(classifyTargetQaVerdict(["web/x.tsx"], { standards: "FAIL" }).blockers, 1);
      const v = classifyTargetQaVerdict(["src/lib/staking/k.ts"], {
        standards: "PASS",
        spec: "FAIL",
        adversarialA: "FAIL",
      });
      assert.equal(v.verdict, "FAIL");
      assert.equal(v.blockers, 3); // spec FAIL + adversarialA FAIL + adversarialB missing
    });

    test("playbook drift guard: names the builder, the grammar line, and both posts carry the trailer", () => {
      const md = readFileSync(
        resolve(import.meta.dirname, "..", "docs", "operator-playbooks", "hydra-target-qa.md"),
        "utf-8",
      );
      assert.ok(md.includes("buildTargetQaVerdictTrailer"));
      assert.ok(
        md.includes(
          "QA-Verdict: <PASS|FAIL> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high|none>",
        ),
      );
      const posts = md.split('gh issue comment "$ANCHOR_NUM"').slice(1);
      assert.equal(posts.length, 2, "expected exactly the PASS and FAIL posts");
      for (const post of posts) {
        const body = post.slice(0, post.indexOf("gh issue edit"));
        assert.ok(body.includes("QA_VERDICT_TRAILER"), "every verdict post must reference QA_VERDICT_TRAILER");
      }
    });
  });
});
