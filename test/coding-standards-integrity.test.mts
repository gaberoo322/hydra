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

const { FAIL_LOUD_RULE_IDS } = await import("../scripts/ci/fail-loud-ratchet.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pathExists = (p: string) => existsSync(join(ROOT, p));
const readText = (p: string): string | null => {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch (err) {
    console.error(`[coding-standards-integrity] cannot read ${p}:`, err);
    return null;
  }
};

const CI_TEXT = readText(".github/workflows/ci.yml") ?? "";

/**
 * Runner script -> the required-suite test file that imports it. The witness
 * test file's text must contain the runner path, so a stale entry fails below.
 */
const REQUIRED_RUNNERS: Record<string, string> = {
  "scripts/ci/fail-loud-ratchet.ts": "test/fail-loud-ratchet.test.mts",
  "scripts/ci/playbook-vocabulary-ratchet.ts": "test/playbook-vocabulary-ratchet.test.mts",
  "scripts/ci/test-title-provenance-scan.ts": "test/test-title-provenance-ratchet.test.mts",
};

/** Drop YAML/JS comments so a mention in a comment never counts as wiring. */
function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s#\s.*$/, ""))
    .join("\n");
}

/** A ci.yml line (comments stripped) that runs `p` as its own token, not inside echo / continue-on-error. */
export function ciRunsPath(ci: string, p: string): boolean {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(^|[\\s"'=/])${esc}($|[\\s"';])`);
  return stripComments(ci)
    .split("\n")
    .some((l) => token.test(l) && !/continue-on-error|^\s*-?\s*(run:\s*)?(echo|printf)\b/.test(l));
}

/** The witness test text imports or spawns `runner` (comments stripped; a bare string mention fails). */
export function witnessImportsRunner(witnessText: string, runner: string): boolean {
  const esc = runner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(import|from|require|spawn\\w*|exec\\w*)\\s*\\(?\\s*["'][^"']*${esc}["']`).test(
    stripComments(witnessText),
  );
}

/** Does a required job (the `test` suite or ci.yml) run this cited path? */
function requiredWiring(p: string): boolean {
  if (/^test\/.+\.test\.mts$/.test(p)) return true;
  if (ciRunsPath(CI_TEXT, p)) return true;
  const witness = REQUIRED_RUNNERS[p];
  if (witness) return witnessImportsRunner(readText(witness) ?? "", p);
  if (p.startsWith("src/ast-grep-rules/") && p.endsWith(".yml")) {
    const id = /^id:\s*(\S+)/m.exec(readText(p) ?? "")?.[1];
    return !!id && (FAIL_LOUD_RULE_IDS as readonly string[]).includes(id);
  }
  return false;
}

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
    const problems = checkStandardsIntegrity(text, parseCodingStandards(text), {
      claudeMdText: claude,
      pathExists,
      requiredWiring,
      readText,
    });
    assert.deepEqual(problems, []);
  });

  it("every REQUIRED_RUNNERS witness still imports its runner", () => {
    for (const [runner, witness] of Object.entries(REQUIRED_RUNNERS)) {
      assert.ok(witnessImportsRunner(readText(witness) ?? "", runner), `${witness} no longer imports ${runner}`);
    }
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

describe("wiring predicates", () => {
  const ci = "jobs:\n  test:\n    steps:\n      # run scripts/ci/x.ts later\n      - run: npx tsx scripts/ci/y.ts\n      - run: npx tsx scripts/ci/z.ts\n        continue-on-error: true\n      - run: echo scripts/ci/e.ts\n";
  it("ciRunsPath ignores a path mentioned only in a comment", () => {
    assert.equal(ciRunsPath(ci, "scripts/ci/x.ts"), false);
  });
  it("ciRunsPath ignores an echo line and a prefix-extended path", () => {
    assert.equal(ciRunsPath(ci, "scripts/ci/e.ts"), false);
    assert.equal(ciRunsPath(ci, "scripts/ci/y"), false);
  });
  it("ciRunsPath accepts a real run step", () => {
    assert.equal(ciRunsPath(ci, "scripts/ci/y.ts"), true);
  });
  it("witnessImportsRunner rejects a comment or string mention", () => {
    assert.equal(witnessImportsRunner('// import("../scripts/ci/r.ts")\nconst s = "scripts/ci/r.ts";', "scripts/ci/r.ts"), false);
  });
  it("witnessImportsRunner accepts a dynamic or static import", () => {
    assert.equal(witnessImportsRunner('const m = await import("../scripts/ci/r.ts");', "scripts/ci/r.ts"), true);
    assert.equal(witnessImportsRunner('import { a } from "../scripts/ci/r.ts";', "scripts/ci/r.ts"), true);
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

describe("standards-loader enforced-by wiring rules", () => {
  const cat = (ref: string) => `# T

## Tests

### STD-TEST-ONE

Body.

enforced-by: ${ref}

## Design

### STD-DESIGN-ONE

Body.

enforced-by: reviewer
`;
  const run = (ref: string, deps: Partial<Parameters<typeof checkStandardsIntegrity>[2]>) => {
    const t = cat(ref);
    return checkStandardsIntegrity(t, parseCodingStandards(t), { pathExists: () => true, ...deps }).map((p) => p.code);
  };
  it("unwired path without the marker fails", () => {
    assert.deepEqual(run("scripts/x.ts", { requiredWiring: () => false }), ["unwired-enforced-by"]);
  });
  it("the same path with (advisory) passes and is stripped from enforcedBy", () => {
    assert.deepEqual(run("scripts/x.ts (advisory)", { requiredWiring: () => false }), []);
    const r = parseCodingStandards(cat("scripts/x.ts (advisory), reviewer")).rules[0];
    assert.deepEqual(r.enforcedBy, ["scripts/x.ts", "reviewer"]);
    assert.deepEqual(r.advisory, ["scripts/x.ts"]);
  });
  it("a wired path passes", () => {
    assert.deepEqual(run("scripts/x.ts", { requiredWiring: () => true }), []);
  });
  it("a cited file lacking the rule id fails", () => {
    assert.deepEqual(run("scripts/x.ts", { readText: () => "no id here" }), ["check-does-not-name-rule"]);
    assert.deepEqual(run("scripts/x.ts", { readText: () => "covers STD-TEST-ONE." }), []);
  });
  it("a file cited under two rules must name both", () => {
    const t = `# T\n\n## Tests\n\n### STD-TEST-ONE\n\nenforced-by: scripts/x.ts\n\n## Design\n\n### STD-DESIGN-ONE\n\nenforced-by: scripts/x.ts\n`;
    const go = (src: string) =>
      checkStandardsIntegrity(t, parseCodingStandards(t), { pathExists: () => true, readText: () => src }).map((p) => p.code);
    assert.deepEqual(go("STD-TEST-ONE only"), ["check-does-not-name-rule"]);
    assert.deepEqual(go("STD-TEST-ONE and STD-DESIGN-ONE"), []);
  });
  it("reviewer (advisory) stays a literal token and is dangling", () => {
    assert.ok(run("reviewer (advisory)", { pathExists: () => false }).includes("dangling-enforced-by"));
  });
  it("omitting both deps skips both rules", () => {
    assert.deepEqual(run("scripts/x.ts", {}), []);
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
