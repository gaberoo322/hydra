/**
 * learning/ov-search.ts — OpenViking search + session lifecycle
 *
 * Extracted from learning.ts (issue #219) so the OV search wrapper, in-memory
 * metrics, fallback-query helper, and session factory live independently of
 * agent memory and reflection storage.
 *
 * Public API:
 *   buildFallbackQuery                       — pure helper, exported for tests
 *   trackedOvSearch                          — used by codex-runner + this module
 *   loadKnowledgeBaseForPrompt               — {content,itemCount,itemIds} read
 *                                              for the learning context seam
 *                                              (#1455; itemIds added #2717)
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 *
 * The search-quality metrics counter (`OvSearchMetricsCounter`, the
 * `defaultMetrics` singleton, `getOvSearchMetrics` / `resetOvSearchMetrics`,
 * `computeFlushDelta`) lives in the focused sibling leaf
 * `ov-search-counter.ts` (extracted in issue #3344, mirroring the earlier
 * ov-request.ts / hash-dedup.ts / ov-upload.ts extractions). The search path
 * here only *records into* the counter via `defaultMetrics.record*(...)`.
 */

// OpenViking connection config — single source of truth in ov-config.ts (issue #231).
// Re-exported under the historical OV_URL / OV_KEY names so existing
// importers keep compiling without churn.
import { createHash } from "node:crypto";
import { OPENVIKING_URL, OPENVIKING_API_KEY } from "./ov-config.ts";
// Issue #954: the OpenViking Request Adapter — all OV HTTP request mechanics
// (URL join, auth headers, timeout, error classification, JSON unwrap) live
// behind this seam now. This module keeps its domain behaviour (metrics +
// fallback) and routes the raw fetch through `ovPostJson`.
import { ovPostJson, isOvFailure } from "./ov-request.ts";
// Issue #3344: the search-quality metrics counter lives in its own focused
// leaf. The search path here records into the process-wide `defaultMetrics`
// singleton; the counter class appears only as `trackedOvSearch`'s injectable
// param type (issue #1926).
import { defaultMetrics, OvSearchMetricsCounter } from "./ov-search-counter.ts";

export const OV_URL = OPENVIKING_URL;
export const OV_KEY = OPENVIKING_API_KEY;

// ===========================================================================
// Fallback query
// ===========================================================================

/**
 * Build a simplified fallback query from the original query.
 * Strips anchor-specific detail, keeps only agent name + generic terms.
 */
export function buildFallbackQuery(originalQuery: string): string {
  // Extract agent name if present (e.g., "planner agent context for: ...")
  const agentMatch = originalQuery.match(/^(\w+)\s+agent/i);
  const agentName = agentMatch ? agentMatch[1] : "";

  // Remove common filler phrases
  let simplified = originalQuery
    .replace(/\bagent\s+context\s+for:?\s*/gi, "")
    .replace(/\bagent\s+lessons?\s*/gi, "")
    .replace(/\bfailures?\s+prevention\b/gi, "patterns")
    .replace(/[^\w\s]/g, " ")  // strip punctuation
    .replace(/\s+/g, " ")
    .trim();

  // Take only the first 4 meaningful words (skip very short words)
  const words = simplified.split(" ").filter(w => w.length > 2);
  const kept = words.slice(0, 4).join(" ");

  // Prepend agent name if we found one and it's not already included
  if (agentName && !kept.toLowerCase().startsWith(agentName.toLowerCase())) {
    return `${agentName} patterns ${kept}`.trim();
  }

  return kept || "patterns context";
}

// ===========================================================================
// Tracked OV search
// ===========================================================================

/**
 * Tracked OV search -- wraps a fetch to /api/v1/search/find with metrics + logging + fallback.
 * Returns { resources, memories } arrays.
 *
 * `counter` is the injectable metrics sink (issue #1926); it defaults to the
 * process-wide {@link defaultMetrics} singleton so production callers and
 * `api/openviking.ts` are unchanged. A test passes a fresh
 * `new OvSearchMetricsCounter()` to isolate counts per case.
 */
