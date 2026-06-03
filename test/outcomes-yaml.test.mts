/**
 * Edge-case tests for the extracted Target Outcomes YAML parser
 * (`src/outcomes-yaml.ts`, issue #933).
 *
 * Before #933 these cases were exercised only indirectly through the full
 * `loadOutcomes` path. With the parser lifted into its own Module, the parse
 * rules — comment stripping, scalar coercion, indentation handling — get a
 * direct test surface here, separate from the outcome-specific schema
 * validation in `src/outcomes.ts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseOutcomesYaml,
  stripComment,
  parseScalar,
} from "../src/outcomes-yaml.ts";

// ---------------------------------------------------------------------------
// stripComment — comment stripping with quote awareness
// ---------------------------------------------------------------------------

describe("stripComment — quote-aware trailing-comment removal", () => {
  test("strips a trailing comment", () => {
    assert.equal(stripComment("name: x  # trailing"), "name: x  ");
  });

  test("strips a full-line comment to empty", () => {
    assert.equal(stripComment("# header").trim(), "");
  });

  test("preserves a '#' inside a double-quoted value", () => {
    assert.equal(stripComment('query: "/api/foo#frag"'), 'query: "/api/foo#frag"');
  });

  test("preserves a '#' inside a single-quoted value", () => {
    assert.equal(stripComment("query: '/a#b'"), "query: '/a#b'");
  });

  test("strips a comment that follows a closed quote", () => {
    assert.equal(stripComment('query: "/api"  # note'), 'query: "/api"  ');
  });

  test("leaves a line with no comment untouched", () => {
    assert.equal(stripComment("baseline: 0"), "baseline: 0");
  });
});

// ---------------------------------------------------------------------------
// parseScalar — type coercion
// ---------------------------------------------------------------------------

describe("parseScalar — scalar coercion", () => {
  test("coerces an integer", () => {
    assert.equal(parseScalar("42"), 42);
  });

  test("coerces a negative decimal", () => {
    assert.equal(parseScalar("-0.5"), -0.5);
  });

  test("coerces booleans", () => {
    assert.equal(parseScalar("true"), true);
    assert.equal(parseScalar("false"), false);
  });

  test("unwraps a double-quoted string", () => {
    assert.equal(parseScalar('"hello world"'), "hello world");
  });

  test("unwraps a single-quoted string", () => {
    assert.equal(parseScalar("'a b'"), "a b");
  });

  test("keeps a numeric-looking quoted value as a string", () => {
    // A quoted "0" must stay a string, not coerce to a number.
    assert.equal(parseScalar('"0"'), "0");
    assert.equal(typeof parseScalar('"0"'), "string");
  });

  test("leaves a bare non-numeric string as a string", () => {
    assert.equal(parseScalar("metrics/clv.txt"), "metrics/clv.txt");
  });

  test("empty token becomes empty string", () => {
    assert.equal(parseScalar(""), "");
    assert.equal(parseScalar("   "), "");
  });

  test("a numeric-with-trailing-text token stays a string", () => {
    assert.equal(parseScalar("12abc"), "12abc");
  });
});

// ---------------------------------------------------------------------------
// parseOutcomesYaml — document walk
// ---------------------------------------------------------------------------

describe("parseOutcomesYaml — document walk", () => {
  test("parses a valid declaration with all fields", () => {
    const raw = `
outcomes:
  - name: clv-promotion
    kind: leading
    direction: up
    source: file
    query: metrics/clv.txt
    baseline: 0.0
    target: 0.05
    noise_epsilon: 0.001
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true, `expected ok, got errors: ${r.errors.join("; ")}`);
    assert.equal(r.value.outcomes?.length, 1);
    const o = r.value.outcomes![0];
    assert.equal(o.name, "clv-promotion");
    assert.equal(o.kind, "leading");
    assert.equal(o.baseline, 0);
    assert.equal(o.target, 0.05);
    assert.equal(o.noise_epsilon, 0.001);
  });

  test("parses multiple list items", () => {
    const raw = `
outcomes:
  - name: a
    kind: leading
  - name: b
    kind: terminal
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.outcomes?.length, 2);
    assert.equal(r.value.outcomes![0].name, "a");
    assert.equal(r.value.outcomes![1].kind, "terminal");
  });

  test("strips full-line and trailing comments", () => {
    const raw = `
# comment header
outcomes:
  - name: x  # trailing comment
    kind: leading
    direction: up
    source: file
    query: y
    baseline: 0
    target: 1
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.outcomes![0].name, "x");
  });

  test("keeps a '#' that lives inside a quoted value", () => {
    const raw = `
outcomes:
  - name: x
    query: "/api/foo#frag"
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.outcomes![0].query, "/api/foo#frag");
  });

  test("supports quoted strings with spaces", () => {
    const raw = `
outcomes:
  - name: "with spaces"
    query: "/api/foo?bar=baz"
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.outcomes![0].name, "with spaces");
    assert.equal(r.value.outcomes![0].query, "/api/foo?bar=baz");
  });

  test("ignores blank lines", () => {
    const raw = `

outcomes:

  - name: x

    kind: leading
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.outcomes?.length, 1);
  });

  test("flags unknown top-level keys", () => {
    const r = parseOutcomesYaml("bogus:\n  - x: 1\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("unknown top-level key")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags an indented field with no enclosing list item", () => {
    const raw = `
outcomes:
  kind: leading
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("no enclosing list item")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags indented content with no enclosing outcomes list", () => {
    const raw = `  - name: orphan\n`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("without enclosing 'outcomes:' list")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags an inline value on a top-level key", () => {
    const raw = `outcomes: inline-not-allowed\n`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("inline value not supported")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags an unrecognized top-level line", () => {
    const raw = `this is not yaml\n`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("unrecognized top-level syntax")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("empty input parses to an empty document (ok, no outcomes)", () => {
    const r = parseOutcomesYaml("");
    assert.equal(r.ok, true);
    assert.equal(r.value.outcomes, undefined);
  });

  test("error messages carry a 1-based line number", () => {
    const raw = `outcomes:\nbogus-key:\n`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("line 2")),
      `expected a line-2 error, got: ${r.errors.join("; ")}`,
    );
  });
});
