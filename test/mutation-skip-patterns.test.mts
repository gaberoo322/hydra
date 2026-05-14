/**
 * Regression tests for mutation gate SKIP_PATTERNS (issue #402).
 *
 * Bug: PR #401 (a docs-only PR for the codex-removal epic) failed the CI
 * mutation gate with an 11% kill rate. Every "survivor" was on a `.md` file —
 * the `swap-comparison` mutator was matching `<` / `>` characters in
 * documentation prose (e.g. `≥14 days`, code-block snippets, hostnames) and
 * those mutants always "survived" because no test reads markdown.
 *
 * Fix: extend `SKIP_PATTERNS` in `src/mutation.ts` to also skip:
 *   - `*.md` / `*.mdx`
 *   - `docs/**` (any depth)
 *   - `config/**` (any depth)
 *
 * And surface a clear "no inspectable source files" pass reason from the
 * CI wrapper when the filter removes everything.
 *
 * These are pure tests — no Redis, no filesystem, no agent calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipMutation, SKIP_PATTERNS } from "../src/mutation.ts";

describe("mutation SKIP_PATTERNS — docs / config / markdown (issue #402)", () => {
  test("skips top-level markdown files", () => {
    assert.equal(shouldSkipMutation("README.md"), true);
    assert.equal(shouldSkipMutation("CONTEXT.md"), true);
    assert.equal(shouldSkipMutation("AGENTS.md"), true);
  });

  test("skips markdown files nested in any directory", () => {
    assert.equal(shouldSkipMutation("docs/reference.md"), true);
    assert.equal(
      shouldSkipMutation("docs/historical/agent-personalities/agents/planner.md"),
      true,
    );
    assert.equal(shouldSkipMutation("src/some-component/NOTES.md"), true);
  });

  test("skips .mdx files (defensive — none in tree yet)", () => {
    assert.equal(shouldSkipMutation("docs/example.mdx"), true);
    assert.equal(shouldSkipMutation("README.mdx"), true);
  });

  test("skips anything under docs/", () => {
    assert.equal(shouldSkipMutation("docs/adr/0004-tiers.md"), true);
    // Non-markdown files in docs/ are also doc artefacts (diagrams, examples).
    assert.equal(shouldSkipMutation("docs/diagrams/loop.svg"), true);
    assert.equal(shouldSkipMutation("docs/examples/sample.json"), true);
  });

  test("skips anything under config/", () => {
    assert.equal(shouldSkipMutation("config/direction/vision.md"), true);
    assert.equal(shouldSkipMutation("config/direction/outcomes.yaml"), true);
    assert.equal(shouldSkipMutation("config/agents/planner.md"), true);
    assert.equal(shouldSkipMutation("config/feedback/to-executor.md"), true);
  });

  test("does NOT skip source TypeScript files (gate still runs on src/)", () => {
    assert.equal(shouldSkipMutation("src/mutation.ts"), false);
    assert.equal(shouldSkipMutation("src/control-loop.ts"), false);
    assert.equal(shouldSkipMutation("src/anchor-selection.ts"), false);
    assert.equal(shouldSkipMutation("scripts/ci/mutation-check.ts"), false);
  });

  test("does NOT skip docs-like names that aren't in docs/ or config/ and aren't .md", () => {
    // A source file that happens to have 'docs' or 'config' in its basename
    // but not as a directory prefix must still be mutated. The pattern is
    // anchored to `(^|/)docs/` so substrings don't match.
    assert.equal(shouldSkipMutation("src/docs-indexer.ts"), false);
    assert.equal(shouldSkipMutation("src/configure-runtime.ts"), false);
  });

  test("preserves pre-existing skips (regression guard)", () => {
    assert.equal(shouldSkipMutation("src/foo.test.ts"), true);
    assert.equal(shouldSkipMutation("src/foo.spec.tsx"), true);
    assert.equal(shouldSkipMutation("vitest.config.ts"), true);
    assert.equal(shouldSkipMutation("types/foo.d.ts"), true);
    assert.equal(shouldSkipMutation("drizzle/0001.sql"), true);
    assert.equal(shouldSkipMutation("migrations/0001-init.ts"), true);
    assert.equal(shouldSkipMutation("__mocks__/redis.ts"), true);
    assert.equal(shouldSkipMutation("node_modules/foo/index.js"), true);
  });

  test("SKIP_PATTERNS contains the new docs/config/markdown regexes", () => {
    // Snapshot guard: if someone removes the new patterns in a future refactor,
    // this test points back to issue #402.
    const sources = SKIP_PATTERNS.map((r) => r.source);
    assert.ok(
      sources.some((s) => s.includes("md")),
      "expected a markdown pattern in SKIP_PATTERNS (issue #402)",
    );
    assert.ok(
      sources.some((s) => s.includes("docs")),
      "expected a docs/ pattern in SKIP_PATTERNS (issue #402)",
    );
    assert.ok(
      sources.some((s) => s.includes("config")),
      "expected a config/ pattern in SKIP_PATTERNS (issue #402)",
    );
  });
});

describe("mutation gate — docs-only changeset has zero inspectable files (issue #402)", () => {
  test("a .md-only changeset filters to empty inspectable list", () => {
    // This is the PR #401 scenario: only markdown files changed. After the
    // SKIP_PATTERNS extension, the CI wrapper's pre-filter (mirrored here)
    // should reduce the list to zero — which the wrapper turns into a
    // "no inspectable source files" pass instead of generating mutants on
    // prose.
    const changedFiles = [
      "docs/reference.md",
      "docs/historical/agent-personalities/agents/planner.md",
      "docs/historical/agent-personalities/agents/skeptic.md",
      "README.md",
      "CONTEXT.md",
    ];
    const inspectable = changedFiles.filter((f) => !shouldSkipMutation(f));
    assert.deepEqual(
      inspectable,
      [],
      "docs-only changesets must have zero inspectable files after #402",
    );
  });

  test("a mixed changeset filters docs/config but keeps source files", () => {
    const changedFiles = [
      "src/mutation.ts",
      "src/control-loop.ts",
      "docs/reference.md",
      "config/direction/priorities.md",
      "README.md",
    ];
    const inspectable = changedFiles.filter((f) => !shouldSkipMutation(f));
    assert.deepEqual(
      inspectable.sort(),
      ["src/control-loop.ts", "src/mutation.ts"].sort(),
      "doc/config files are filtered; src/ files remain inspectable",
    );
  });
});