export async function trackedOvSearch(
  query: string,
  limit = 5,
  sessionId?: string | null,
  counter: OvSearchMetricsCounter = defaultMetrics,
): Promise<{ resources: any[]; memories: any[] }> {
  const startMs = Date.now();
  let resources: any[] = [];
  let memories: any[] = [];

  try {
    const body: Record<string, any> = { query, limit };
    if (sessionId) body.session_id = sessionId;

    // LOAD-BEARING PATH — do NOT drop the `/api/v1` prefix. The live OpenViking
    // container serves `POST /api/v1/search/find` 200 with real hits; the
    // prefix-less `/search/find` 404s. Issue #2586 misdiagnosed a bare-path curl
    // 404 as a code bug and proposed rewriting this to `/search/find` — that
    // would break the knowledge plane. `test/ov-search-path.test.mts` pins this.
    const result = await ovPostJson<any>("/api/v1/search/find", body, { timeout: 5000 });

    const latencyMs = Date.now() - startMs;

    if (isOvFailure(result)) {
      counter.recordError(latencyMs);
      console.log(`[OV Search] query="${query.slice(0, 80)}" status=${result.code} latency=${latencyMs}ms ERROR`);
      return { resources: [], memories: [] };
    }

    const data = result.data;
    resources = data?.result?.resources || [];
    memories = data?.result?.memories || [];
    const resultCount = resources.length + memories.length;

    counter.recordSearch(latencyMs, resultCount);

    if (resultCount === 0) {
      console.log(`[OV Search] query="${query.slice(0, 80)}" results=0 latency=${latencyMs}ms -- attempting fallback`);

      // Fallback: simplified query
      const fallbackQuery = buildFallbackQuery(query);
      counter.recordFallbackAttempt();

      const fbStartMs = Date.now();
      try {
        const fbBody: Record<string, any> = { query: fallbackQuery, limit };
        if (sessionId) fbBody.session_id = sessionId;

        const fbResult = await ovPostJson<any>("/api/v1/search/find", fbBody, { timeout: 5000 });

        const fbLatencyMs = Date.now() - fbStartMs;

        if (!isOvFailure(fbResult)) {
          const fbData = fbResult.data;
          const fbResources = fbData?.result?.resources || [];
          const fbMemories = fbData?.result?.memories || [];
          const fbCount = fbResources.length + fbMemories.length;

          if (fbCount > 0) {
            counter.recordFallbackSuccess();
            resources = fbResources;
            memories = fbMemories;
            console.log(`[OV Search] fallback query="${fallbackQuery.slice(0, 80)}" results=${fbCount} latency=${fbLatencyMs}ms SUCCESS`);
          } else {
            console.log(`[OV Search] fallback query="${fallbackQuery.slice(0, 80)}" results=0 latency=${fbLatencyMs}ms -- no results`);
          }
        }
      } catch (err: any) {
        console.error(`[OV Search] fallback error: ${err.message}`);
      }
    } else {
      console.log(`[OV Search] query="${query.slice(0, 80)}" results=${resultCount} latency=${latencyMs}ms`);
    }
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    counter.recordError(latencyMs);
    console.error(`[OV Search] query="${query.slice(0, 80)}" error="${err.message}" latency=${latencyMs}ms`);
  }

  // Issue #1440: opportunistic, time-gated, never-throw flush of the counter
  // delta into the hour-bucketed Redis window. At most one write per flush
  // window regardless of search volume; awaited but self-contained so a Redis
  // hiccup degrades to a logged warning, not a failed search.
  await counter.flush(false);

  return { resources, memories };
}

// ===========================================================================
// Prompt-block read (issue #1455)
// ===========================================================================

/**
 * Knowledge Base read for the dispatch-time learning context (issue #1455).
 *
 * Searches OpenViking for the agent's learned patterns and renders them into a
 * prompt block, returning `{content,itemCount}` — the `{content,itemCount}`
 * surface every learning source exposes so the composition seam (learning.ts)
 * can drive a single generic loader rather than a bespoke per-source one.
 *
 * `itemCount` is the count of OV memories that actually contributed to the
 * block (non-empty abstracts), sourced from the search data here — never
 * regex-scanned out of the rendered markdown at the seam (#804 count-from-data
 * contract). `content` is "" / `itemCount` 0 when the search returned nothing.
 *
 * Per CONTEXT.md the Knowledge Base is queried by subagents directly at their
 * own seam; this read only *enriches* the planner prompt, so the cluster stays
 * composed-not-owned at learning.ts. The render lives here (cluster-local
 * work), the envelope mapping (hit/miss/error) stays at the seam.
 */
export async function loadKnowledgeBaseForPrompt(
  agent: string,
): Promise<{ content: string; itemCount: number; itemIds: string[] }> {
  const { memories } = await trackedOvSearch(
    `${agent} agent lessons failures prevention`,
    5,
  );
  const top = memories.slice(0, 5);
  const parts: string[] = [];
  // Issue #2717: derive a STABLE per-item identifier for each served item from
  // source DATA here (not by regex-scanning the rendered markdown at the route —
  // the #804 count-from-data contract). Prefer the memory's own `uri` when it is
  // a non-empty string (a real content-addressed OpenViking id); otherwise fall
  // back to a sha256 hex prefix of the SAME 300-char abstract slice that renders
  // into the bullet, so the same served item hashes to the same id across
  // fetches — exactly the join key the deferred #2717 correlation slice needs.
  const itemIds: string[] = [];
  for (const mem of top) {
    const abstract = mem.abstract || mem.content || "";
    if (!abstract.trim()) continue;
    const slice = abstract.slice(0, 300);
    parts.push(`- ${slice}`);
    const uri = typeof mem.uri === "string" ? mem.uri.trim() : "";
    itemIds.push(
      uri || createHash("sha256").update(slice).digest("hex").slice(0, 16),
    );
  }
  if (parts.length === 0) return { content: "", itemCount: 0, itemIds: [] };
  return {
    content: `# ${agent} — Learned Patterns (from OpenViking)\n\n${parts.join("\n")}`,
    itemCount: parts.length,
    itemIds,
  };
}
