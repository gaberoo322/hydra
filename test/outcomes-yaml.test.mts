/**
 * Wrapper round-trip tests for the Target Outcomes YAML loader
 * (`src/outcomes-yaml.ts`, issue #933; thin wrapper over `src/config-yaml.ts`
 * since #2314).
 *
 * The grammar primitives (`stripComment`, `parseScalar`) and the parse-loop
 * edge-cases moved to `test/config-yaml.test.mts` with the shared module. This
 * file keeps `parseOutcomesYaml` document-walk coverage — proving the wrapper maps
 * the shared `entries` list onto the outcomes-specific `outcomes` result shape and
 * preserves the flat (`nestedMappings:false`) behavior the outcomes config relies
 * on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseOutcomesYaml } from "../src/outcomes-yaml.ts";

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
