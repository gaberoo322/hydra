/**
 * Regression tests for the CI mutation-gate diff scoping (issue #653).
 *
 * The mutation gate used to run mutation testing on the full source tree
 * for every PR — ~9 minutes wall time, the longest CI step. Issue #653
 * scoped it to the diff: only `src/**\/*.ts` files changed in the PR are
 * mutated, and PRs that don't touch any such file skip the gate entirely
 * (with a clear logged reason — never a silent pass).
 *
 * These tests exercise the pure file-filter helper in
 * `scripts/ci/mutation-check.ts`. They do NOT touch git, the filesystem,
 * or the mutation runner — that contract is what makes the filter
 * unit-testable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  filterMutationCandidates,
  selectKillFloor,
  classifyNoSignal,
  classifyTimedOut,
} from "../scripts/ci/mutation-check.ts";
import type { MutationTestReport } from "../src/mutation.ts";

/**
 * Build a MutationTestReport for the classifyNoSignal tests. Only the four
 * fields the helper reads (totalMutants, skipped, killed, candidatesGenerated)
 * are meaningful; the rest are inert placeholders.
 */
function makeReport(
  partial: Partial<MutationTestReport>,
): MutationTestReport {
  return {
    totalMutants: 0,
    killed: 0,
    survived: 0,
    skipped: 0,
    timedOut: false,
    durationMs: 0,
    survivors: [],
    candidatesGenerated: 0,
    ...partial,
  };
}

