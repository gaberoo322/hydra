/**
 * Regression test for issue #3250 — the per-session token-recovery seam.
 *
 * The autopilot's `cumulative_tokens` run field was permanently 0: the primary
 * reap path takes its count from the SubagentStop hook, which does not expose
 * the subagent's token usage. `tokensForSession` recovers the REAL count from
 * the completed dispatch's JSONL transcript, keyed by sessionId — the count
 * reap.py joins on when the hook floor is 0. These tests pin:
 *   - `sumSessionTokens` sums usage lines over a whole transcript with NO time
 *     cutoff (a completed dispatch's whole transcript is its usage), reusing the
 *     same `parseUsageLine` semantics as the rolling-window scan;
 *   - `tokensForSession` is total + best-effort: a non-UUID id, an unresolvable
 *     session, and a read error all return 0 (the honest "unknown" sentinel,
 *     never a fabricated nonzero — invariant 3), and it sums subagent shards.
 */
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { sumSessionTokens, tokensForSession } from "../src/cost/transcript-scan.ts";

const UUID = "38c78e5c-884f-47ae-acb4-5d48286776b3";

function usageLine(opts: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  model?: string;
  ts?: string;
}): string {
  return JSON.stringify({
    timestamp: opts.ts ?? "2026-07-12T20:00:00.000Z",
    message: {
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
      },
    },
  });
}

describe("sumSessionTokens (issue #3250)", () => {
  test("sums input+output+cacheRead+cacheCreation across every usage line", () => {
    const lines = [
      usageLine({ input: 100, output: 50 }), // 150
      usageLine({ cacheRead: 1000, cacheCreation: 200 }), // 1200
      usageLine({ input: 10, output: 5, cacheRead: 5 }), // 20
    ];
    assert.equal(sumSessionTokens(lines), 1370);
  });

  test("ignores blank lines, non-JSON lines, and lines with no usage block", () => {
    const lines = [
      "",
      "not json at all",
      JSON.stringify({ timestamp: "2026-07-12T20:00:00Z", message: { model: "x" } }), // no usage
      usageLine({ input: 42 }),
    ];
    assert.equal(sumSessionTokens(lines), 42);
  });

  test("applies NO time cutoff — an old transcript still counts (unlike the rolling window)", () => {
    // A dispatch that ran a year ago is still that dispatch's usage.
    const lines = [usageLine({ input: 500, ts: "2024-01-01T00:00:00.000Z" })];
    assert.equal(sumSessionTokens(lines), 500);
  });

  test("a transcript with only zero-usage lines sums to 0 (honest unknown)", () => {
    const lines = [usageLine({}), usageLine({ input: 0, output: 0 })];
    assert.equal(sumSessionTokens(lines), 0);
  });

  test("an empty transcript sums to 0", () => {
    assert.equal(sumSessionTokens([]), 0);
  });
});

describe("tokensForSession (issue #3250)", () => {
  test("returns 0 for a non-UUID-shaped session id (never touches disk)", async () => {
    let resolved = false;
    const n = await tokensForSession("not-a-uuid", {
      resolvePath: async () => {
        resolved = true;
        return "/never";
      },
    });
    assert.equal(n, 0);
    assert.equal(resolved, false, "a non-UUID id must short-circuit before any resolve");
  });

  test("returns 0 for an empty session id", async () => {
    assert.equal(await tokensForSession("", {}), 0);
  });

  test("returns 0 when the transcript cannot be resolved (unknown session)", async () => {
    const n = await tokensForSession(UUID, {
      resolvePath: async () => null,
      listShards: async () => [],
    });
    assert.equal(n, 0);
  });

  test("sums the primary transcript's usage", async () => {
    const content = [usageLine({ input: 300, output: 100 }), usageLine({ cacheRead: 600 })].join(
      "\n",
    );
    const n = await tokensForSession(UUID, {
      resolvePath: async () => "/fake/primary.jsonl",
      listShards: async () => [],
      read: async () => content,
    });
    assert.equal(n, 1000);
  });

  test("sums the primary transcript PLUS its subagent shards", async () => {
    const primary = usageLine({ input: 100 });
    const shardA = usageLine({ output: 200 });
    const shardB = usageLine({ cacheCreation: 50 });
    const byPath: Record<string, string> = {
      "/fake/primary.jsonl": primary,
      "/fake/a.jsonl": shardA,
      "/fake/b.jsonl": shardB,
    };
    const n = await tokensForSession(UUID, {
      resolvePath: async () => "/fake/primary.jsonl",
      listShards: async () => ["/fake/a.jsonl", "/fake/b.jsonl"],
      read: async (p) => byPath[p] ?? "",
    });
    assert.equal(n, 350);
  });

  test("a read error on one shard is swallowed — the rest still sum (best-effort)", async () => {
    const n = await tokensForSession(UUID, {
      resolvePath: async () => "/fake/primary.jsonl",
      listShards: async () => ["/fake/broken.jsonl"],
      read: async (p) => {
        if (p === "/fake/broken.jsonl") throw new Error("EIO");
        return usageLine({ input: 77 });
      },
    });
    assert.equal(n, 77);
  });

  test("a resolve error returns 0 (never throws into the caller)", async () => {
    const n = await tokensForSession(UUID, {
      resolvePath: async () => {
        throw new Error("resolve boom");
      },
    });
    assert.equal(n, 0);
  });
});
