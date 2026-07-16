/**
 * test/openviking-fallback.test.mts — lexical-distance fallback ranking when
 * OpenViking is unavailable (issue #3341).
 *
 * Pins the #3341 design-concept invariants:
 *   - the pure per-token normalized-Levenshtein scorer (fallback-scorer.ts):
 *     deterministic, lexicographic tie-break, zero-score drop, never throws;
 *   - trackedOvSearch fires the lexical fallback ONLY on `isOvFailure` (any
 *     ov-* code — exercised here via ov-non-2xx and ov-timeout), serving
 *     `resources` only (uri = local file path, entry-level score) with the
 *     additive `rankingMode: "lexical"` field and empty `memories`;
 *   - OV-up behavior is unchanged: semantic results pass through
 *     (`rankingMode: "semantic"`), the zero-result simplified-query retry
 *     stays semantic and never cascades to lexical, and the corpus getter is
 *     never consulted while OV is up;
 *   - degradation floors: empty corpus or a throwing corpus getter degrade to
 *     the pre-#3341 empty result (no `rankingMode` key) — never a throw;
 *   - fallback URIs are local paths, so `hasIndexedResourceUri` /
 *     `probeOvSourceResourcesPresent` staleness semantics are structurally
 *     unchanged;
 *   - HashDedupAdapter.getIndexedPaths() returns the merged snapshot of the
 *     hydrated source-hash map (and the indexer.ts facade delegator stays a
 *     thin pass-through).
 *
 * Test infra mirrors test/ov-search-path.test.mts: stub the process-global
 * `fetch` (the ov-request seam), inject a fresh OvSearchMetricsCounter with a
 * no-op persist sink so `counter.flush()` never touches Redis, and restore in
 * `afterEach`. Top-level describes with their own lifecycles — no piggyback on
 * a sibling suite's teardown.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const { lexicalPathScore, rankLexicalFallback } = await import(
  "../src/knowledge-base/fallback-scorer.ts"
);
const { trackedOvSearch } = await import("../src/knowledge-base/ov-search.ts");
const { OvSearchMetricsCounter } = await import(
  "../src/knowledge-base/ov-search-counter.ts"
);
const { HashDedupAdapter } = await import(
  "../src/knowledge-base/hash-dedup.ts"
);
const { getIndexedPaths, hasIndexedResourceUri } = await import(
  "../src/knowledge-base/indexer.ts"
);

// ---------------------------------------------------------------------------
// Shared fixtures + fetch stubs
// ---------------------------------------------------------------------------

const CORPUS = [
  "/home/gabe/hydra/src/knowledge-base/ov-search.ts",
  "/home/gabe/hydra/src/tier-classifier.ts",
  "/home/gabe/hydra/src/backlog/lanes.ts",
  "/home/gabe/hydra/src/scheduler/heartbeat.ts",
];

const realFetch = globalThis.fetch;
const realLog = console.log;
const realErr = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realErr;
});

/** Fresh, Redis-free metrics counter per case (per-case-isolation rule). */
function isolatedCounter() {
  return new OvSearchMetricsCounter({ persist: async () => undefined });
}

function silenceConsole(): string[] {
  const lines: string[] = [];
  console.log = (...args: any[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    lines.push(args.map(String).join(" "));
  };
  return lines;
}

/** OV answers 2xx with the given result body — the healthy path. */
function stubOvUp(
  resultBody: { resources?: any[]; memories?: any[] } = {
    resources: [],
    memories: [],
  },
): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", result: resultBody }),
      text: async () => "",
    };
  }) as any;
  return state;
}

/** OV reachable but failing — non-2xx classifies as `ov-non-2xx`. */
function stubOvNon2xx(): void {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => "internal error",
  })) as any;
}

/** The AbortSignal timeout shape — classifies as `ov-timeout`. */
function stubOvTimeout(): void {
  globalThis.fetch = (async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  }) as any;
}

// ---------------------------------------------------------------------------
// 1. Pure scorer (fallback-scorer.ts)
// ---------------------------------------------------------------------------