describe("filterMutationCandidates — diff scoping (issue #653)", () => {
  test("keeps src/**/*.ts files", () => {
    const result = filterMutationCandidates([
      "src/mutation.ts",
      "src/api/queue.ts",
      "src/redis/connection.ts",
    ]);
    assert.deepEqual(result.sort(), [
      "src/api/queue.ts",
      "src/mutation.ts",
      "src/redis/connection.ts",
    ]);
  });

  test("drops asset files (PNG, SVG, JSON fixtures)", () => {
    const result = filterMutationCandidates([
      "dashboard/public/sprites/pokemon/001-bulbasaur.png",
      "dashboard/public/sprites/pokemon/025-pikachu.png",
      "docs/diagrams/loop.svg",
      "test/fixtures/sample.json",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops markdown / docs / config", () => {
    const result = filterMutationCandidates([
      "README.md",
      "docs/reference.md",
      "docs/adr/0004-tiers.md",
      "config/direction/vision.md",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops dashboard tree (positive allowlist excludes dashboard/**)", () => {
    const result = filterMutationCandidates([
      "dashboard/src/App.jsx",
      "dashboard/src/pages/now-pixel/NowPixel.jsx",
      "dashboard/src/pages/now-pixel/derive-sprite-state.ts",
      "dashboard/package.json",
    ]);
    assert.deepEqual(
      result,
      [],
      "dashboard/**/*.ts must NOT be mutated — only the orchestrator src/ tree",
    );
  });

  test("drops test files even when nested under src/", () => {
    // SKIP_PATTERNS in src/mutation.ts excludes co-located tests — diff
    // scoping must not undo that.
    const result = filterMutationCandidates([
      "src/foo.test.ts",
      "src/foo.spec.ts",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops .d.ts declaration files", () => {
    const result = filterMutationCandidates([
      "src/types/foo.d.ts",
      "src/foo.d.ts",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops scripts/ — not in the src/ allowlist (issue #653)", () => {
    // Previously the gate would mutate scripts/ci/mutation-check.ts itself.
    // Per the issue, the mutation gate's contract is src/**/*.ts only.
    const result = filterMutationCandidates([
      "scripts/ci/mutation-check.ts",
      "scripts/tier-classify.ts",
      "scripts/deploy.sh",
    ]);
    assert.deepEqual(result, []);
  });

  test("drops .js, .jsx, .tsx, .mts (only .ts qualifies)", () => {
    const result = filterMutationCandidates([
      "src/foo.js",
      "src/foo.jsx",
      "src/foo.tsx",
      "src/foo.mts",
    ]);
    assert.deepEqual(result, []);
  });

  test("mixed diff returns ONLY the src/**/*.ts subset", () => {
    const result = filterMutationCandidates([
      "src/api/queue.ts",
      "src/foo.test.ts",
      "test/mutation-check.test.mts",
      "docs/quality-gates.md",
      "dashboard/src/App.jsx",
      ".github/workflows/ci.yml",
      "package.json",
      "src/redis/connection.ts",
    ]);
    assert.deepEqual(result.sort(), [
      "src/api/queue.ts",
      "src/redis/connection.ts",
    ]);
  });

  test("empty input → empty output (asset-only PR scenario)", () => {
    assert.deepEqual(filterMutationCandidates([]), []);
  });

  test("trims whitespace and drops empty lines (env-var split artefacts)", () => {
    // CHANGED_FILES arrives via newline-split env var; main() trims, but
    // the helper is also defensive so tests can pass realistic raw input.
    const result = filterMutationCandidates([
      "  src/api/queue.ts  ",
      "",
      "\t",
      "src/redis/connection.ts",
    ]);
    assert.deepEqual(result.sort(), [
      "src/api/queue.ts",
      "src/redis/connection.ts",
    ]);
  });

  test("asset-only PR (slice 1 of #642) collapses to empty — gate skips", () => {
    // Realistic scenario from PR #650: 151 PNG sprites + package.json
    // bumps + a build script. Zero src/**/*.ts files changed → the
    // mutation runner should never spin up. The wall-time win is ~9
    // minutes per such PR.
    const changedFiles = [
      "dashboard/package-lock.json",
      "dashboard/package.json",
      "dashboard/public/sprites/characters/ash-blonde.png",
      "dashboard/public/sprites/characters/oak.png",
      "dashboard/public/sprites/pokemon/001-bulbasaur.png",
      "dashboard/public/sprites/pokemon/025-pikachu.png",
      "dashboard/scripts/build-spritesheet.mjs",
    ];
    assert.deepEqual(
      filterMutationCandidates(changedFiles),
      [],
      "asset-only PRs must skip the mutation gate (issue #653)",
    );
  });

  test("code PR keeps only the src/**/*.ts files for diff-scoped mutation", () => {
    // Realistic scenario from PR #607: a schema refactor that touched a
    // mix of src/ files and a docs/test set. The gate now mutates the
    // 3-file src/ subset, not the entire orchestrator tree.
    const changedFiles = [
      "src/api/design-concepts.ts",
      "src/schemas/design-concepts.ts",
      "src/schemas/queue.ts",
      "test/design-concepts-router.test.mts",
      "test/schemas/design-concepts.test.mts",
      "docs/adr/0011-schemas-seam-for-http-request-bodies.md",
    ];
    assert.deepEqual(
      filterMutationCandidates(changedFiles).sort(),
      [
        "src/api/design-concepts.ts",
        "src/schemas/design-concepts.ts",
        "src/schemas/queue.ts",
      ],
      "diff-scoped mutation: mutate the src/ delta, skip test/docs",
    );
  });
});

describe("selectKillFloor — per-tier mutation floor (issue #778)", () => {
  const BASE = 30; // MUTATION_KILL_RATE_FLOOR default
  const T3 = 55; // MUTATION_KILL_RATE_FLOOR_T3 default

  test("T1 diffs use the base floor (no behavior change — AC#2)", () => {
    assert.equal(selectKillFloor(1, BASE, T3), 30);
  });

  test("T2 diffs use the base floor (no behavior change — AC#2)", () => {
    assert.equal(selectKillFloor(2, BASE, T3), 30);
  });

  test("T3 diffs use the raised T3 floor (AC#1)", () => {
    assert.equal(selectKillFloor(3, BASE, T3), 55);
  });

  test("T4 inherits the T3 floor — never below it (tier>=3 predicate)", () => {
    // ADR-0015 monotonic ladder: T4 inherits T3's verification depth.
    // A tier===3 predicate would wrongly relax the floor for Verifier-Core
    // diffs; the predicate must be tier>=3.
    assert.equal(selectKillFloor(4, BASE, T3), 55);
  });

  test("selection is pure + deterministic from the tier integer (AC#3)", () => {
    // Same inputs → same output, no per-path / side-channel influence.
    assert.equal(selectKillFloor(3, BASE, T3), selectKillFloor(3, BASE, T3));
    assert.equal(selectKillFloor(1, BASE, T3), selectKillFloor(1, BASE, T3));
  });

  test("floors are configurable, not magic — honours custom values", () => {
    // Operator could raise/lower either band via repo variables.
    assert.equal(selectKillFloor(2, 40, 70), 40);
    assert.equal(selectKillFloor(3, 40, 70), 70);
    assert.equal(selectKillFloor(4, 40, 70), 70);
  });

  test("missing / non-finite tier falls back to the conservative T3 band", () => {
    // A garbled or absent PR_TIER must NOT silently relax the floor.
    assert.equal(selectKillFloor(NaN, BASE, T3), 55);
    assert.equal(selectKillFloor(Number.POSITIVE_INFINITY, BASE, T3), 55);
  });

  test("tiers above 4 still resolve to the T3 band (defensive >= )", () => {
    // Should never happen (Tier is 1|2|3|4) but the predicate stays safe.
    assert.equal(selectKillFloor(5, BASE, T3), 55);
  });
});

describe("classifyNoSignal — no-testable-mutants gate (issue #1120)", () => {
  // The pre-#1120 bug: a diff where every generated mutant is skipped (or none
  // are generated) yielded testable===0 → synthetic killRate=100 → status:pass,
  // silently clearing the raised T3/T4 kill-floor with zero fault-detection.

  test("returns null when there IS testable signal (caller runs kill-rate)", () => {
    // 10 mutants, 2 skipped → testable=8 > 0 → not a no-signal case.
    const report = makeReport({ totalMutants: 10, skipped: 2, killed: 6 });
    assert.equal(classifyNoSignal(report, 3), null);
    assert.equal(classifyNoSignal(report, 1), null);
  });

  test("tier>=3 all-skipped → warn (NOT pass), null killRate, distinct reason (AC#1, AC#2)", () => {
    // totalMutants > 0 with skipped === totalMutants: every candidate
    // uncompilable. On a deep diff this is a real no-signal gap.
    const report = makeReport({
      totalMutants: 7,
      skipped: 7,
      candidatesGenerated: 7,
    });
    const result = classifyNoSignal(report, 3);
    assert.ok(result, "expected a classification for the all-skipped case");
    assert.equal(result.status, "warn");
    assert.notEqual(result.status, "pass" as unknown as string);
    assert.equal(result.killRate, null, "must NOT fabricate killRate=100");
    assert.match(result.reason, /all generated mutants were skipped/);
  });

  test("tier>=3 no-mutants-generated → warn with the candidatesGenerated===0 reason", () => {
    const report = makeReport({
      totalMutants: 0,
      skipped: 0,
      candidatesGenerated: 0,
    });
    const result = classifyNoSignal(report, 3);
    assert.ok(result);
    assert.equal(result.status, "warn");
    assert.equal(result.killRate, null);
    assert.match(result.reason, /no mutants generated/);
  });

  test("T4 (tier>=3) all-skipped → warn — never relaxes for Verifier-Core", () => {
    const report = makeReport({
      totalMutants: 4,
      skipped: 4,
      candidatesGenerated: 4,
    });
    const result = classifyNoSignal(report, 4);
    assert.ok(result);
    assert.equal(result.status, "warn");
    assert.equal(result.killRate, null);
  });

  test("T1 all-skipped → neutral (historical non-blocking behaviour preserved, AC#3)", () => {
    const report = makeReport({
      totalMutants: 5,
      skipped: 5,
      candidatesGenerated: 5,
    });
    const result = classifyNoSignal(report, 1);
    assert.ok(result);
    assert.equal(result.status, "neutral");
    assert.equal(result.killRate, null);
    assert.match(result.reason, /all generated mutants were skipped/);
  });

  test("T2 no-mutants-generated → neutral with the no-mutants reason", () => {
    const report = makeReport({
      totalMutants: 0,
      skipped: 0,
      candidatesGenerated: 0,
    });
    const result = classifyNoSignal(report, 2);
    assert.ok(result);
    assert.equal(result.status, "neutral");
    assert.equal(result.killRate, null);
    assert.match(result.reason, /no mutants generated/);
  });

  test("missing / non-finite tier classifies conservatively as warn (matches floor fallback)", () => {
    const report = makeReport({
      totalMutants: 3,
      skipped: 3,
      candidatesGenerated: 3,
    });
    assert.equal(classifyNoSignal(report, NaN)?.status, "warn");
    assert.equal(
      classifyNoSignal(report, Number.POSITIVE_INFINITY)?.status,
      "warn",
    );
  });

  test("all-killed (testable>0, killed===testable) is NOT a no-signal case → null", () => {
    // The existing all-killed path must still flow to the normal pass branch
    // (killRate=100) — classifyNoSignal must not intercept it (AC#4).
    const report = makeReport({
      totalMutants: 6,
      skipped: 0,
      killed: 6,
      candidatesGenerated: 6,
    });
    assert.equal(classifyNoSignal(report, 3), null);
    assert.equal(classifyNoSignal(report, 1), null);
  });
});

describe("classifyTimedOut — budget-exhausted partial verdict (issue #2393)", () => {
  // The pre-#2393 bug: the Orchestrator gate captured report.timedOut into the
  // summary JSON but NEVER branched on it — it computed killRate over only the
  // evaluated sample (e.g. 75 of 553) and emitted `pass` if that partial rate
  // cleared the floor, silently rubber-stamping a diff whose surviving mutants
  // land in the unevaluated tail. This mirrors the Target gate's shipped #1821
  // classifyTimedOut seam.

  test("returns null when the runner did NOT time out (caller runs kill-rate)", () => {
    // A complete run (timedOut:false) is not a timed-out case — the caller
    // proceeds to the normal kill-rate comparison.
    const report = makeReport({
      totalMutants: 10,
      skipped: 0,
      killed: 8,
      candidatesGenerated: 10,
      timedOut: false,
    });
    assert.equal(classifyTimedOut(report), null);
  });

  test("timed-out run → warn (NOT pass), informational partial killRate, distinct reason", () => {
    // The scanner.ts symptom: 75 of 553 candidate mutants run before the budget
    // expired, 57 killed of 75 testable → partial rate 76% — which would have
    // cleared a 60 floor and emitted a silent `pass` pre-fix.
    const report = makeReport({
      totalMutants: 75,
      skipped: 0,
      killed: 57,
      survived: 18,
      candidatesGenerated: 553,
      timedOut: true,
    });
    const result = classifyTimedOut(report);
    assert.ok(result, "expected a classification for the timed-out case");
    assert.equal(result.status, "warn");
    assert.notEqual(result.status, "pass" as unknown as string);
    assert.equal(result.timedOut, true);
    // 57/75 = 76% — surfaced for context, but it is informational only and is
    // NEVER compared against the kill floor.
    assert.equal(result.killRate, 76);
    assert.match(result.reason, /timed out before evaluating all mutants/);
    assert.match(result.reason, /75 of 553/);
    assert.match(result.reason, /non-blocking/);
  });

  test("timed out with zero testable signal → null killRate (no partial rate to report)", () => {
    // Budget exhausted before any mutant produced testable signal: all the
    // mutants that ran were skipped, so testable===0 and there is no partial
    // rate to surface — killRate is null, NOT a fabricated 100.
    const report = makeReport({
      totalMutants: 12,
      skipped: 12,
      killed: 0,
      candidatesGenerated: 400,
      timedOut: true,
    });
    const result = classifyTimedOut(report);
    assert.ok(result);
    assert.equal(result.status, "warn");
    assert.equal(result.killRate, null, "must NOT fabricate a kill rate");
    assert.match(result.reason, /partial kill rate n\/a/);
  });

  test("a timed-out run that WOULD clear the floor still warns (never synthesizes a pass)", () => {
    // 95% partial rate, well above any floor — the invariant is that this is
    // STILL a warn, never a pass: a partial sample above the floor is not proof
    // the full mutant set clears it.
    const report = makeReport({
      totalMutants: 40,
      skipped: 0,
      killed: 38,
      survived: 2,
      candidatesGenerated: 500,
      timedOut: true,
    });
    const result = classifyTimedOut(report);
    assert.ok(result);
    assert.equal(result.status, "warn");
    assert.equal(result.killRate, 95);
    assert.notEqual(result.status, "pass" as unknown as string);
  });

  test("timed-out classification is tier-independent (no tier parameter)", () => {
    // Unlike classifyNoSignal, classifyTimedOut takes no tier — a
    // budget-exhausted run has reached no verdict regardless of tier, so the
    // outcome is always warn. (Compile-time: the signature has arity 1.)
    assert.equal(classifyTimedOut.length, 1);
    const report = makeReport({
      totalMutants: 5,
      skipped: 0,
      killed: 3,
      candidatesGenerated: 200,
      timedOut: true,
    });
    assert.equal(classifyTimedOut(report)?.status, "warn");
  });
});
