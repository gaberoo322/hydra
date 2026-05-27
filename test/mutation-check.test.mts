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
import { filterMutationCandidates } from "../scripts/ci/mutation-check.ts";

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
