/**
 * learning/ov-search.ts — OpenViking search + session lifecycle
 *
 * Extracted from learning.ts (issue #219) so the OV search wrapper, in-memory
 * metrics, fallback-query helper, and session factory live independently of
 * agent memory and reflection storage.
 *
 * Public API:
 *   getOvSearchMetrics, resetOvSearchMetrics — metrics for /api/health
 *   buildFallbackQuery                       — pure helper, exported for tests
 *   trackedOvSearch                          — used by codex-runner + this module
 *   createCycleSession                       — control-loop session factory
 *
 * Internal helpers (used by other learning/* modules):
 *   ovFetch — POST helper that swallows network errors
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 */

// OpenViking connection config — single source of truth in ov-config.ts (issue #231).
// Re-exported under the historical OV_URL / OV_KEY / OV_HEADERS names so existing
// importers keep compiling without churn.
import { OPENVIKING_URL, OPENVIKING_API_KEY, OPENVIKING_HEADERS } from "./ov-config.ts";

export const OV_URL = OPENVIKING_URL;
export const OV_KEY = OPENVIKING_API_KEY;
export const OV_HEADERS = OPENVIKING_HEADERS;

// ===========================================================================
// Metrics (in-memory, resets on restart)
// ===========================================================================

export interface OvSearchMetrics {
  totalSearches: number;
  zeroResultCount: number;
  totalResults: number;
  totalLatencyMs: number;
  fallbackAttempts: number;
  fallbackSuccesses: number;
  errors: number;
}

const ovSearchMetrics: OvSearchMetrics = {
  totalSearches: 0,
  zeroResultCount: 0,
  totalResults: 0,
  totalLatencyMs: 0,
  fallbackAttempts: 0,
  fallbackSuccesses: 0,
  errors: 0,
};

export function getOvSearchMetrics(): OvSearchMetrics & { avgResultsPerQuery: number; avgLatencyMs: number; zeroResultRate: number } {
  const avg = ovSearchMetrics.totalSearches > 0
    ? ovSearchMetrics.totalResults / ovSearchMetrics.totalSearches
    : 0;
  const avgLatency = ovSearchMetrics.totalSearches > 0
    ? ovSearchMetrics.totalLatencyMs / ovSearchMetrics.totalSearches
    : 0;
  const zeroRate = ovSearchMetrics.totalSearches > 0
    ? ovSearchMetrics.zeroResultCount / ovSearchMetrics.totalSearches
    : 0;
  return {
    ...ovSearchMetrics,
    avgResultsPerQuery: Math.round(avg * 100) / 100,
    avgLatencyMs: Math.round(avgLatency * 100) / 100,
    zeroResultRate: Math.round(zeroRate * 1000) / 1000,
  };
}

/** Reset metrics -- exposed for testing only. */
export function resetOvSearchMetrics(): void {
  ovSearchMetrics.totalSearches = 0;
  ovSearchMetrics.zeroResultCount = 0;
  ovSearchMetrics.totalResults = 0;
  ovSearchMetrics.totalLatencyMs = 0;
  ovSearchMetrics.fallbackAttempts = 0;
  ovSearchMetrics.fallbackSuccesses = 0;
  ovSearchMetrics.errors = 0;
}

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
 */
