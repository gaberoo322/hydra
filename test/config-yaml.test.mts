/**
 * Edge-case tests for the shared config-YAML grammar (`src/config-yaml.ts`,
 * issue #2314).
 *
 * This is the canonical home for the grammar's primitive edge-cases — the
 * quote-aware comment-stripping state machine (`stripComment`), scalar coercion
 * (`parseScalar`), and the parameterized parse loop (`parseConfigYaml`) in both
 * its flat (`nestedMappings:false`) and nested (`nestedMappings:true`) modes.
 * Before #2314 these cases were duplicated across `test/outcomes-yaml.test.mts`
 * and `test/wiring-liveness.test.mts`; those files now keep only wrapper-level
 * round-trips, and a grammar change updates this one file.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseConfigYaml,
  stripComment,
  parseScalar,
} from "../src/config-yaml.ts";

// ---------------------------------------------------------------------------
// stripComment — comment stripping with quote awareness
// ---------------------------------------------------------------------------

describe("config-yaml stripComment — quote-aware trailing-comment removal", () => {
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

  test("a single-quote inside a double-quoted value does not toggle quote state", () => {
    // The `#` is outside any quote here, so the comment is stripped.
    assert.equal(stripComment(`name: "it's x"  # c`), `name: "it's x"  `);
  });
});

// ---------------------------------------------------------------------------
// parseScalar — type coercion
// ---------------------------------------------------------------------------

describe("config-yaml parseScalar — scalar coercion", () => {
  test("coerces an integer", () => {
    assert.equal(parseScalar("42"), 42);
  });

  test("coerces a negative decimal", () => {
    assert.equal(parseScalar("-0.5"), -0.5);
  });

  test("coerces a leading-plus number to a string (sign regex allows only '-')", () => {
    // The numeric regex is `^-?\d+(\.\d+)?$` — a leading '+' is NOT numeric.
    assert.equal(parseScalar("+5"), "+5");
    assert.equal(typeof parseScalar("+5"), "string");
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
// parseConfigYaml — flat mode (nestedMappings:false), the outcomes grammar
// ---------------------------------------------------------------------------

describe("config-yaml parseConfigYaml — flat mode (nestedMappings:false)", () => {
  const flat = (raw: string) => parseConfigYaml(raw, { topKey: "outcomes" });

  test("parses a valid declaration with all fields", () => {
    const raw = `
outcomes:
  - name: clv-promotion
    kind: leading
    baseline: 0.0
    target: 0.05
`;
    const r = flat(raw);
    assert.equal(r.ok, true, `expected ok, got errors: ${r.errors.join("; ")}`);
    assert.equal(r.value.entries?.length, 1);
    const o = r.value.entries![0];
    assert.equal(o.name, "clv-promotion");
    assert.equal(o.baseline, 0);
    assert.equal(o.target, 0.05);
  });

  test("parses multiple list items", () => {
    const raw = `
outcomes:
  - name: a
    kind: leading
  - name: b
    kind: terminal
`;
    const r = flat(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries?.length, 2);
    assert.equal(r.value.entries![1].kind, "terminal");
  });

  test("strips full-line and trailing comments", () => {
    const raw = `
# comment header
outcomes:
  - name: x  # trailing comment
    kind: leading
`;
    const r = flat(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries![0].name, "x");
  });

  test("keeps a '#' that lives inside a quoted value", () => {
    const raw = `
outcomes:
  - name: x
    query: "/api/foo#frag"
`;
    const r = flat(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries![0].query, "/api/foo#frag");
  });

  test("supports quoted strings with spaces", () => {
    const raw = `
outcomes:
  - name: "with spaces"
    query: "/api/foo?bar=baz"
`;
    const r = flat(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.entries![0].name, "with spaces");
  });

  test("ignores blank lines", () => {
    const raw = `

outcomes:

  - name: x

    kind: leading
`;
    const r = flat(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries?.length, 1);
  });

  test("FLAT BEHAVIOR: an empty-value key coerces to the empty string (NOT a nested map)", () => {
    // This is the invariant that forces nestedMappings to be opt-in: with the
    // flag off, `minOverRuns:` with no value is a field whose value is "".
    const raw = `
outcomes:
  - name: x
    minOverRuns:
`;
    const r = flat(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries![0].minOverRuns, "");
    assert.equal(typeof r.value.entries![0].minOverRuns, "string");
  });

  test("flags unknown top-level keys with the configured topKey name", () => {
    const r = flat("bogus:\n  - x: 1\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("unknown top-level key") && e.includes("'outcomes'")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags an indented field with no enclosing list item", () => {
    const r = flat("outcomes:\n  kind: leading\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("no enclosing list item")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags indented content with no enclosing list", () => {
    const r = flat("  - name: orphan\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("without enclosing 'outcomes:' list")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags an inline value on a top-level key", () => {
    const r = flat("outcomes: inline-not-allowed\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("inline value not supported")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("flags an unrecognized top-level line", () => {
    const r = flat("this is not yaml\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("unrecognized top-level syntax")),
      `errors: ${r.errors.join("; ")}`,
    );
  });

  test("empty input parses to an empty document (ok, no entries)", () => {
    const r = flat("");
    assert.equal(r.ok, true);
    assert.equal(r.value.entries, undefined);
  });

  test("error messages carry a 1-based line number", () => {
    const r = flat("outcomes:\nbogus-key:\n");
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("line 2")),
      `expected a line-2 error, got: ${r.errors.join("; ")}`,
    );
  });

  test("never throws on garbage input (returns an errors[] result)", () => {
    const r = flat(":::\n\t- weird\n   ?:");
    assert.equal(typeof r.ok, "boolean");
    assert.ok(Array.isArray(r.errors));
  });
});

// ---------------------------------------------------------------------------
// parseConfigYaml — nested mode (nestedMappings:true), the liveness grammar
// ---------------------------------------------------------------------------

describe("config-yaml parseConfigYaml — nested mode (nestedMappings:true)", () => {
  const nested = (raw: string) =>
    parseConfigYaml(raw, { topKey: "entries", nestedMappings: true });

  test("an empty-value key opens a one-level nested mapping", () => {
    const raw = [
      "entries:",
      "  - type: output",
      "    source: /api/x",
      "    minOverRuns:",
      "      value: 0",
      "      runs: 3",
    ].join("\n");
    const r = nested(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.deepEqual(r.value.entries![0].minOverRuns, { value: 0, runs: 3 });
    assert.equal(r.value.entries![0].source, "/api/x");
  });

  test("a field after a nested block (back at item indent) closes the nested map", () => {
    const raw = [
      "entries:",
      "  - type: output",
      "    minOverRuns:",
      "      value: 5",
      "      runs: 2",
      '    description: "after the nested block"',
    ].join("\n");
    const r = nested(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.deepEqual(r.value.entries![0].minOverRuns, { value: 5, runs: 2 });
    assert.equal(r.value.entries![0].description, "after the nested block");
  });

  test("a '#' inside a nested-block quoted description survives", () => {
    const raw = [
      "entries:",
      "  - type: output",
      "    minOverRuns:",
      "      value: 0",
      "      runs: 3",
      '    note: "see #frag"',
    ].join("\n");
    const r = nested(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries![0].note, "see #frag");
  });

  test("nested mode still parses a flat timer item (no nested block)", () => {
    const raw = [
      "entries:",
      "  - unit: a.timer",
      "    type: timer",
      "    maxStaleMinutes: 60",
    ].join("\n");
    const r = nested(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries![0].unit, "a.timer");
    assert.equal(r.value.entries![0].maxStaleMinutes, 60);
  });

  test("nested mode reduces to flat behavior for non-empty fields", () => {
    // A field with a value is a scalar in both modes; the nested branches only
    // engage on the empty-value key.
    const raw = "entries:\n  - a: 1\n    b: 2\n";
    const r = nested(raw);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.value.entries![0].a, 1);
    assert.equal(r.value.entries![0].b, 2);
  });
});
