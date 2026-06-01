/**
 * Issue #366 regression — Feed planner a scoped file-tree snapshot.
 *
 * Before this change `buildPlannerContext()` had no view of the project's
 * actual file tree. The planner improvised plausible-looking paths in
 * `scopeBoundary.in` (e.g. "web/src/lib/kalshi/kalshi-price-format.ts" when
 * no such file existed) and the deterministic preflight gate rejected the
 * task with "Planner scoped non-existent file(s)". `GET /api/metrics/
 * abandonment` showed 2/18 abandonments (~11%) coming from this failure
 * mode, each costing ~$5 in frontier planner spend.
 *
 * Fix: wire the repo-map helpers into `buildPlannerContext()` so the planner
 * prompt includes a scoped, token-bounded list of real paths relevant to
 * the anchor reference.
 *
 * Tests cover:
 *   - the pure helpers in src/repo-file-matcher.ts (tokenisation, scoring,
 *     related-file lookup) and src/repo-file-tree-format.ts (formatted output)
 *   - the buildScopedFileTree() builder in context-builder.ts (header,
 *     omission on doc anchors, omission when fileTree is empty)
 *   - the PlannerContext shape now exposes `scopedFileTree`
 *   - the quick-fix path still skips the field (the anchor already names
 *     the file — adding the block would just bloat cheap prompts)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeAnchorReference,
  scoreFileAgainstTokens,
  findRelatedFiles,
} from "../src/repo-file-matcher.ts";
import { formatScopedFileTree } from "../src/repo-file-tree-format.ts";
import { buildScopedFileTree } from "../src/context-builder.ts";

// Minimal grounding shaped exactly like the production grounding payload, so
// the tests exercise the same field names buildPlannerContext consumes.
function makeGrounding(overrides: Record<string, any> = {}) {
  return {
    timestamp: Date.now(),
    branch: "main",
    headCommit: "abc1234",
    fileCount: 42,
    failingTests: [],
    testReport: { passed: 10, failed: 0, total: 10, ran: true, stdout: "", stderr: "", durationMs: 50 },
    typecheckReport: { exitCode: 0, output: "", ran: false },
    dirtyFiles: [],
    recentCommits: ["abc1234 test commit"],
    fileTree: "src/index.ts\nsrc/foo.ts",
    groundingDurationMs: 100,
    ...overrides,
  };
}

// Representative file tree mirroring the structure seen in the issue #366
// abandonment samples (kalshi-price-format, self-improvement-share, etc).
const SAMPLE_FILE_TREE = [
  "src/index.ts",
  "src/control-loop.ts",
  "src/context-builder.ts",
  "src/repo-map.ts",
  "src/grounding.ts",
  "web/src/lib/kalshi/kalshi-api.ts",
  "web/src/lib/kalshi/kalshi-price-format.ts",
  "web/src/lib/kalshi/kalshi-price-format.test.ts",
  "web/src/lib/kalshi/kalshi-client.ts",
  "web/src/lib/arbitrage/execution-request-cost.ts",
  "web/src/lib/arbitrage/execution-request-cost.test.ts",
  "web/src/lib/orchestrator/self-improvement-share.ts",
  "web/src/lib/orchestrator/self-improvement-share.test.ts",
  "web/src/lib/unrelated/billing.ts",
  "docs/adr/0004-self-modification-tiers.md",
];

describe("repo-map tokenizeAnchorReference()", () => {
  test("splits kebab-case and dotted paths into tokens", () => {
    const tokens = tokenizeAnchorReference("kalshi-price-format.ts");
    assert.ok(tokens.includes("kalshi"), `expected "kalshi" in ${tokens.join(",")}`);
    assert.ok(tokens.includes("price"), `expected "price" in ${tokens.join(",")}`);
    assert.ok(tokens.includes("format"), `expected "format" in ${tokens.join(",")}`);
    // "ts" is a stop token — it would match every TypeScript file.
    assert.ok(!tokens.includes("ts"), `"ts" should be filtered as a stop token`);
  });

  test("filters generic stop tokens and short tokens", () => {
    const tokens = tokenizeAnchorReference("Add tests for the foo helper");
    assert.ok(!tokens.includes("add"), "'add' should be stop-listed");
    assert.ok(!tokens.includes("for"), "'for' should be stop-listed");
    assert.ok(!tokens.includes("the"), "'the' should be stop-listed");
    assert.ok(!tokens.includes("tests"), "'tests' should be stop-listed");
    assert.ok(tokens.includes("foo"), "'foo' should survive");
  });

  test("returns [] for non-string / empty input", () => {
    assert.deepEqual(tokenizeAnchorReference(""), []);
    assert.deepEqual(tokenizeAnchorReference(undefined as unknown as string), []);
  });
});

describe("repo-map scoreFileAgainstTokens()", () => {
  test("directory-segment match scores higher than substring match", () => {
    const segmentHit = scoreFileAgainstTokens("web/src/lib/kalshi/kalshi-api.ts", ["kalshi"]);
    const substringHit = scoreFileAgainstTokens("web/src/lib/foo/has_kalshi_inside.ts", ["kalshi"]);
    assert.ok(segmentHit > substringHit,
      `directory segment hit (${segmentHit}) should outrank substring hit (${substringHit})`);
  });

  test("returns 0 when no token matches", () => {
    const score = scoreFileAgainstTokens("src/random/file.ts", ["nonexistent"]);
    assert.equal(score, 0);
  });

  test("multiple token hits accumulate", () => {
    const oneToken = scoreFileAgainstTokens("web/src/lib/kalshi/price.ts", ["kalshi"]);
    const twoTokens = scoreFileAgainstTokens("web/src/lib/kalshi/price.ts", ["kalshi", "price"]);
    assert.ok(twoTokens > oneToken,
      `two-token score (${twoTokens}) should exceed one-token score (${oneToken})`);
  });
});

describe("repo-map findRelatedFiles()", () => {
  test("kalshi-price-format anchor surfaces kalshi/price-format files", () => {
    const related = findRelatedFiles("kalshi-price-format", SAMPLE_FILE_TREE, 10);
    assert.ok(related.includes("web/src/lib/kalshi/kalshi-price-format.ts"),
      `expected price-format impl in: ${related.join(", ")}`);
    assert.ok(related.includes("web/src/lib/kalshi/kalshi-price-format.test.ts"),
      `expected price-format test in: ${related.join(", ")}`);
    assert.ok(!related.includes("web/src/lib/unrelated/billing.ts"),
      `unrelated file leaked into related set: ${related.join(", ")}`);
  });

  test("pairs impl file with its test counterpart even past raw score order", () => {
    // Anchor mentions only the impl; the impl→test pairing rule must still
    // pull in the .test.ts sibling so the planner can reason about test
    // updates alongside the impl change.
    const related = findRelatedFiles("self-improvement-share implementation", SAMPLE_FILE_TREE, 10);
    assert.ok(related.includes("web/src/lib/orchestrator/self-improvement-share.ts"));
    assert.ok(related.includes("web/src/lib/orchestrator/self-improvement-share.test.ts"));
  });

  test("respects the limit parameter", () => {
    const related = findRelatedFiles("kalshi", SAMPLE_FILE_TREE, 2);
    assert.ok(related.length <= 2, `limit=2 should cap result length, got ${related.length}`);
  });

  test("returns [] when anchor has no usable tokens", () => {
    // Pure stop tokens (after filtering) — no signal.
    const related = findRelatedFiles("the and for", SAMPLE_FILE_TREE, 10);
    assert.deepEqual(related, [], `expected [] for stopword-only anchor, got ${related.join(", ")}`);
  });

  test("returns [] when file tree is empty", () => {
    const related = findRelatedFiles("kalshi", [], 10);
    assert.deepEqual(related, []);
  });
});

describe("repo-map formatScopedFileTree()", () => {
  test("flags test files with [test] marker", () => {
    const out = formatScopedFileTree([
      "web/src/lib/kalshi/kalshi-price-format.ts",
      "web/src/lib/kalshi/kalshi-price-format.test.ts",
    ]);
    assert.ok(out.includes("kalshi-price-format.ts"));
    assert.ok(out.includes("kalshi-price-format.test.ts  [test]"),
      `expected test marker, got: ${out}`);
  });

  test("truncates and appends an elision marker when over budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/very/deep/path/segment-${i}/module-name-${i}.ts`);
    const out = formatScopedFileTree(many, 50); // ~200 chars
    assert.ok(out.includes("more file(s) omitted"),
      `expected elision marker when truncated, got:\n${out}`);
  });

  test("returns empty string for empty input", () => {
    assert.equal(formatScopedFileTree([]), "");
  });
});

describe("context-builder buildScopedFileTree()", () => {
  test("emits a SCOPED FILE TREE header with the real anchor reference", () => {
    const anchor = { type: "research", reference: "kalshi-price-format scoping" };
    const grounding = makeGrounding({ fileTree: SAMPLE_FILE_TREE.join("\n") });
    const block = buildScopedFileTree(anchor, grounding);
    assert.ok(block.startsWith("## SCOPED FILE TREE"),
      `expected SCOPED FILE TREE header, got first line: ${block.split("\n")[0]}`);
    assert.ok(block.includes("kalshi-price-format scoping"),
      "header should embed the anchor reference for the planner");
    assert.ok(block.includes("web/src/lib/kalshi/kalshi-price-format.ts"),
      "listing should include the real implementation file");
  });

  test("includes the 'real paths' reminder so the planner won't invent names", () => {
    const anchor = { type: "research", reference: "kalshi" };
    const grounding = makeGrounding({ fileTree: SAMPLE_FILE_TREE.join("\n") });
    const block = buildScopedFileTree(anchor, grounding);
    assert.ok(block.includes("DO NOT invent file names"),
      "header must instruct the planner not to invent names");
    assert.ok(block.includes("scopeBoundary.creates"),
      "footer should remind the planner about the creates/in distinction (issue #190)");
  });

  test("returns empty string when no file matches the anchor tokens", () => {
    // An anchor whose surviving tokens ("xyzzy", "quux", "plugh") appear in
    // no path under SAMPLE_FILE_TREE — findRelatedFiles returns [], the
    // builder must short-circuit before emitting the header block.
    const anchor = { type: "doc", reference: "xyzzy quux plugh" };
    const grounding = makeGrounding({ fileTree: SAMPLE_FILE_TREE.join("\n") });
    const block = buildScopedFileTree(anchor, grounding);
    assert.equal(block, "", `expected empty block when no files match, got: ${block}`);
  });

  test("returns empty string when fileTree is missing or empty", () => {
    const anchor = { type: "research", reference: "kalshi-price-format" };
    assert.equal(buildScopedFileTree(anchor, makeGrounding({ fileTree: "" })), "");
    assert.equal(buildScopedFileTree(anchor, makeGrounding({ fileTree: undefined as any })), "");
  });

  test("output stays within the documented token budget (~2000 tokens ≈ 8000 chars)", () => {
    const huge = Array.from({ length: 500 }, (_, i) =>
      `web/src/lib/kalshi/kalshi-feature-${i}.ts`,
    );
    const anchor = { type: "research", reference: "kalshi" };
    const grounding = makeGrounding({ fileTree: huge.join("\n") });
    const block = buildScopedFileTree(anchor, grounding);
    // 2000 tokens × 4 chars + header/footer overhead < 9000 chars.
    assert.ok(block.length < 9000,
      `scoped file-tree block exceeded budget (${block.length} chars)`);
  });
});

describe("context-builder PlannerContext.scopedFileTree shape", () => {
  test("PlannerContext exposes scopedFileTree on quick-fix path (empty by design)", async () => {
    const mod = await import("../src/context-builder.ts");
    const anchor = { type: "failing-test", reference: "kalshi-price-format" };
    const grounding = makeGrounding({
      fileTree: SAMPLE_FILE_TREE.join("\n"),
      testReport: { passed: 9, failed: 1, total: 10, ran: true, stdout: "", stderr: "" },
      failingTests: ["kalshi-price-format"],
    });
    const ctx = await mod.buildPlannerContext(anchor, grounding, null);
    assert.equal(typeof ctx.scopedFileTree, "string",
      "scopedFileTree must be a string field on every PlannerContext");
    // Quick-fix anchors deliberately skip the block: the anchor IS the file.
    assert.equal(ctx.scopedFileTree, "",
      "quick-fix anchors should not pay for a scopedFileTree block");
  });

  test("PlannerContext.scopedFileTree is populated for a standard/research anchor that matches", async () => {
    const mod = await import("../src/context-builder.ts");
    const anchor = { type: "research", reference: "kalshi-price-format scoping" };
    const grounding = makeGrounding({ fileTree: SAMPLE_FILE_TREE.join("\n") });
    const ctx = await mod.buildPlannerContext(anchor, grounding, null);
    assert.ok(ctx.scopedFileTree.includes("web/src/lib/kalshi/"),
      `expected scoped file-tree to mention the kalshi directory, got:\n${ctx.scopedFileTree}`);
  });
});
