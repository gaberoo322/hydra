/**
 * Regression tests for the Target Outcomes loader + API (issue #241).
 *
 * Bug class this guards against:
 *   - Schema drift in `config/direction/outcomes.yaml` silently producing
 *     malformed Outcome[] that downstream consumers (#242 stuckness, #244
 *     Tier-2 holdback) crash on.
 *   - Adapter unreachability throwing instead of returning null (would
 *     poison stuckness history with synthetic regressions).
 *   - Missing file crashing instead of returning empty array (the project
 *     starts with no outcomes declared on day one).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOutcomes,
  getOutcomeValue,
  parseOutcomesYaml,
  type Outcome,
} from "../src/outcomes.ts";
import { createOutcomesRouter } from "../src/api/outcomes.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hydra-outcomes-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// Express handler harness — same pattern used in test/api-health.test.mts
// ---------------------------------------------------------------------------

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const methods = layer.route.methods;
      if (methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

function mockReq(): any {
  return { method: "GET", url: "/outcomes", headers: {}, query: {}, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("parseOutcomesYaml — subset YAML parser", () => {
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
    stuckness_threshold_cycles: 10
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
    assert.equal(o.stuckness_threshold_cycles, 10);
    assert.equal(o.noise_epsilon, 0.001);
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
    stuckness_threshold_cycles: 5
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.outcomes![0].name, "x");
  });

  test("supports quoted strings", () => {
    const raw = `
outcomes:
  - name: "with spaces"
    kind: leading
    direction: up
    source: api
    query: "/api/foo?bar=baz"
    baseline: 0
    target: 1
    stuckness_threshold_cycles: 5
`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.outcomes![0].query, "/api/foo?bar=baz");
  });

  test("flags unknown top-level keys", () => {
    const raw = `bogus:\n  - x: 1\n`;
    const r = parseOutcomesYaml(raw);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes("unknown top-level key")), `errors: ${r.errors.join("; ")}`);
  });
});

// ---------------------------------------------------------------------------
// Loader: missing / valid / invalid files
// ---------------------------------------------------------------------------

describe("loadOutcomes — file IO + schema validation", () => {
  test("missing file returns ok with empty outcomes (does NOT crash)", async () => {
    const r = await loadOutcomes(join(tmpDir, "does-not-exist.yaml"));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.outcomes, []);
  });

  test("valid file yields typed Outcome[]", async () => {
    const path = await fixture("valid.yaml", `
outcomes:
  - name: clv-promotion
    kind: leading
    direction: up
    source: file
    query: metrics/clv.txt
    baseline: 0
    target: 0.05
    stuckness_threshold_cycles: 10
  - name: bankroll-pnl
    kind: terminal
    direction: up
    source: api
    query: /api/pnl
    baseline: 0
    target: 1000
    stuckness_threshold_cycles: 50
    noise_epsilon: 0.5
`);
    const r = await loadOutcomes(path);
    assert.equal(r.ok, true, `expected ok; errors=${!r.ok ? r.errors.join("; ") : ""}`);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.outcomes.length, 2);
    assert.equal(r.outcomes[0].name, "clv-promotion");
    assert.equal(r.outcomes[0].kind, "leading");
    assert.equal(r.outcomes[0].noise_epsilon, 0, "noise_epsilon defaults to 0 when omitted");
    assert.equal(r.outcomes[1].kind, "terminal");
    assert.equal(r.outcomes[1].noise_epsilon, 0.5);
  });

  test("schema violation surfaces named error (does NOT throw)", async () => {
    const path = await fixture("bad-kind.yaml", `
outcomes:
  - name: x
    kind: not-a-kind
    direction: up
    source: file
    query: y
    baseline: 0
    target: 1
    stuckness_threshold_cycles: 5
`);
    const r = await loadOutcomes(path);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.ok(r.errors.some(e => e.includes("kind")), `expected 'kind' error, got: ${r.errors.join("; ")}`);
  });

  test("missing required field surfaces named error", async () => {
    const path = await fixture("missing-target.yaml", `
outcomes:
  - name: x
    kind: leading
    direction: up
    source: file
    query: y
    baseline: 0
    stuckness_threshold_cycles: 5
`);
    const r = await loadOutcomes(path);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.ok(r.errors.some(e => e.includes("target")), `expected 'target' error, got: ${r.errors.join("; ")}`);
  });

  test("duplicate names rejected", async () => {
    const path = await fixture("dupes.yaml", `
outcomes:
  - name: dup
    kind: leading
    direction: up
    source: file
    query: a
    baseline: 0
    target: 1
    stuckness_threshold_cycles: 5
  - name: dup
    kind: leading
    direction: up
    source: file
    query: b
    baseline: 0
    target: 1
    stuckness_threshold_cycles: 5
`);
    const r = await loadOutcomes(path);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.ok(r.errors.some(e => e.includes("duplicate")), `expected duplicate error: ${r.errors.join("; ")}`);
  });
});

// ---------------------------------------------------------------------------
// Adapter tests
// ---------------------------------------------------------------------------

describe("getOutcomeValue — source adapters", () => {
  test("file adapter returns numeric value + timestamp", async () => {
    const valFile = join(tmpDir, "val.txt");
    await writeFile(valFile, "0.42\n");
    const outcome: Outcome = {
      name: "x",
      kind: "leading",
      direction: "up",
      source: "file",
      query: valFile,
      baseline: 0,
      target: 1,
      stuckness_threshold_cycles: 5,
      noise_epsilon: 0,
    };
    const reading = await getOutcomeValue(outcome);
    assert.ok(reading, "reading should not be null");
    assert.equal(reading!.value, 0.42);
    assert.ok(typeof reading!.ts === "string" && reading!.ts.length > 0);
  });

  test("file adapter returns null when file unreachable (no throw)", async () => {
    const outcome: Outcome = {
      name: "x",
      kind: "leading",
      direction: "up",
      source: "file",
      query: join(tmpDir, "definitely-not-here.txt"),
      baseline: 0,
      target: 1,
      stuckness_threshold_cycles: 5,
      noise_epsilon: 0,
    };
    const reading = await getOutcomeValue(outcome);
    assert.equal(reading, null);
  });

  test("file adapter returns null when contents not numeric", async () => {
    const valFile = join(tmpDir, "bad-val.txt");
    await writeFile(valFile, "hello world\n");
    const outcome: Outcome = {
      name: "x",
      kind: "leading",
      direction: "up",
      source: "file",
      query: valFile,
      baseline: 0,
      target: 1,
      stuckness_threshold_cycles: 5,
      noise_epsilon: 0,
    };
    const reading = await getOutcomeValue(outcome);
    assert.equal(reading, null);
  });

  test("api/prometheus/sql adapters return null (stubbed, never throw)", async () => {
    const sources: Outcome["source"][] = ["api", "prometheus", "sql"];
    for (const source of sources) {
      const outcome: Outcome = {
        name: `stub-${source}`,
        kind: "leading",
        direction: "up",
        source,
        query: "anything",
        baseline: 0,
        target: 1,
        stuckness_threshold_cycles: 5,
        noise_epsilon: 0,
      };
      const reading = await getOutcomeValue(outcome);
      assert.equal(reading, null, `${source} adapter should return null`);
    }
  });
});

// ---------------------------------------------------------------------------
// API route round-trip
// ---------------------------------------------------------------------------

describe("GET /outcomes — API round-trip", () => {
  test("returns shape {outcomes: [{name, current, ts, lastMovedAt, ...}]}", async () => {
    const valFile = join(tmpDir, "rt-val.txt");
    await writeFile(valFile, "7\n");
    const outcomesPath = await fixture("rt-outcomes.yaml", `
outcomes:
  - name: roundtrip
    kind: leading
    direction: up
    source: file
    query: ${valFile}
    baseline: 0
    target: 10
    stuckness_threshold_cycles: 5
`);

    const router = createOutcomesRouter(outcomesPath);
    const handler = findHandler(router, "GET", "/outcomes");
    assert.ok(handler, "GET /outcomes handler should exist");

    const req = mockReq();
    const res = mockRes();
    await handler!(req, res);

    assert.ok(res._body, "response body should be set");
    assert.ok(Array.isArray(res._body.outcomes), "outcomes should be an array");
    assert.equal(res._body.outcomes.length, 1);
    const row = res._body.outcomes[0];
    assert.equal(row.name, "roundtrip");
    assert.equal(row.current, 7);
    assert.ok(row.ts, "ts should be populated when reading available");
    assert.equal(row.lastMovedAt, null, "lastMovedAt is null until #242 ships");
    assert.equal(row.baseline, 0);
    assert.equal(row.target, 10);
  });

  test("returns 500 with errors[] when schema is invalid", async () => {
    const outcomesPath = await fixture("rt-bad.yaml", `
outcomes:
  - name: x
    kind: bogus
    direction: up
    source: file
    query: y
    baseline: 0
    target: 1
    stuckness_threshold_cycles: 5
`);

    const router = createOutcomesRouter(outcomesPath);
    const handler = findHandler(router, "GET", "/outcomes");
    const req = mockReq();
    const res = mockRes();
    await handler!(req, res);

    assert.equal(res._status, 500);
    assert.ok(Array.isArray(res._body.errors));
    assert.ok(res._body.errors.length > 0);
  });
});
