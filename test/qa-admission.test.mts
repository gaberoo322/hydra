/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the admission phase — CI-check classification, the one-pass verdict classifier, the reviewer admission gate cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CheckState,
  type RawRollupEntry,
  buildCheckStates,
  classifyVerdict,
  decideReviewAdmission,
  redRequiredChecks,
  renderChecksBlock,
} from "../src/qa/admission.ts";
import {
  type FinalVerdict,
} from "../src/qa/verdict-trailer.ts";
import {
  decideDeepQaAction,
} from "../src/qa/round-action.ts";
import { decideAdmission } from "../src/qa/admission.ts";
import { isPromptOnlyChange } from "../src/qa/change-shape.ts";

describe("classifyVerdict — pending CI does not loop", () => {
  test("mutation-test QUEUED + other checks green → PASS-pending-CI (issue #405 AC)", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "dashboard-build", status: "completed", conclusion: "success", required: true },
      { name: "scope-check", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "queued", required: true },
    ];

    const r = classifyVerdict("PASS", checks);

    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 1);
    assert.equal(r.summary.requiredFailed, 0);
    assert.equal(r.summary.passed, 4);
    assert.match(r.reason, /mutation-test/);
    // The result MUST include a checks block listing every check by name.
    const names = r.checks.map((c) => c.name);
    assert.deepEqual(
      names.sort(),
      ["dashboard-build", "mutation-test", "scope-check", "tests", "typecheck"],
    );
  });

  test("mutation-test in_progress + others green → PASS-pending-CI", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "in_progress", required: true },
    ];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS-pending-CI");
  });

  test("all required checks green → PASS (no pending tier)", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "completed", conclusion: "success", required: true },
    ];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.summary.pending, 0);
  });

  test("review FAIL overrides everything — even with pending CI", () => {
    const checks: CheckState[] = [
      { name: "tests", status: "queued", required: true },
    ];
    const r = classifyVerdict("FAIL", checks);
    assert.equal(r.verdict, "FAIL");
    assert.match(r.reason, /review/i);
  });

  test("required check failed → FAIL even if review PASS", () => {
    const checks: CheckState[] = [
      { name: "typecheck", status: "completed", conclusion: "success", required: true },
      { name: "tests", status: "completed", conclusion: "failure", required: true },
    ];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "FAIL");
    assert.match(r.reason, /tests/);
  });

  test("required failed beats required pending", () => {
    const checks: CheckState[] = [
      { name: "tests", status: "completed", conclusion: "failure", required: true },
      { name: "mutation-test", status: "queued", required: true },
    ];
    assert.equal(classifyVerdict("PASS", checks).verdict, "FAIL");
  });

  test("skipped and neutral conclusions count as success", () => {
    const checks: CheckState[] = [
      { name: "lint", status: "completed", conclusion: "skipped", required: true },
      { name: "deploy-preview", status: "completed", conclusion: "neutral", required: false },
    ];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS");
  });

  test("only optional check pending, no required failures → PASS-pending-CI", () => {
    // Documents the behaviour: classifier never returns PASS while any check
    // is unresolved, even if it's optional. The verdict body explains.
    const checks: CheckState[] = [
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "preview-deploy", status: "in_progress", required: false },
    ];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 0);
    assert.equal(r.summary.pending, 1);
  });

  test("zero checks reported → PASS when review PASS", () => {
    const r = classifyVerdict("PASS", []);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.summary.total, 0);
  });

  test("zero checks reported → FAIL when review FAIL", () => {
    assert.equal(classifyVerdict("FAIL", []).verdict, "FAIL");
  });

  test("cancelled / timed_out are treated as failures", () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale", "startup_failure"] as const) {
      const checks: CheckState[] = [
        { name: "build", status: "completed", conclusion, required: true },
      ];
      assert.equal(
        classifyVerdict("PASS", checks).verdict,
        "FAIL",
        `${conclusion} should map to FAIL`,
      );
    }
  });

  test("classifier never blocks/awaits — pure synchronous return", () => {
    // Trivial: if classifyVerdict ever became async we'd have to await it,
    // and the test runner would surface that. This test exists so that
    // future changes that make the function async fail loudly here first
    // before breaking the live skill.
    const r = classifyVerdict("PASS", [
      { name: "x", status: "queued", required: true },
    ]);
    assert.equal(typeof r, "object");
    assert.equal((r as { then?: unknown }).then, undefined);
  });
});

