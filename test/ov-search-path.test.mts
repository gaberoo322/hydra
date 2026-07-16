/**
 * test/ov-search-path.test.mts — the /api/v1/search/find contract regression guard
 * (issue #2586).
 *
 * # Why this test exists
 *
 * Issue #2586 ("Knowledge search endpoint broken: /search/find returns 404")
 * reported the knowledge plane as broken and proposed rewriting the search path.
 * That premise was a MISDIAGNOSIS: `trackedOvSearch` in
 * `src/knowledge-base/ov-search.ts` already POSTs the **`/api/v1/search/find`**
 * path, which the live OpenViking container serves 200 with real scored hits.
 * The 404 in the issue evidence came from a `curl` that dropped the `/api/v1`
 * prefix (bare `/search/find` genuinely 404s) — a client-side probing error, not
 * a code bug. The `/api/v1` prefix is therefore **load-bearing**.
 *
 * This suite pins that contract end-to-end: it stubs the process-global `fetch`
 * (the same seam `test/ov-request.test.mts` uses), drives a real
 * `trackedOvSearch` / `loadKnowledgeBaseForPrompt` call through the OpenViking
 * Request Adapter, and asserts the URL that actually hit the wire ends with the
 * `/api/v1/search/find` route — including the fallback re-query. A future
 * well-meaning "fix" that silently drops the `/api/v1` prefix (rewriting it to
 * the 404 variant the issue suggested) fails here BEFORE it can break the
 * knowledge plane in production.
 *
 * It is a NEW top-level `describe` with its own `afterEach` fetch restore — it
 * does NOT nest under another suite's teardown (per the shared-teardown authoring
 * rule) and does NOT touch Redis: the injected metrics counter uses a no-op
 * persist sink so `counter.flush()` never reaches `recordOvSearchDelta`.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const { trackedOvSearch, loadKnowledgeBaseForPrompt } =
  await import("../src/knowledge-base/ov-search.ts");
const { OvSearchMetricsCounter } =
  await import("../src/knowledge-base/ov-search-counter.ts");
const { ovBaseUrl } = await import("../src/knowledge-base/ov-request.ts");

/** The one contract this suite defends — the exact route the live OV serves 200. */
const EXPECTED_PATH = "/api/v1/search/find";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realErr = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realErr;
});

/**
 * A metrics counter whose durable-persist sink is a no-op — keeps the test off
 * Redis so `trackedOvSearch`'s opportunistic `flush()` is inert. A fresh instance
 * per case (no shared global) per the per-case-isolation authoring rule.
 */
function isolatedCounter() {
  return new OvSearchMetricsCounter({ persist: async () => undefined });
}

/**
 * Stub `globalThis.fetch`, recording every URL it is called with, and answer with
 * an OV-shaped `{status:"ok", result:{resources,memories}}` body.
 */
function captureFetch(
  resultBody: { resources?: any[]; memories?: any[] } = { resources: [], memories: [] },
): string[] {
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    seenUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", result: resultBody }),
      text: async () => "",
    };
  }) as any;
  // Silence the module's per-call console.log noise during the test.
  console.log = () => {};
  console.error = () => {};
  return seenUrls;
}

describe("ov-search: /api/v1/search/find contract (issue #2586 regression guard)", () => {
  test("trackedOvSearch POSTs the /api/v1/search/find route, prefix intact", async () => {
    const seenUrls = captureFetch({ resources: [{ id: "r1" }], memories: [] });

    const { resources } = await trackedOvSearch("control-loop", 3, null, isolatedCounter());

    assert.equal(seenUrls.length, 1, "exactly one primary search request");
    assert.equal(
      seenUrls[0],
      `${ovBaseUrl()}${EXPECTED_PATH}`,
      "the search request URL must be ovBaseUrl() + /api/v1/search/find — the /api/v1 prefix is load-bearing (issue #2586)",
    );
    assert.ok(
      seenUrls[0].endsWith(EXPECTED_PATH),
      "path must end with /api/v1/search/find, never the prefix-less /search/find that 404s",
    );
    assert.deepEqual(resources, [{ id: "r1" }], "results flow through unchanged");
  });

  test("the fallback re-query also targets /api/v1/search/find (no prefix drop on the second hop)", async () => {
    // Empty primary result triggers the simplified fallback query — it must POST
    // the SAME /api/v1/search/find route, not a divergent path.
    const seenUrls = captureFetch({ resources: [], memories: [] });

    await trackedOvSearch("planner agent context for: something", 5, null, isolatedCounter());

    assert.equal(seenUrls.length, 2, "primary + one fallback request");
    for (const url of seenUrls) {
      assert.equal(
        url,
        `${ovBaseUrl()}${EXPECTED_PATH}`,
        "both the primary and the fallback search must target /api/v1/search/find (issue #2586)",
      );
    }
  });

  test("loadKnowledgeBaseForPrompt (the planner-prompt enrichment read) uses the same route", async () => {
    // The learning-context seam reads OV through trackedOvSearch too — pin its
    // path so a future rewrite of the prompt loader cannot drop the prefix.
    const seenUrls = captureFetch({
      resources: [],
      memories: [{ abstract: "a learned pattern" }],
    });

    const { content, itemCount } = await loadKnowledgeBaseForPrompt("planner");

    assert.ok(seenUrls.length >= 1, "at least the primary search request");
    assert.equal(
      seenUrls[0],
      `${ovBaseUrl()}${EXPECTED_PATH}`,
      "loadKnowledgeBaseForPrompt must query /api/v1/search/find (issue #2586)",
    );
    assert.equal(itemCount, 1, "the memory abstract contributes one prompt item");
    assert.ok(content.includes("a learned pattern"), "the abstract renders into the prompt block");
  });
});
