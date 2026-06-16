/**
 * test/anthropic-request.test.mts — the Anthropic Request Adapter's error modes,
 * the AbortSignal timeout discipline, and the cost derivation, exercised against
 * an injected `fetchImpl` (issue #1959).
 *
 * The adapter is the one focused test surface for the Anthropic Messages request
 * discipline: before the seam, the timeout/error-classification/cost-arithmetic
 * lived inline in `defaultLlmClient` and was only reachable by injecting the
 * engine's high-level `LlmClient` (which short-circuited the whole boundary).
 * Here we inject `fetchImpl` directly and assert the discriminated never-throw
 * `AnthropicResult` for each mode, plus the AbortSignal presence the old inline
 * client lacked.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  anthropicMessages,
  isAnthropicFailure,
  isAnthropicOk,
  deriveCostUsd,
  extractFirstTextBlock,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
} = await import("../src/anthropic/request.ts");

const RATES = { input_per_mtok_usd: 1.0, output_per_mtok_usd: 5.0 };

/** A minimal Response-like stub. */
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
}): any {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: opts.json ?? (async () => ({})),
    text: opts.text ?? (async () => ""),
  };
}

const REQ = {
  model: "claude-haiku-4-5",
  max_tokens: 512,
  messages: [{ role: "user", content: "hi" }],
};

describe("anthropic-request: success + cost derivation", () => {
  test("returns ok with the first text block, typed usage, and derived cost", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "hello world" }],
          usage: { input_tokens: 2_000_000, output_tokens: 1_000_000 },
        }),
      })) as any;
    const r = await anthropicMessages(REQ, { apiKey: "k", fetchImpl, costRates: RATES });
    assert.equal(isAnthropicOk(r), true);
    assert.equal(r.ok && r.text, "hello world");
    assert.equal(r.ok && r.usage.input_tokens, 2_000_000);
    // 2M input @ $1/Mtok + 1M output @ $5/Mtok = 2 + 5 = 7
    assert.equal(r.ok && r.cost_usd, 7);
  });

  test("usage defaults to 0/0 (cost 0) when the response omits a usage block", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: true, json: async () => ({ content: [] }) })) as any;
    const r = await anthropicMessages(REQ, { apiKey: "k", fetchImpl, costRates: RATES });
    assert.equal(r.ok && r.cost_usd, 0);
    assert.equal(r.ok && r.text, "");
  });
});

describe("anthropic-request: error modes", () => {
  test("anthropic-no-api-key — no key configured (engine stays inert)", async () => {
    const fetchImpl = (async () => fakeResponse({ ok: true })) as any;
    const r = await anthropicMessages(REQ, { apiKey: "", fetchImpl, costRates: RATES });
    assert.equal(isAnthropicFailure(r), true);
    assert.equal(r.ok === false && r.code, "anthropic-no-api-key");
  });

  test("anthropic-non-2xx — the API answered with !res.ok", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 429, text: async () => "rate limited" })) as any;
    const r = await anthropicMessages(REQ, { apiKey: "k", fetchImpl, costRates: RATES });
    assert.equal(r.ok === false && r.code, "anthropic-non-2xx");
  });

  test("anthropic-malformed-json — a 2xx body that fails JSON.parse", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })) as any;
    const r = await anthropicMessages(REQ, { apiKey: "k", fetchImpl, costRates: RATES });
    assert.equal(r.ok === false && r.code, "anthropic-malformed-json");
  });

  test("anthropic-timeout — the AbortSignal fired (TimeoutError)", async () => {
    const fetchImpl = (async () => {
      const err: any = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as any;
    const r = await anthropicMessages(REQ, {
      apiKey: "k",
      fetchImpl,
      timeout: 1,
      costRates: RATES,
    });
    assert.equal(r.ok === false && r.code, "anthropic-timeout");
  });

  test("anthropic-network-error — transport failure (ECONNREFUSED-class throw)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const r = await anthropicMessages(REQ, { apiKey: "k", fetchImpl, costRates: RATES });
    assert.equal(r.ok === false && r.code, "anthropic-network-error");
  });
});

describe("anthropic-request: wire shape + AbortSignal discipline", () => {
  test("posts to the Anthropic Messages URL with the version + api-key headers", async () => {
    let seenUrl = "";
    let seenInit: any = {};
    const fetchImpl = (async (url: string, init: any) => {
      seenUrl = url;
      seenInit = init;
      return fakeResponse({ ok: true, json: async () => ({ content: [] }) });
    }) as any;
    await anthropicMessages(REQ, { apiKey: "secret-key", fetchImpl, costRates: RATES });
    assert.equal(seenUrl, ANTHROPIC_MESSAGES_URL);
    assert.equal(seenInit.method, "POST");
    assert.equal(seenInit.headers["x-api-key"], "secret-key");
    assert.equal(seenInit.headers["anthropic-version"], ANTHROPIC_VERSION);
    assert.equal(seenInit.body, JSON.stringify(REQ));
  });

  test("attaches an AbortSignal on every request (the gap the inline client had)", async () => {
    let seenSignal: any = undefined;
    const fetchImpl = (async (_url: string, init: any) => {
      seenSignal = init.signal;
      return fakeResponse({ ok: true, json: async () => ({ content: [] }) });
    }) as any;
    await anthropicMessages(REQ, { apiKey: "k", fetchImpl, costRates: RATES });
    assert.ok(
      seenSignal && typeof seenSignal.aborted === "boolean",
      "request must carry an AbortSignal (AbortSignal.timeout)",
    );
  });
});

describe("anthropic-request: pure helpers", () => {
  test("deriveCostUsd computes input + output cost from token usage", () => {
    assert.equal(
      deriveCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, RATES),
      1,
    );
    assert.equal(
      deriveCostUsd({ input_tokens: 0, output_tokens: 2_000_000 }, RATES),
      10,
    );
  });

  test("extractFirstTextBlock returns the first text block, else empty string", () => {
    assert.equal(
      extractFirstTextBlock({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
      "a",
    );
    assert.equal(extractFirstTextBlock({ content: [{ type: "tool_use" }] }), "");
    assert.equal(extractFirstTextBlock(null), "");
    assert.equal(extractFirstTextBlock({}), "");
  });
});
