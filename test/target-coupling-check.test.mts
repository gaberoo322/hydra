import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFile,
  isCommentLine,
  violationKey,
  type Violation,
} from "../scripts/ci/target-coupling-check.ts";
import { pickDistinctiveDependencies } from "../src/codebase-analyzer.ts";

// Acceptance criterion (issue #731): the check FAILS on a newly-introduced
// hardcoded `hydra-betting` reference in src/. The fatal-vs-advisory split keys
// off whether the match is in code or a comment, so these tests pin that down.

function names(vs: Violation[]): string[] {
  return vs.map(v => `${v.severity}:${v.token}`);
}

test("catches a hardcoded repo slug in code as a fatal name leak", () => {
  const vs = classifyFile("src/fake.ts", 'const repo = "gaberoo322/hydra-betting";');
  assert.ok(
    vs.some(v => v.severity === "name" && v.token === "gaberoo322/hydra-betting"),
    `expected a fatal name leak, got ${JSON.stringify(names(vs))}`,
  );
});

test("does not double-count the embedded target name inside the repo slug", () => {
  const vs = classifyFile("src/fake.ts", 'const repo = "gaberoo322/hydra-betting";');
  const nameLeaks = vs.filter(v => v.severity === "name");
  assert.equal(nameLeaks.length, 1, `expected exactly one name leak, got ${JSON.stringify(names(vs))}`);
  assert.equal(nameLeaks[0].token, "gaberoo322/hydra-betting");
});

test("catches a bare target name in code", () => {
  const vs = classifyFile("src/fake.ts", 'const t = "hydra-betting";');
  assert.ok(vs.some(v => v.severity === "name" && v.token === "hydra-betting"));
});

test("downgrades a target name in a comment to advisory (non-fatal)", () => {
  const vs = classifyFile("src/fake.ts", " * proxied from hydra-betting today");
  assert.ok(vs.length > 0, "expected the comment mention to be flagged");
  assert.ok(
    vs.every(v => v.severity === "name-comment"),
    `comment mentions must be advisory, got ${JSON.stringify(names(vs))}`,
  );
});

test("flags domain vocab in code as fatal vocab-code", () => {
  const vs = classifyFile("src/fake.ts", 'if (d.includes("kalshi") || d.includes("polymarket")) {}');
  assert.ok(vs.some(v => v.severity === "vocab-code" && v.token === "kalshi"));
  assert.ok(vs.some(v => v.severity === "vocab-code" && v.token === "polymarket"));
});

test("downgrades domain vocab in a comment to advisory", () => {
  const vs = classifyFile("src/fake.ts", "// supports bankroll tracking");
  assert.ok(vs.length > 0);
  assert.ok(vs.every(v => v.severity === "vocab-comment"));
});

test("clean target-agnostic code produces no violations", () => {
  const vs = classifyFile(
    "src/fake.ts",
    "const repo = getTargetGithubRepo();\nconst name = getTargetName();\nconst svc = getTargetServiceName();",
  );
  assert.equal(vs.length, 0, `expected no violations, got ${JSON.stringify(names(vs))}`);
});

test("whole-word matching ignores substrings of unrelated identifiers", () => {
  // `bankroll` is a denylist entry; `bankrolling` is a different identifier.
  const vs = classifyFile("src/fake.ts", "const x = bankrolling + 1;");
  assert.ok(!vs.some(v => v.token === "bankroll"), `false positive on substring: ${JSON.stringify(names(vs))}`);
});

test("isCommentLine recognises //, * and /* prefixes after trimming", () => {
  assert.equal(isCommentLine("  // a line comment"), true);
  assert.equal(isCommentLine(" * jsdoc continuation"), true);
  assert.equal(isCommentLine("/* block open"), true);
  assert.equal(isCommentLine('const x = "// not a comment";'), false);
});

test("violationKey is line-independent (file + token + severity)", () => {
  const a: Violation = { file: "src/x.ts", line: 1, token: "hydra-betting", severity: "name", excerpt: "" };
  const b: Violation = { file: "src/x.ts", line: 99, token: "hydra-betting", severity: "name", excerpt: "" };
  assert.equal(violationKey(a), violationKey(b));
});

test("pickDistinctiveDependencies filters out generic framework deps", () => {
  const deps = ["next", "react", "react-dom", "drizzle-orm", "tailwindcss", "@types/node", "kalshi-api", "some-venue-sdk"];
  const distinctive = pickDistinctiveDependencies(deps);
  // Framework noise dropped...
  for (const generic of ["next", "react", "react-dom", "@types/node"]) {
    assert.ok(!distinctive.includes(generic), `${generic} should be filtered out`);
  }
  // ...target-distinctive packages surface automatically (no allowlist needed).
  assert.ok(distinctive.includes("kalshi-api"));
  assert.ok(distinctive.includes("some-venue-sdk"));
});
