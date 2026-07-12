/**
 * Regression tests for **GET /metrics/session-tokens** (issue #3250).
 *
 * The autopilot's `cumulative_tokens` run field was permanently 0 because the
 * SubagentStop hook cannot carry the subagent's token usage. This read-only
 * route recovers a completed dispatch's REAL count from its JSONL transcript
 * (via the `tokensForSession` transcript-scan seam), keyed by sessionId — the
 * count reap.py joins on when the hook floor is 0.
 *
 * Exercised by invoking the mounted handler with a mock req/res (the same
 * pattern as the sibling POST /metrics/tokens guard test), against a fixture
 * transcript root pinned via HYDRA_CLAUDE_PROJECTS_ROOT so no real ~/.claude
 * transcripts are read. Asserts: a resolvable session sums its usage; an
 * unknown / non-UUID session returns tokens:0 (honest unknown, never a
 * fabricated nonzero); a missing `session` query is a 400 schema error.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createMetricsRouter } = await import("../src/api/metrics.ts");

const UUID = "38c78e5c-884f-47ae-acb4-5d48286776b3";
const savedRoot = process.env.HYDRA_CLAUDE_PROJECTS_ROOT;
let root = "";
let projectDir = "";

function usageLine(input: number, output: number): string {
  return JSON.stringify({
    timestamp: "2026-07-12T20:00:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "session-tokens-root-"));
  process.env.HYDRA_CLAUDE_PROJECTS_ROOT = root;
  // Layout: <root>/<encoded-projectDir>/<sessionId>.jsonl
  projectDir = join(root, "-home-gabe-hydra");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${UUID}.jsonl`),
    [usageLine(1000, 500), usageLine(200, 100)].join("\n"), // 1800
    "utf-8",
  );
});

after(async () => {
  if (savedRoot === undefined) delete process.env.HYDRA_CLAUDE_PROJECTS_ROOT;
  else process.env.HYDRA_CLAUDE_PROJECTS_ROOT = savedRoot;
  await rm(root, { recursive: true, force: true });
});

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("GET /metrics/session-tokens (issue #3250)", () => {
  test("handler is mounted on the metrics router", () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/session-tokens");
    assert.ok(get, "GET /metrics/session-tokens handler should exist");
  });

  test("a resolvable session returns 200 with the summed transcript tokens", async () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/session-tokens");
    const res = mockRes();
    await get!(mockReq({ session: UUID }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.session, UUID);
    assert.equal(res._body.tokens, 1800, "the two usage lines sum to 1800");
  });

  test("an unknown session returns tokens:0 (honest unknown, not a fabricated count)", async () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/session-tokens");
    const res = mockRes();
    await get!(mockReq({ session: "11111111-2222-3333-4444-555555555555" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.tokens, 0);
  });

  test("a non-UUID session returns tokens:0 (never touches disk)", async () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/session-tokens");
    const res = mockRes();
    await get!(mockReq({ session: "not-a-uuid" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.tokens, 0);
  });

  test("a missing session query is a 400 schema-validation-failed", async () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/session-tokens");
    const res = mockRes();
    await get!(mockReq({}), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});