describe("fallback-scorer: per-token normalized Levenshtein (issue #3341)", () => {
  test("ranks the plausibly-relevant path top-1 (prototype contract)", () => {
    const ranked = rankLexicalFallback("openviking search fallback", CORPUS);
    assert.equal(ranked[0].path, "/home/gabe/hydra/src/knowledge-base/ov-search.ts");

    const tiered = rankLexicalFallback(
      "tier classification of PR paths",
      CORPUS,
    );
    assert.equal(tiered[0].path, "/home/gabe/hydra/src/tier-classifier.ts");
  });

  test("scores are in [0,1] and ordered descending", () => {
    const ranked = rankLexicalFallback("scheduler heartbeat", CORPUS, 10);
    assert.ok(ranked.length > 0);
    for (const { score } of ranked) {
      assert.ok(score >= 0 && score <= 1, `score ${score} out of [0,1]`);
    }
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(
        ranked[i - 1].score >= ranked[i].score,
        "not descending by score",
      );
    }
  });

  test("equal scores tie-break lexicographically by path (stable)", () => {
    // Same tokens, different roots — identical per-token scores.
    const paths = ["zzz/alpha-beta.md", "aaa/alpha-beta.md"];
    const ranked = rankLexicalFallback("alpha beta", paths, 10);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].score, ranked[1].score);
    assert.equal(ranked[0].path, "aaa/alpha-beta.md");
    assert.equal(ranked[1].path, "zzz/alpha-beta.md");
  });

  test("drops zero-score paths (noise floor) and respects limit", () => {
    // "aaa" vs "zzz": distance == maxLen -> similarity 0 -> dropped.
    const ranked = rankLexicalFallback("aaa", ["zzz"], 10);
    assert.deepEqual(ranked, []);

    const limited = rankLexicalFallback("scheduler heartbeat", CORPUS, 2);
    assert.ok(limited.length <= 2);
  });

  test("empty query / empty corpus rank to [] without throwing", () => {
    assert.deepEqual(rankLexicalFallback("", CORPUS), []);
    assert.deepEqual(rankLexicalFallback("of a to", CORPUS), []); // all tokens <= 2 chars
    assert.deepEqual(rankLexicalFallback("anything at all", []), []);
    assert.equal(lexicalPathScore("", "src/foo.ts"), 0);
    assert.equal(lexicalPathScore("query words", ""), 0);
  });

  test("deterministic: identical input yields identical ranking", () => {
    const a = rankLexicalFallback("knowledge base search", CORPUS, 10);
    const b = rankLexicalFallback("knowledge base search", CORPUS, 10);
    assert.deepEqual(a, b);
  });

  test("exact token match scores 1.0 for a single-token query", () => {
    assert.equal(lexicalPathScore("heartbeat", "src/scheduler/heartbeat.ts"), 1);
  });
});

// ---------------------------------------------------------------------------
// 2. trackedOvSearch degradation behavior
// ---------------------------------------------------------------------------