export async function trackedOvSearch(
  query: string,
  limit = 5,
  sessionId?: string | null,
): Promise<{ resources: any[]; memories: any[] }> {
  const startMs = Date.now();
  let resources: any[] = [];
  let memories: any[] = [];

  try {
    const body: Record<string, any> = { query, limit };
    if (sessionId) body.session_id = sessionId;

    const res = await fetch(`${OV_URL}/api/v1/search/find`, {
      method: "POST",
      headers: OV_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    const latencyMs = Date.now() - startMs;

    if (!res.ok) {
      ovSearchMetrics.totalSearches++;
      ovSearchMetrics.errors++;
      ovSearchMetrics.totalLatencyMs += latencyMs;
      console.log(`[OV Search] query="${query.slice(0, 80)}" status=${res.status} latency=${latencyMs}ms ERROR`);
      return { resources: [], memories: [] };
    }

    const data = await res.json() as any;
    resources = data?.result?.resources || [];
    memories = data?.result?.memories || [];
    const resultCount = resources.length + memories.length;

    ovSearchMetrics.totalSearches++;
    ovSearchMetrics.totalResults += resultCount;
    ovSearchMetrics.totalLatencyMs += latencyMs;

    if (resultCount === 0) {
      ovSearchMetrics.zeroResultCount++;
      console.log(`[OV Search] query="${query.slice(0, 80)}" results=0 latency=${latencyMs}ms -- attempting fallback`);

      // Fallback: simplified query
      const fallbackQuery = buildFallbackQuery(query);
      ovSearchMetrics.fallbackAttempts++;

      const fbStartMs = Date.now();
      try {
        const fbBody: Record<string, any> = { query: fallbackQuery, limit };
        if (sessionId) fbBody.session_id = sessionId;

        const fbRes = await fetch(`${OV_URL}/api/v1/search/find`, {
          method: "POST",
          headers: OV_HEADERS,
          body: JSON.stringify(fbBody),
          signal: AbortSignal.timeout(5000),
        });

        const fbLatencyMs = Date.now() - fbStartMs;

        if (fbRes.ok) {
          const fbData = await fbRes.json() as any;
          const fbResources = fbData?.result?.resources || [];
          const fbMemories = fbData?.result?.memories || [];
          const fbCount = fbResources.length + fbMemories.length;

          if (fbCount > 0) {
            ovSearchMetrics.fallbackSuccesses++;
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
    ovSearchMetrics.totalSearches++;
    ovSearchMetrics.errors++;
    ovSearchMetrics.totalLatencyMs += latencyMs;
    console.error(`[OV Search] query="${query.slice(0, 80)}" error="${err.message}" latency=${latencyMs}ms`);
  }

  return { resources, memories };
}

// ===========================================================================
// OV HTTP helper
// ===========================================================================

export async function ovFetch(path: string, body: any) {
  try {
    const res = await fetch(`${OV_URL}${path}`, {
      method: "POST",
      headers: OV_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[Learning] OV ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.error(`[Learning] OV ${path} error: ${err.message}`);
    return null;
  }
}

// ===========================================================================
// Cycle session factory
// ===========================================================================

function createNoOpSession(cycleId: string) {
  return {
    sessionId: null,
    cycleId,
    active: false,
    async logPlanner() {},
    async logSkeptic() {},
    async logExecutor() {},
    async logVerification() {},
    async logOutcome() {},
    async markUsed() {},
    async search(query: string, limit = 5) {
      const { resources } = await trackedOvSearch(query, limit);
      return resources;
    },
    async getAgentContext() { return { resources: [], memories: [], formatted: "" }; },
    async commit() {},
  };
}

/**
 * Create a new OpenViking session for a cycle.
 * Returns a session object with helper methods for logging agent interactions.
 */
export async function createCycleSession(cycleId: string) {
  const result = await ovFetch("/api/v1/sessions", {});
  if (!result?.result?.session_id) {
    console.log(`[Learning] Failed to create OV session for ${cycleId} — proceeding without`);
    return createNoOpSession(cycleId);
  }

  const sessionId = result.result.session_id;
  console.log(`[Learning] Created OV session ${sessionId} for ${cycleId}`);

  return {
    sessionId,
    cycleId,
    active: true,

    async logPlanner(anchor: any, task: any) {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "user",
        content: `[Cycle ${cycleId}] Planning task for anchor: [${anchor.type}] ${anchor.reference}\nReason: ${anchor.whyNow || ""}`,
      });
      if (task) {
        await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
          role: "assistant",
          content: `[Planner] Proposed: "${task.title}"\nScope: ${JSON.stringify(task.scopeBoundary?.in || [])}\nCriteria: ${(task.acceptanceCriteria || []).join("; ")}`,
        });
      }
    },

    async logSkeptic(verdict: string, reason?: string) {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Skeptic] Verdict: ${verdict}${reason ? ` — ${reason}` : ""}`,
      });
    },

    async logExecutor(execResult: any) {
      const summary = execResult?.summary || execResult?.output?.slice?.(0, 500) || "no output";
      const files = execResult?.filesChanged || [];
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Executor] ${summary}\nFiles changed: ${files.join(", ") || "none"}`,
      });
    },

    async logVerification(verification: any, passed: boolean) {
      const steps = (verification?.steps || [])
        .map((s: any) => `${s.label}: ${s.passed ? "PASS" : "FAIL"}`)
        .join(", ");
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Verification] ${passed ? "ALL PASSED" : "FAILED"}: ${steps}`,
      });
    },

    async logOutcome(finalState: string, details = "") {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Outcome] ${finalState}${details ? ` — ${details}` : ""}`,
      });
    },

    async markUsed(uris: string[]) {
      if (uris.length === 0) return;
      await ovFetch(`/api/v1/sessions/${sessionId}/used`, {
        contexts: uris,
      });
    },

    async search(query: string, limit = 5) {
      const { resources } = await trackedOvSearch(query, limit, sessionId);
      return resources;
    },

    async getAgentContext(agentName: string, anchor: any, limit = 10) {
      const query = `${agentName} agent context for: ${anchor.reference || ""} ${anchor.whyNow || ""}`.trim();
      const { resources, memories } = await trackedOvSearch(query, limit, sessionId);

      const parts: string[] = [];
      if (resources.length > 0) {
        parts.push(`## CONTEXT (from OpenViking — ${resources.length} relevant resources)`);
        for (const r of resources.slice(0, 8)) {
          const title = r.uri || r.title || "untitled";
          const abstract = (r.abstract || "").slice(0, 400);
          if (abstract) parts.push(`\n### ${title}\n${abstract}`);
        }
      }
      if (memories.length > 0) {
        parts.push(`\n## LEARNED PATTERNS (from past cycles)`);
        for (const m of memories.slice(0, 5)) {
          const abstract = (m.abstract || m.content || "").slice(0, 300);
          if (abstract) parts.push(`- ${abstract}`);
        }
      }

      return {
        resources,
        memories,
        formatted: parts.join("\n"),
      };
    },

    async commit() {
      try {
        const res = await fetch(`${OV_URL}/api/v1/sessions/${sessionId}/commit?wait=false`, {
          method: "POST",
          headers: OV_HEADERS,
          body: "{}",
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          console.log(`[Learning] Committed OV session ${sessionId} (async) — memory extraction queued`);
          this.active = false;
          return data;
        }
        console.error(`[Learning] OV commit failed: ${res.status}`);
      } catch (err: any) {
        console.error(`[Learning] OV commit error: ${err.message}`);
      }
      this.active = false;
      return null;
    },
  };
}
