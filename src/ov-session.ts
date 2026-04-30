/**
 * OpenViking Session Manager
 *
 * Wraps the OV session HTTP API for per-cycle conversation tracking.
 * Each development cycle creates a session, logs agent interactions,
 * and commits at the end — triggering automatic memory extraction.
 *
 * OpenViking's memory system learns from committed sessions:
 *   - What approaches work (successful merges)
 *   - What approaches fail (verification failures, regressions)
 *   - User/operator preferences (from vision + feedback)
 *   - Entity knowledge (files, modules, patterns)
 *
 * This replaces manual WHEN/CHECK/BECAUSE rule extraction with
 * automatic memory that improves over time.
 */

const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c";

const HEADERS = {
  "Content-Type": "application/json",
  "X-Api-Key": OV_KEY,
};

async function ovFetch(path, body) {
  try {
    const res = await fetch(`${OV_URL}${path}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[OVSession] ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[OVSession] ${path} error: ${err.message}`);
    return null;
  }
}

async function ovGet(path) {
  try {
    const res = await fetch(`${OV_URL}${path}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Create a new OpenViking session for a cycle.
 * Returns a session object with helper methods.
 */
export async function createCycleSession(cycleId) {
  const result = await ovFetch("/api/v1/sessions", {});
  if (!result?.result?.session_id) {
    console.log(`[OVSession] Failed to create session for ${cycleId} — proceeding without OV session`);
    return createNoOpSession(cycleId);
  }

  const sessionId = result.result.session_id;
  console.log(`[OVSession] Created session ${sessionId} for ${cycleId}`);

  return {
    sessionId,
    cycleId,
    active: true,

    /**
     * Log the planner's output to the session.
     */
    async logPlanner(anchor, task) {
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

    /**
     * Log the skeptic's verdict.
     */
    async logSkeptic(verdict, reason) {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Skeptic] Verdict: ${verdict}${reason ? ` — ${reason}` : ""}`,
      });
    },

    /**
     * Log the executor's results.
     */
    async logExecutor(execResult) {
      const summary = execResult?.summary || execResult?.output?.slice?.(0, 500) || "no output";
      const files = execResult?.filesChanged || [];
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Executor] ${summary}\nFiles changed: ${files.join(", ") || "none"}`,
      });
    },

    /**
     * Log verification results.
     */
    async logVerification(verification, passed) {
      const steps = (verification?.steps || [])
        .map(s => `${s.label}: ${s.passed ? "PASS" : "FAIL"}`)
        .join(", ");
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Verification] ${passed ? "ALL PASSED" : "FAILED"}: ${steps}`,
      });
    },

    /**
     * Log the final cycle outcome.
     */
    async logOutcome(finalState, details = "") {
      await ovFetch(`/api/v1/sessions/${sessionId}/messages`, {
        role: "assistant",
        content: `[Outcome] ${finalState}${details ? ` — ${details}` : ""}`,
      });
    },

    /**
     * Mark resources that were actually used during this cycle.
     */
    async markUsed(uris) {
      if (uris.length === 0) return;
      await ovFetch(`/api/v1/sessions/${sessionId}/used`, {
        contexts: uris,
      });
    },

    /**
     * Search with session context — results are more relevant because
     * OV understands what this cycle is working on.
     */
    async search(query, limit = 5) {
      const result = await ovFetch("/api/v1/search/find", {
        query,
        limit,
        session_id: sessionId,
      });
      return result?.result?.resources || [];
    },

    /**
     * Retrieve compiled context for an agent role + anchor.
     * One call replaces manual assembly of priorities, feedback, memory, knowledge.
     * Returns resources (config docs, research) + memories (learned patterns).
     */
    async getAgentContext(agentName, anchor, limit = 10) {
      const query = `${agentName} agent context for: ${anchor.reference || ""} ${anchor.whyNow || ""}`.trim();
      const result = await ovFetch("/api/v1/search/find", {
        query,
        limit,
        session_id: sessionId,
      });
      if (!result?.result) return { resources: [], memories: [], formatted: "" };

      const resources = result.result.resources || [];
      const memories = result.result.memories || [];

      // Format into prompt-ready text
      const parts = [];
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

    /**
     * Commit the session — triggers automatic memory extraction.
     * OpenViking analyzes the full cycle conversation and extracts:
     *   - What worked (successful approaches)
     *   - What failed (patterns to avoid)
     *   - Entity knowledge (files, modules mentioned)
     */
    async commit() {
      // Use wait=false so OV processes memory extraction in background.
      // The default (wait=true) blocks until extraction finishes, which
      // involves LLM calls and regularly exceeds any reasonable timeout
      // for real sessions with many messages.
      try {
        const res = await fetch(`${OV_URL}/api/v1/sessions/${sessionId}/commit?wait=false`, {
          method: "POST",
          headers: HEADERS,
          body: "{}",
          signal: AbortSignal.timeout(15000), // 15s is generous for async commit
        });
        if (res.ok) {
          const data = await res.json();
          console.log(`[OVSession] Committed session ${sessionId} (async) — memory extraction queued`);
          this.active = false;
          return data;
        }
        console.error(`[OVSession] Commit failed: ${res.status}`);
      } catch (err) {
        console.error(`[OVSession] Commit error: ${err.message}`);
      }
      this.active = false;
      return null;
    },
  };
}

/**
 * No-op session for when OV is unavailable.
 * All methods succeed silently so the control loop isn't blocked.
 */
function createNoOpSession(cycleId) {
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
    async search(query, limit = 5) {
      // Fall back to non-session search
      try {
        const res = await fetch(`${OV_URL}/api/v1/search/find`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({ query, limit }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return data?.result?.resources || [];
      } catch {
        return [];
      }
    },
    async commit() {},
  };
}
