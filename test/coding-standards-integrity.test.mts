import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODING_STANDARDS_WORD_CEILING,
  checkStandardsIntegrity,
  compareWordBaseline,
  countWords,
  loadCodingStandards,
  parseCodingStandards,
} from "../src/qa/standards-loader.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pathExists = (p: string) => existsSync(join(ROOT, p));

const GOOD = `# T

## Tests

### STD-TEST-ONE

Body.

enforced-by: reviewer

## Design

### STD-DESIGN-ONE

Body.

enforced-by: reviewer, package.json
`;

function codes(text: string, claudeMdText?: string, exists: (p: string) => boolean = () => true) {
  return checkStandardsIntegrity(text, parseCodingStandards(text), { claudeMdText, pathExists: exists }).map((p) => p.code);
}

describe("CODING_STANDARDS.md live integrity", () => {
  const text = readFileSync(join(ROOT, "CODING_STANDARDS.md"), "utf8");
  const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

  it("the live catalog has no integrity problems", () => {
    const problems = checkStandardsIntegrity(text, parseCodingStandards(text), { claudeMdText: claude, pathExists });
    assert.deepEqual(problems, []);
  });

  it("word counts match the ratchet baseline exactly", () => {
    const baseline = JSON.parse(readFileSync(join(ROOT, "test/fixtures/coding-standards-baseline.json"), "utf8"));
    const problems = compareWordBaseline(baseline, {
      "CODING_STANDARDS.md": countWords(text),
      "CLAUDE.md": countWords(claude),
    });
    assert.deepEqual(problems.map((p) => p.message), []);
  });
});

describe("standards-loader integrity rules", () => {
  it("accepts a well-formed catalog", () => {
    assert.deepEqual(codes(GOOD), []);
  });
  it("ceiling-exceeded", () => {
    const big = GOOD + "word ".repeat(CODING_STANDARDS_WORD_CEILING);
    assert.ok(codes(big).includes("ceiling-exceeded"));
  });
  it("duplicate-rule-id", () => {
    assert.ok(codes(GOOD + "\n### STD-TEST-ONE\n\nenforced-by: reviewer\n").includes("duplicate-rule-id"));
  });
  it("invalid-rule-id", () => {
    assert.ok(codes(GOOD.replace("STD-TEST-ONE", "std-test-one")).includes("invalid-rule-id"));
  });
  it("missing-enforced-by", () => {
    assert.ok(codes(GOOD.replace("enforced-by: reviewer\n\n## Design", "\n## Design")).includes("missing-enforced-by"));
  });
  it("dangling-enforced-by", () => {
    assert.ok(codes(GOOD, undefined, () => false).includes("dangling-enforced-by"));
  });
  it("dangling-fence-id in CLAUDE.md", () => {
    assert.ok(codes(GOOD, "fence: STD-NOPE-NOT-DEFINED").includes("dangling-fence-id"));
    assert.ok(!codes(GOOD, "fence: STD-TEST-ONE").includes("dangling-fence-id"));
  });
  it("dangling-fence-id as in-file cross-reference", () => {
    const bad = GOOD.replace("Body.\n\nenforced-by: reviewer\n\n## Design", "See STD-GHOST-RULE.\n\nenforced-by: reviewer\n\n## Design");
    assert.ok(codes(bad).includes("dangling-fence-id"));
  });
  it("missing-section", () => {
    assert.ok(codes("# T\n\n## Tests\n\n### STD-TEST-ONE\n\nenforced-by: reviewer\n").includes("missing-section"));
  });
  it("empty-section", () => {
    assert.ok(codes(GOOD.replace(/### STD-DESIGN-ONE[\s\S]*$/, "")).includes("empty-section"));
  });
});

describe("standards-loader word ratchet", () => {
  const base = (n: number) => ({ files: { "X.md": { words: n }, "CODING_STANDARDS.md": { words: n } } });
  it("grew fails", () => {
    assert.equal(compareWordBaseline(base(10), { "X.md": 11 })[0].code, "word-count-grew");
  });
  it("untightened fails and prints the number to paste", () => {
    const [p] = compareWordBaseline(base(10), { "X.md": 7 });
    assert.equal(p.code, "word-count-untightened");
    assert.match(p.message, /"words": 7/);
  });
  it("baseline over ceiling fails", () => {
    const n = CODING_STANDARDS_WORD_CEILING + 1;
    assert.ok(compareWordBaseline(base(n), { "X.md": n, "CODING_STANDARDS.md": n }).some((p) => p.code === "baseline-over-ceiling"));
  });
  it("equal passes", () => {
    assert.deepEqual(compareWordBaseline(base(10), { "X.md": 10 }), []);
  });
});

describe("loadCodingStandards", () => {
  it("reads exactly <root>/CODING_STANDARDS.md", async () => {
    const seen: string[] = [];
    const r = await loadCodingStandards("/r", { readFile: async (p) => (seen.push(p), GOOD) });
    assert.deepEqual(seen, ["/r/CODING_STANDARDS.md"]);
    assert.ok(r.ok && r.found && r.parsed.rules.length === 2);
  });
  it("ENOENT is found:false, not an error", async () => {
    const r = await loadCodingStandards("/r", {
      readFile: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); },
    });
    assert.deepEqual(r, { ok: true, found: false, path: "/r/CODING_STANDARDS.md" });
  });
  it("other read errors return standards-read-failed", async () => {
    const r = await loadCodingStandards("/r", {
      readFile: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    });
    const f = r as { ok: boolean; code?: string; message?: string };
    assert.ok(!f.ok && f.code === "standards-read-failed" && /denied/.test(f.message ?? ""));
  });
  it("loads the live repo root file", async () => {
    const r = await loadCodingStandards(ROOT);
    assert.ok(r.ok && r.found);
  });
});
