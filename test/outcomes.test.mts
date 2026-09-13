/**
 * Regression tests for the Target Outcomes loader + API (issue #241).
 *
 * Bug class this guards against:
 *   - Schema drift in `config/direction/outcomes.yaml` silently producing
 *     malformed Outcome[] that downstream consumers crash on.
 *   - Adapter unreachability throwing instead of returning null.
 *   - Missing file crashing instead of returning empty array (the project
 *     starts with no outcomes declared on day one).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOutcomes,
  getOutcomeValue,
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

// Parser edge cases now live in test/outcomes-yaml.test.mts (the extracted
// parser Module's own test surface, #933). This file covers the loader,
// adapters, and API round-trip.

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
  - name: bankroll-pnl
    kind: terminal
    direction: up
    source: file
    query: metrics/pnl.txt
    baseline: 0
    target: 1000
    noise_epsilon: 0.5
`);
    const r = await loadOutcomes(path);
    // `r.ok === false` (not `!r.ok`) so the ternary narrows `r` to the `errors`
    // member under this project's `strict: false` tsconfig — TypeScript 6.0.2
    // does not narrow a discriminated union through a negated bare property
    // access (`!r.ok`) when strictNullChecks is off, only through an explicit
    // literal comparison (issue #4046).
    assert.equal(r.ok, true, `expected ok; errors=${r.ok === false ? r.errors.join("; ") : ""}`);
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
  - name: dup
    kind: leading
    direction: up
    source: file
    query: b
    baseline: 0
    target: 1
`);
    const r = await loadOutcomes(path);
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.ok(r.errors.some(e => e.includes("duplicate")), `expected duplicate error: ${r.errors.join("; ")}`);
  });

  test("holdback defaults to include when omitted and parses exclude when declared (#4413)", async () => {
    const path = await fixture("holdback-modes.yaml", `
outcomes:
  - name: watched
    kind: leading
    direction: up
    source: file
    query: metrics/watched.txt
    baseline: 0
    target: 1
  - name: display-only
    kind: leading
    direction: up
    source: file
    query: metrics/display-only.txt
    baseline: 0
    target: 1
    holdback: exclude
  - name: slow-terminal
    kind: terminal
    direction: up
    source: file
    query: metrics/slow.txt
    baseline: 0
    target: 1
    holdback: exclude
`);
    const r = await loadOutcomes(path);
    assert.equal(r.ok, true, `expected ok; errors=${r.ok === false ? r.errors.join("; ") : ""}`);
    if (!r.ok) throw new Error("unreachable");
    assert.equal(r.outcomes.length, 3);
    // The default lives in validateOutcome and nowhere else: the record always
    // carries the field, so no consumer ever needs `?? "include"`.
    assert.equal(r.outcomes[0].holdback, "include", "omitted holdback must default to include");
    assert.equal(r.outcomes[1].holdback, "exclude");
    // Accepted and inert on a terminal row (same posture as attribution_window_ms).
    assert.equal(r.outcomes[2].kind, "terminal");
    assert.equal(r.outcomes[2].holdback, "exclude");
  });

  test("unknown holdback value fails schema validation with a clear error (#4413)", async () => {
    // A bare string typo, a YAML boolean (the parser coerces `true`/`false`),
    // and a valueless `holdback:` (parsed as "") all hit the same enum check —
    // none may silently read as "include".
    const cases: Array<{ raw: string; got: string }> = [
      { raw: "holdback: bogus", got: "bogus" },
      { raw: "holdback: true", got: "true" },
      { raw: "holdback:", got: "" },
    ];
    for (const c of cases) {
      const path = await fixture(`holdback-bad-${c.got || "empty"}.yaml`, `
outcomes:
  - name: x
    kind: leading
    direction: up
    source: file
    query: y
    baseline: 0
    target: 1
    ${c.raw}
`);
      const r = await loadOutcomes(path);
      assert.equal(r.ok, false, `expected schema failure for '${c.raw}'`);
      if (r.ok) throw new Error("unreachable");
      const expected = `outcome[0] (x): field 'holdback' must be one of [include, exclude], got '${c.got}'`;
      assert.ok(
        r.errors.includes(expected),
        `expected error ${JSON.stringify(expected)}, got: ${r.errors.join("; ")}`,
      );
    }
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
      noise_epsilon: 0,
      holdback: "include",
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
      noise_epsilon: 0,
      holdback: "include",
    };
    const reading = await getOutcomeValue(outcome);
    assert.equal(reading, null);
  });

  test("file adapter treats ENOENT (missing file) as no-data WITHOUT an error log (#2448)", async () => {
    // A metric file is created lazily by its publisher: e.g.
    // forecast-calibration-brier.txt is only written once betting has ≥1
    // resolved forecast, so on cold start it is legitimately absent every
    // Meta-analysis tick. The adapter must return null (no-data) WITHOUT
    // logging ENOENT spam — mirroring loadOutcomes' ENOENT-is-no-data handling.
    const outcome: Outcome = {
      name: "forecast-calibration-brier",
      kind: "leading",
      direction: "down",
      source: "file",
      query: join(tmpDir, "metrics", "forecast-calibration-brier.txt"),
      baseline: 0,
      target: 1,
      noise_epsilon: 0,
      holdback: "include",
    };

    const originalError = console.error;
    const errorCalls: string[] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map(String).join(" "));
    };
    try {
      const reading = await getOutcomeValue(outcome);
      assert.equal(reading, null, "missing file is no-data → null");
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(
      errorCalls,
      [],
      `ENOENT must not log an error; got: ${errorCalls.join(" | ")}`,
    );
  });

  test("file adapter STILL logs a non-ENOENT read failure (#2448 — quiet ENOENT only)", async () => {
    // Quieting ENOENT must not silence genuine read errors. Reading a directory
    // as a file yields EISDIR, which must still surface a [outcomes] error log
    // (fail-loud convention) and return null.
    const outcome: Outcome = {
      name: "x",
      kind: "leading",
      direction: "up",
      source: "file",
      query: tmpDir, // a directory, not a file → EISDIR, not ENOENT
      baseline: 0,
      target: 1,
      noise_epsilon: 0,
      holdback: "include",
    };

    const originalError = console.error;
    const errorCalls: string[] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map(String).join(" "));
    };
    try {
      const reading = await getOutcomeValue(outcome);
      assert.equal(reading, null);
    } finally {
      console.error = originalError;
    }
    assert.ok(
      errorCalls.some((m) => m.includes("[outcomes] file adapter: failed to read")),
      `non-ENOENT read failure must still log; got: ${errorCalls.join(" | ")}`,
    );
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
      noise_epsilon: 0,
      holdback: "include",
    };
    const reading = await getOutcomeValue(outcome);
    assert.equal(reading, null);
  });

  test("non-file source is rejected by schema validation (#933)", async () => {
    // The api/prometheus/sql stubs were removed (#933): `file` is the only
    // real adapter, so a non-file `source:` is now a schema violation rather
    // than a silently-stubbed no-data read.
    for (const source of ["api", "prometheus", "sql"]) {
      const path = await fixture(`bad-source-${source}.yaml`, `
outcomes:
  - name: x
    kind: leading
    direction: up
    source: ${source}
    query: y
    baseline: 0
    target: 1
`);
      const r = await loadOutcomes(path);
      assert.equal(r.ok, false, `source '${source}' should fail schema validation`);
      if (r.ok) throw new Error("unreachable");
      assert.ok(
        r.errors.some((e) => e.includes("source")),
        `expected a 'source' error for '${source}', got: ${r.errors.join("; ")}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// API route round-trip
// ---------------------------------------------------------------------------

describe("GET /outcomes — API round-trip", () => {
  test("returns shape {outcomes: [{name, current, ts, ...}]}", async () => {
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
    assert.equal(row.baseline, 0);
    assert.equal(row.target, 10);
    assert.equal(row.holdback, "include", "GET /outcomes row must carry the holdback field (#4413)");
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

// ---------------------------------------------------------------------------
// The live config manifest (config/direction/outcomes.yaml) — its one durable
// concern, moved here from test/outcomes-producer.test.mts when that file was
// deleted with the retired target's Brier producer (issue #4410). Own top-level
// describe with its own lifecycle, never nested under another describe's
// after() (CLAUDE.md no-nested-shared-teardown rule). Resolved relative to
// THIS test file (the worktree checkout), never HYDRA_ROOT, so the assertion
// reads the same tree the `test` job checks out.
// ---------------------------------------------------------------------------
describe("outcomes.yaml — the shipped manifest (#4410)", () => {
  const manifestPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "config",
    "direction",
    "outcomes.yaml",
  );

  test("real outcomes.yaml parses and declares exactly one outcome: orchestrator-self-improvement-share", async () => {
    const loaded = await loadOutcomes(manifestPath);
    assert.equal(
      loaded.ok,
      true,
      `live outcomes.yaml must parse: ${JSON.stringify((loaded as any).errors)}`,
    );
    assert.equal(
      loaded.outcomes.length,
      1,
      `the retired target's outcome declarations must all be gone, got ${JSON.stringify(loaded.outcomes.map((o) => o.name))}`,
    );
    const o = loaded.outcomes[0];
    // The ADR-0013 25% floor outcome, byte-identical to its pre-retirement
    // declaration — the successor target's outcomes land with the CSB swap
    // (map #4313), not by editing this entry.
    assert.equal(o.name, "orchestrator-self-improvement-share");
    assert.equal(o.kind, "leading");
    assert.equal(o.direction, "up");
    assert.equal(o.source, "file");
    assert.equal(o.query, "metrics/orchestrator-share.txt");
    assert.equal(o.baseline, 0);
    assert.equal(o.target, 0.25);
    assert.equal(o.noise_epsilon, 0.01);
  });
});