describe("trackedOvSearch lexical fallback on OV failure (issue #3341)", () => {
  test("ov-non-2xx: serves lexically-ranked resources, empty memories, rankingMode=lexical", async () => {
    stubOvNon2xx();
    const lines = silenceConsole();
    const counter = isolatedCounter();

    const out = await trackedOvSearch(
      "openviking search fallback",
      5,
      null,
      counter,
      () => CORPUS,
    );

    assert.equal(out.rankingMode, "lexical");
    assert.deepEqual(out.memories, []);
    assert.ok(out.resources.length > 0);
    assert.equal(
      out.resources[0].uri,
      "/home/gabe/hydra/src/knowledge-base/ov-search.ts",
    );
    for (const r of out.resources) {
      assert.equal(typeof r.uri, "string");
      assert.equal(typeof r.score, "number");
    }
    // The failed semantic search still records an error (metrics unchanged).
    assert.equal(counter.snapshot().errors, 1);
    // Observability: one info line carrying the ov-* code + served count.
    assert.ok(
      lines.some(
        (l) =>
          l.includes("lexical fallback") &&
          l.includes("code=ov-non-2xx") &&
          l.includes("rankingMode=lexical") &&
          l.includes(`served=${out.resources.length}`),
      ),
      `expected lexical-fallback info log line, got: ${JSON.stringify(lines)}`,
    );
  });

  test("ov-timeout: fallback fires on the timeout code too (all isOvFailure codes)", async () => {
    stubOvTimeout();
    silenceConsole();

    const out = await trackedOvSearch(
      "tier classification of PR paths",
      5,
      null,
      isolatedCounter(),
      () => CORPUS,
    );

    assert.equal(out.rankingMode, "lexical");
    assert.equal(out.resources[0].uri, "/home/gabe/hydra/src/tier-classifier.ts");
    assert.deepEqual(out.memories, []);
  });

  test("fallback respects the limit parameter", async () => {
    stubOvNon2xx();
    silenceConsole();

    const out = await trackedOvSearch(
      "hydra src ts",
      2,
      null,
      isolatedCounter(),
      () => CORPUS,
    );
    assert.equal(out.rankingMode, "lexical");
    assert.ok(out.resources.length <= 2);
  });

  test("empty corpus degrades to the pre-#3341 empty result (no rankingMode key)", async () => {
    stubOvNon2xx();
    silenceConsole();

    const out = await trackedOvSearch(
      "openviking search fallback",
      5,
      null,
      isolatedCounter(),
      () => [],
    );
    assert.deepEqual(out, { resources: [], memories: [] });
    assert.ok(!("rankingMode" in out));
  });

  test("throwing corpus getter degrades to empty result — trackedOvSearch never throws", async () => {
    stubOvNon2xx();
    const lines = silenceConsole();

    const out = await trackedOvSearch(
      "openviking search fallback",
      5,
      null,
      isolatedCounter(),
      () => {
        throw new Error("corpus exploded");
      },
    );
    assert.deepEqual(out, { resources: [], memories: [] });
    assert.ok(
      lines.some((l) => l.includes("lexical fallback error")),
      "scorer/corpus error must be logged loud",
    );
  });

  test("fallback URIs are local paths — probe staleness semantics unchanged", async () => {
    stubOvNon2xx();
    silenceConsole();

    const out = await trackedOvSearch(
      "openviking search fallback",
      5,
      null,
      isolatedCounter(),
      () => CORPUS,
    );
    assert.ok(out.resources.length > 0);
    for (const r of out.resources) {
      assert.ok(
        !String(r.uri).startsWith("viking://resources/"),
        `fallback uri must never carry the indexed-resource prefix: ${r.uri}`,
      );
    }
    // The exact predicate probeOvSourceResourcesPresent keys on.
    assert.equal(hasIndexedResourceUri(out.resources), false);
  });

  test("OV up with hits: semantic pass-through, corpus never consulted", async () => {
    const hits = {
      resources: [{ uri: "viking://resources/src/foo.ts", score: 0.9 }],
      memories: [{ uri: "viking://memories/abc", abstract: "a lesson" }],
    };
    stubOvUp(hits);
    silenceConsole();
    let corpusReads = 0;

    const out = await trackedOvSearch(
      "any query",
      5,
      null,
      isolatedCounter(),
      () => {
        corpusReads++;
        return CORPUS;
      },
    );

    assert.equal(out.rankingMode, "semantic");
    assert.deepEqual(out.resources, hits.resources);
    assert.deepEqual(out.memories, hits.memories);
    assert.equal(corpusReads, 0, "corpus getter must not run while OV is up");
  });

  test("OV up with zero results: simplified-query retry stays semantic, no lexical cascade", async () => {
    const fetchState = stubOvUp({ resources: [], memories: [] });
    silenceConsole();
    let corpusReads = 0;
    const counter = isolatedCounter();

    const out = await trackedOvSearch(
      "planner agent context for: something obscure",
      5,
      null,
      counter,
      () => {
        corpusReads++;
        return CORPUS;
      },
    );

    // Both the original and the simplified fallback query hit the wire.
    assert.equal(fetchState.calls, 2);
    assert.equal(counter.snapshot().fallbackAttempts, 1);
    assert.equal(out.rankingMode, "semantic");
    assert.deepEqual(out.resources, []);
    assert.deepEqual(out.memories, []);
    assert.equal(
      corpusReads,
      0,
      "zero results with OV up is a semantic answer — never lexical",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The corpus getter (hash-dedup leaf + indexer facade)
// ---------------------------------------------------------------------------

describe("HashDedupAdapter.getIndexedPaths corpus getter (issue #3341)", () => {
  test("returns the hydrated source-hash paths as a defensive snapshot", async () => {
    const persisted = new Map<string, string>([
      ["/repo/src/a.ts", "sha-a"],
      ["/repo/src/b.ts", "sha-b"],
    ]);
    const adapter = new HashDedupAdapter({
      load: async () => persisted,
      persist: async () => undefined,
    });
    assert.deepEqual(adapter.getIndexedPaths(), []); // unhydrated -> empty

    const loaded = await adapter.loadPersistedHashes();
    assert.equal(loaded, 2);

    const paths = adapter.getIndexedPaths();
    assert.deepEqual(paths.sort(), ["/repo/src/a.ts", "/repo/src/b.ts"]);

    // Snapshot: mutating the returned array must not leak into the adapter.
    paths.length = 0;
    assert.equal(adapter.getIndexedPaths().length, 2);
  });

  test("indexer.ts facade delegator is a thin array-returning pass-through", () => {
    const paths = getIndexedPaths();
    assert.ok(Array.isArray(paths));
  });
});