describe("classifyVerdict — case-insensitive GitHub enum casing (issue #761)", () => {
  // GitHub's GraphQL API (surfaced by `gh pr view --json statusCheckRollup`)
  // returns status/conclusion as UPPERCASE enums. Before #761 the classifier
  // matched only lowercase tokens, so an uppercase QUEUED check fell through
  // every guard to a false-green PASS — which could let auto-merge approve a
  // PR before CI ran. The classifier now folds casing at its boundary
  // (defense in depth; the playbook also ascii_downcases).

  test("UPPERCASE QUEUED required check → PASS-pending-CI, NOT a false-green PASS", () => {
    const checks = [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "mutation-test", status: "QUEUED", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 1);
    assert.equal(r.summary.passed, 2);
    assert.match(r.reason, /mutation-test/);
  });

  test("UPPERCASE IN_PROGRESS folds to pending", () => {
    const checks = [
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "mutation-test", status: "IN_PROGRESS", required: true },
    ] as unknown as CheckState[];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS-pending-CI");
  });

  test("all UPPERCASE COMPLETED/SUCCESS → PASS", () => {
    const checks = [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS");
    assert.equal(r.summary.pending, 0);
    assert.equal(r.summary.passed, 2);
  });

  test("UPPERCASE FAILURE conclusion on a required check → FAIL", () => {
    const checks = [
      { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "tests", status: "COMPLETED", conclusion: "FAILURE", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "FAIL");
    assert.match(r.reason, /tests/);
  });

  test("UPPERCASE SKIPPED / NEUTRAL conclusions count as success", () => {
    const checks = [
      { name: "lint", status: "COMPLETED", conclusion: "SKIPPED", required: true },
      { name: "preview", status: "COMPLETED", conclusion: "NEUTRAL", required: false },
    ] as unknown as CheckState[];
    assert.equal(classifyVerdict("PASS", checks).verdict, "PASS");
  });

  test("mixed casing (real-world gh output) classifies correctly", () => {
    // gh sometimes mixes CheckRun (UPPERCASE) and StatusContext rows.
    const checks = [
      { name: "ci", status: "COMPLETED", conclusion: "success", required: true },
      { name: "mutation-test", status: "queued", required: true },
      { name: "scope-check", status: "Completed", conclusion: "Success", required: true },
    ] as unknown as CheckState[];
    const r = classifyVerdict("PASS", checks);
    assert.equal(r.verdict, "PASS-pending-CI");
    assert.equal(r.summary.requiredPending, 1);
    assert.equal(r.summary.passed, 2);
  });

  test("rendered checks block normalises UPPERCASE tokens to lowercase-canonical", () => {
    const checks = [
      { name: "tests", status: "COMPLETED", conclusion: "SUCCESS", required: true },
      { name: "mutation-test", status: "QUEUED", required: true },
    ] as unknown as CheckState[];
    const md = renderChecksBlock(classifyVerdict("PASS", checks));
    assert.match(md, /\| tests \| completed \| success \| yes \|/);
    assert.match(md, /\| mutation-test \| queued \| — \| yes \|/);
  });
});

describe("renderChecksBlock", () => {
  test("produces a markdown table with stable column order", () => {
    const r = classifyVerdict("PASS", [
      { name: "tests", status: "completed", conclusion: "success", required: true },
      { name: "mutation-test", status: "queued", required: true },
    ]);
    const md = renderChecksBlock(r);
    assert.match(md, /\| Check \| Status \| Conclusion \| Required \|/);
    assert.match(md, /\| tests \| completed \| success \| yes \|/);
    assert.match(md, /\| mutation-test \| queued \| — \| yes \|/);
  });

  test("zero checks → human-readable fallback string", () => {
    const r = classifyVerdict("PASS", []);
    assert.match(renderChecksBlock(r), /No CI checks/i);
  });
});

describe("decideReviewAdmission — reviewer admission gate (issue #3815)", () => {
  // The T3/T4 fan-out is the second-largest token consumer in the system. The
  // admission gate skips it ONLY when a reviewer's output provably cannot change
  // the emitted verdict under the CURRENT fold (INV-A — the gate is a derivation
  // of the fold, not an independent policy). Two conditions are verdict-invariant
  // today: a merge conflict (DIRTY — the diff won't merge) and a required check
  // already failed (classifyVerdict returns FAIL regardless of reviewVerdict).
  // T4 is only ever DEFERRED, never depth-reduced (INV-B). Unknown tier/merge
  // state fail-closed to full depth (INV-E). These tests pin each invariant as an
  // executable property so a future fold change that breaks the derivation fails
  // loudly here, in the same PR (INV-A's "re-derived in the same PR" clause).

  const green: CheckState[] = [
    { name: "typecheck", status: "completed", conclusion: "success", required: true },
    { name: "tests", status: "completed", conclusion: "success", required: true },
  ];
  const reqFailed: CheckState[] = [
    { name: "typecheck", status: "completed", conclusion: "success", required: true },
    { name: "tests", status: "completed", conclusion: "failure", required: true },
  ];
  const reqPending: CheckState[] = [
    { name: "typecheck", status: "completed", conclusion: "success", required: true },
    { name: "mutation-test", status: "queued", required: true },
  ];

  test("INV-A: skip-required-failed fires ONLY where classifyVerdict is FAIL for BOTH review verdicts", () => {
    // The defining property: wherever the gate declines to spawn reviewers on a
    // failed required check, the classifier must return the same verdict whether
    // the (un-run) review would have passed or failed — otherwise the gate would
    // be skipping a load-bearing review. Enumerate representative check sets.
    const cases: CheckState[][] = [
      green,
      reqFailed,
      reqPending,
      [{ name: "tests", status: "completed", conclusion: "failure", required: true }],
      [{ name: "tests", status: "completed", conclusion: "timed_out", required: true }],
      [],
    ];
    for (const checks of cases) {
      const d = decideReviewAdmission({ checks, mergeStateStatus: "CLEAN", tier: 3 });
      const ifReviewPass = classifyVerdict("PASS", checks).verdict;
      const ifReviewFail = classifyVerdict("FAIL", checks).verdict;
      if (d.action === "skip-required-failed") {
        // Skipped ⇒ review is moot ⇒ both review verdicts yield the same result.
        assert.equal(ifReviewPass, "FAIL", "gate skipped but PASS-review was not a forced FAIL");
        assert.equal(ifReviewFail, "FAIL");
        assert.equal(d.verdict, "FAIL");
      } else {
        // Not skipped ⇒ the review CAN matter ⇒ it is NOT the case that both
        // review verdicts are forced to FAIL. (Equivalently: the gate skips in
        // exactly the cases this property says it may.)
        assert.ok(
          !(ifReviewPass === "FAIL" && ifReviewFail === "FAIL"),
          "gate failed to skip a verdict that is FAIL regardless of the review",
        );
      }
    }
  });

  test("clean green T3 PR is admitted (the common path — full fan-out runs)", () => {
    const d = decideReviewAdmission({ checks: green, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(d.action, "admit");
    assert.equal(d.verdict, undefined);
  });

  test("pending required check with NO failure is admitted (review may still change PASS-pending-CI)", () => {
    // BLOCKED with a pending required check → classifyVerdict returns
    // PASS-pending-CI, which still needs a real review input. Skipping here
    // would fabricate a verdict. (The issue's rejected BLOCKED trigger.)
    const d = decideReviewAdmission({ checks: reqPending, mergeStateStatus: "BLOCKED", tier: 3 });
    assert.equal(d.action, "admit");
  });

  test("required check failed, T3 → skip-required-failed carrying FAIL (no PASS)", () => {
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(d.action, "skip-required-failed");
    assert.equal(d.verdict, "FAIL"); // a skipped review never yields PASS (INV-D)
  });

  test("INV-B: required check failed, T4 → DEFER (T4 is only ever deferred, never FAIL-skipped)", () => {
    // The deep-QA routing needs a real review verdict; skipping the fan-out would
    // leave none. So a T4 PR with a failed required check is deferred until CI
    // concludes, then the full Verifier-Core fan-out runs — depth is unchanged.
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "CLEAN", tier: 4 });
    assert.equal(d.action, "defer");
    assert.equal(d.verdict, undefined); // never a verdict for T4 — never depth-reduced
  });

  test("INV-B: DIRTY merge conflict is a DEFER for every tier, including T4", () => {
    for (const tier of [1, 2, 3, 4]) {
      const d = decideReviewAdmission({ checks: green, mergeStateStatus: "DIRTY", tier });
      assert.equal(d.action, "defer", `tier ${tier}`);
      assert.equal(d.verdict, undefined, `tier ${tier} must not carry a verdict`);
    }
  });

  test("DIRTY takes precedence over a failed required check (the diff won't merge either way)", () => {
    // A FAIL verdict over a conflicting diff is moot — the diff changes on
    // rebase — so defer to the rebase rather than emit FAIL.
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "DIRTY", tier: 3 });
    assert.equal(d.action, "defer");
  });

  test("BLOCKED and BEHIND are NOT defer triggers (only DIRTY is verdict-invariant)", () => {
    // BLOCKED covers pending required checks (review matters); BEHIND auto-rebases.
    for (const ms of ["BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS"]) {
      const d = decideReviewAdmission({ checks: green, mergeStateStatus: ms, tier: 3 });
      assert.equal(d.action, "admit", `${ms} should admit a clean PR`);
    }
  });

  test("INV-E: unreachable tier classifier (null) → admit (fail-closed to full depth)", () => {
    // Even with a failed required check — unknown tier means we cannot confirm
    // it isn't T4, so fail-closed runs the full fan-out. Mirrors the playbook's
    // existing ADVERSARIAL=1-on-empty-PR_TIER default.
    const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: "CLEAN", tier: null });
    assert.equal(d.action, "admit");
  });

  test("INV-E: unknown / empty mergeStateStatus → admit (fail-closed to full depth)", () => {
    for (const ms of ["", "UNKNOWN", "   "]) {
      const d = decideReviewAdmission({ checks: reqFailed, mergeStateStatus: ms, tier: 3 });
      assert.equal(d.action, "admit", `mergeStateStatus ${JSON.stringify(ms)} should fail-closed to admit`);
    }
  });

  test("UPPERCASE / lowercase mergeStateStatus fold identically (defense in depth)", () => {
    assert.equal(
      decideReviewAdmission({ checks: green, mergeStateStatus: "dirty", tier: 3 }).action,
      "defer",
    );
    assert.equal(
      decideReviewAdmission({ checks: green, mergeStateStatus: "Dirty", tier: 3 }).action,
      "defer",
    );
  });

  test("zero checks reported → admit (a PR with no CI signal is reviewed, not skipped)", () => {
    const d = decideReviewAdmission({ checks: [], mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(d.action, "admit");
  });

  test("decision is a pure synchronous return — never blocks", () => {
    const r = decideReviewAdmission({ checks: green, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(typeof r, "object");
    assert.equal((r as { then?: unknown }).then, undefined);
  });

  test("the admission gate introduces no new FinalVerdict literal (INV-D)", () => {
    // A skipped review never yields PASS; the only verdict the gate ever carries
    // is the FAIL the fold already determined. classifyVerdict / aggregate /
    // decideDeepQaAction semantics are untouched — the gate only declines to
    // spawn moot reviewers.
    for (const tier of [1, 2, 3, 4]) {
      for (const checks of [green, reqFailed, reqPending]) {
        for (const ms of ["CLEAN", "DIRTY", "BLOCKED"]) {
          const d = decideReviewAdmission({ checks, mergeStateStatus: ms, tier });
          assert.ok(
            d.verdict === undefined || d.verdict === "FAIL",
            `gate must never carry a non-FAIL verdict (got ${d.verdict} for tier ${tier} ${ms})`,
          );
        }
      }
    }
  });
});

describe("verdict tiers documentation", () => {
  test("all four verdict tiers are reachable from classifyVerdict", () => {
    // Belt-and-braces: confirms the skill's documented tiers are not just
    // prose — every one is exercised by at least one classifier path.
    const pass = classifyVerdict("PASS", [
      { name: "a", status: "completed", conclusion: "success", required: true },
    ]).verdict;
    const fail = classifyVerdict("FAIL", []).verdict;
    const passPending = classifyVerdict("PASS", [
      { name: "a", status: "queued", required: true },
    ]).verdict;
    // FAIL-pending-CI is currently a reserved tier — documented for
    // operator playbook use even though the classifier folds it into the
    // PASS-pending-CI / FAIL paths today. Assert the type allows it.
    const reserved: import("../src/qa/verdict-trailer.ts").FinalVerdict = "FAIL-pending-CI";

    assert.equal(pass, "PASS");
    assert.equal(fail, "FAIL");
    assert.equal(passPending, "PASS-pending-CI");
    assert.equal(reserved, "FAIL-pending-CI");
  });
});

describe("buildCheckStates — required-ness joined from branch protection, not the rollup (issue #4757)", () => {
  /** The live protected contexts (gh api .../required_status_checks on master). */
  const CONTEXTS = ["test", "dashboard-build", "tier-gate", "mutation-test", "scope-check", "secret-scan", "deep-qa-gate", "design-concept-reconcile"];
  const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pr-4754-status-check-rollup.json");
  const FIXTURE_RAW = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { statusCheckRollup: RawRollupEntry[] };
  const FIXTURE = FIXTURE_RAW.statusCheckRollup;

  test("the recorded live fixture is the real rollup shape: no required-ness key at any depth, both row kinds, a duplicate name", () => {
    // Recursive key scan: the #4757 bug is that the rollup carries NO
    // required-ness field, so the fixture must never grow one either (a
    // hand-built `required: true` fixture is exactly what hid the bug).
    const keys = (v: unknown): string[] =>
      typeof v !== "object" || v === null
        ? []
        : Object.entries(v).flatMap(([k, val]) => [k, ...keys(val)]);
    assert.ok(!keys(FIXTURE_RAW).includes("isRequired"), "the live rollup carries no required-ness field (the #4757 bug)");
    const types = new Set(FIXTURE.map((e) => e.__typename));
    assert.ok(types.has("CheckRun") && types.has("StatusContext"), "fixture must pin BOTH live row kinds");
    assert.ok(
      FIXTURE.filter((e) => (e.name ?? e.context) === "deep-qa-gate").length >= 2,
      "fixture must pin the live duplicate-name pathology (re-runs leave stale rows)",
    );
  });

  test("marks exactly the branch-protection contexts required:true and every advisory check required:false", () => {
    const states = buildCheckStates(FIXTURE, CONTEXTS);
    for (const s of states) {
      assert.equal(s.required, CONTEXTS.includes(s.name), `${s.name} required=${s.required}`);
      // Output shape: exactly the pre-#4757 CHECKS_JSON contract — no new keys.
      assert.deepEqual(Object.keys(s).sort(), ["conclusion", "name", "required", "status"], `${s.name} keys`);
    }
    assert.equal(states.filter((s) => s.required).length, CONTEXTS.length);
    // The fixture rollup names all 8 required contexts, so nothing is synthesized.
    assert.equal(states.length, new Set(FIXTURE.map((e) => e.name ?? e.context).filter(Boolean)).size);
  });

  test("dedup keeps the LATEST entry per name (fixture's triple deep-qa-gate folds to one; stale CANCELLED loses to fresh FAILURE)", () => {
    const states = buildCheckStates(FIXTURE, CONTEXTS);
    const dqa = states.filter((s) => s.name === "deep-qa-gate");
    assert.equal(dqa.length, 1);
    assert.deepEqual(dqa[0], { name: "deep-qa-gate", status: "completed", conclusion: "success", required: true });

    const pair = (a: string, b: string) =>
      buildCheckStates(
        [
          { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: a, startedAt: "2026-01-01T00:00:00Z" },
          { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: b, startedAt: "2026-01-02T00:00:00Z" },
        ],
        [],
      );
    assert.equal(pair("CANCELLED", "FAILURE")[0].conclusion, "failure", "greatest startedAt wins");
    assert.equal(pair("FAILURE", "CANCELLED")[0].conclusion, "cancelled", "…even when the stale row is listed second");
    // Equal startedAt → later list index wins.
    const tie = buildCheckStates(
      [
        { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-01-01T00:00:00Z" },
        { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-01-01T00:00:00Z" },
      ],
      [],
    );
    assert.equal(tie[0].conclusion, "failure", "a startedAt tie falls to the later list index");
  });

  test("a queued / unstamped row is never shadowed by a stale completed SUCCESS — both list orders, same-kind and cross-kind (#4757 QA round 1)", () => {
    const stale = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" };
    const queued = { __typename: "CheckRun", name: "test", status: "QUEUED", conclusion: null };
    const staleCtx = { __typename: "StatusContext", context: "test", state: "SUCCESS", createdAt: "2026-01-01T00:00:00Z" };
    const pendingCtx = { __typename: "StatusContext", context: "test", state: "PENDING" };
    const cases: Array<[string, Record<string, unknown>[]]> = [
      ["same-kind queued last", [stale, queued]],
      ["same-kind queued first", [queued, stale]],
      ["cross-kind pending ctx last", [stale, pendingCtx]],
      ["cross-kind pending ctx first", [pendingCtx, stale]],
      ["cross-kind queued run vs stale ctx, queued first", [queued, staleCtx]],
      ["cross-kind queued run vs stale ctx, queued last", [staleCtx, queued]],
      ["cross-kind pending ctx vs stale run, ctx first", [pendingCtx, staleCtx]],
    ];
    for (const [label, rows] of cases) {
      const [s] = buildCheckStates(rows, ["test"]);
      assert.equal(s.status === "completed" && s.conclusion === "success", false, `${label}: must not read PASS`);
      assert.equal(s.required, true, label);
    }
    // An unstamped completed row listed later still beats an older stamped row (index fallback).
    const [a] = buildCheckStates([stale, { ...stale, conclusion: "FAILURE", startedAt: undefined }], []);
    assert.equal(a.conclusion, "failure");
  });

  test("StatusContext rows fold by commit-status state", () => {
    const fold = (state: string) =>
      buildCheckStates([{ __typename: "StatusContext", context: `sc-${state}`, state, startedAt: "2026-01-01T00:00:00Z" }], [])[0];
    assert.deepEqual(fold("SUCCESS"), { name: "sc-SUCCESS", status: "completed", conclusion: "success", required: false });
    assert.deepEqual(fold("PENDING"), { name: "sc-PENDING", status: "pending", conclusion: null, required: false });
    assert.deepEqual(fold("EXPECTED"), { name: "sc-EXPECTED", status: "pending", conclusion: null, required: false });
    assert.deepEqual(fold("FAILURE"), { name: "sc-FAILURE", status: "completed", conclusion: "failure", required: false });
    assert.deepEqual(fold("ERROR"), { name: "sc-ERROR", status: "completed", conclusion: "failure", required: false });
    assert.deepEqual(fold("SOMETHING_NEW"), { name: "sc-SOMETHING_NEW", status: "pending", conclusion: null, required: false }, "unknown state reads pending, not guessed");
  });

  test("a required context absent from the rollup is synthesized as pending, never invisible", () => {
    assert.deepEqual(buildCheckStates([], ["late-gate"]), [
      { name: "late-gate", status: "pending", conclusion: null, required: true },
    ]);
  });

  test("nameless rows are skipped; CheckRun enums fold to lowercase-canonical (#761)", () => {
    const states = buildCheckStates(
      [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" }, // no name/context — noise
        { __typename: "CheckRun", name: "casing", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-01-01T00:00:00Z" },
        { name: "minimal", status: "COMPLETED", conclusion: "SUCCESS" }, // no startedAt, no __typename
      ],
      [],
    );
    assert.equal(states.length, 2, "the nameless row is skipped");
    assert.deepEqual(states[0], { name: "casing", status: "in_progress", conclusion: null, required: false });
    assert.deepEqual(states[1], { name: "minimal", status: "completed", conclusion: "success", required: false });
  });

  test("end-to-end against the classifier: fixture + live contexts chain to a clean PASS", () => {
    const states = buildCheckStates(FIXTURE, CONTEXTS);
    assert.deepEqual(redRequiredChecks(states), []);
    const r = classifyVerdict("PASS", states);
    assert.equal(r.summary.requiredPending, 0);
    assert.equal(r.summary.requiredFailed, 0);
  });
});

describe("decideAdmission — the composed admission head (issue #5079, INV-3)", () => {
  const green: CheckState[] = [
    { name: "test", status: "completed", conclusion: "success", required: true },
  ];
  const red: CheckState[] = [
    { name: "test", status: "completed", conclusion: "failure", required: true },
  ];

  test("composes prompt-only + admission + red-required exactly as the helpers do", () => {
    const input = { checks: red, mergeStateStatus: "CLEAN", tier: 3, changedPaths: ["docs/x.md"] };
    const r = decideAdmission(input);
    assert.equal(r.promptOnly, isPromptOnlyChange(input.changedPaths));
    assert.deepEqual(r.admission, decideReviewAdmission(input));
    assert.deepEqual(r.redRequired, redRequiredChecks(red));
  });

  test("a red required check yields the skip path with the classifier's FAIL result", () => {
    const r = decideAdmission({ checks: red, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(r.admission.action, "skip-required-failed");
    assert.deepEqual(r.skipVerdict, classifyVerdict("FAIL", red));
    assert.equal(r.skipVerdict?.verdict, "FAIL");
  });

  test("an admitted review carries no skip verdict, and absent changedPaths is not prompt-only", () => {
    const r = decideAdmission({ checks: green, mergeStateStatus: "CLEAN", tier: 3 });
    assert.equal(r.admission.action, "admit");
    assert.equal(r.skipVerdict, null);
    assert.equal(r.promptOnly, false);
    assert.deepEqual(r.redRequired, []);
  });
});
