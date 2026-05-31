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
import { filterMutationCandidates, selectKillFloor } from "../scripts/ci/mutation-check.ts";

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
