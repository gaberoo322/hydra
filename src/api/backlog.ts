import { Router } from "express";
import { loadBacklog, getBacklogCounts, getItemsByParent } from "../backlog/reads.ts";
import { addToBacklog, updateItem } from "../backlog/items.ts";
import { moveItemToLane, deleteItem } from "../backlog/lanes.ts";
import { isWipLimitReached } from "../backlog/wip.ts";
import { claimNextQueuedItem } from "../backlog/claims.ts";
import { getStaleClaims, reapStaleClaims } from "../backlog/reaper.ts";
import { getString } from "../redis-adapter.ts";
import { redisKeys } from "../redis-keys.ts";

export function createBacklogRouter() {
  const router = Router();

  // GET /backlog — Full Kanban backlog with all lanes
  router.get("/backlog", async (req, res) => {
    try {
      const lanes = await loadBacklog();
      const counts = await getBacklogCounts();
      res.json({ ...lanes, counts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/counts — Just the counts per lane (includes WIP limit status)
  router.get("/backlog/counts", async (req, res) => {
    try {
      const counts = await getBacklogCounts();
      const wip = await isWipLimitReached();
      res.json({ ...counts, wip });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog — Manually add an item to the backlog
  router.post("/backlog", async (req, res) => {
    try {
      const { title, category, priority, description, labels, estimate, parentId } = req.body || {};
      if (!title) return res.status(400).json({ error: "Missing 'title'" });
      const result = await addToBacklog({
        title, category: category || "uncategorized", source: "operator",
        priority, description, labels, estimate, parentId,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/enhance — Agent-enhanced backlog item creation
  router.post("/backlog/enhance", async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !text.trim()) return res.status(400).json({ error: "Missing 'text'" });

      const systemPrompt = `You are a backlog item structuring agent for an autonomous software development system called Hydra. Hydra builds an algorithmic prediction market betting platform (sports-focused, Kalshi + Polymarket).

Your job: take the operator's raw input and produce a well-structured backlog item that Hydra's planner agent can act on without ambiguity.

Output ONLY valid JSON with these fields:
{
  "title": "Clear, specific, action-oriented title (verb + noun). Under 80 chars.",
  "category": "One of: feature, bugfix, research, integration, automation, security, refactor, observability",
  "priority": 0-4 where 1=urgent 2=high 3=medium 4=low 0=none,
  "description": "Structured description with: what to do, why it matters, acceptance criteria, and how to verify. Use markdown. Include ## Prerequisites if relevant.",
  "labels": ["array", "of", "relevant", "labels"],
  "estimate": null or fibonacci (1=XS, 2=S, 3=M, 5=L, 8=XL)
}

Guidelines for a good item:
- Title should be specific enough that a planner can propose a bounded task from it
- Description should include concrete acceptance criteria (done-when conditions)
- Description should reference specific files, modules, or subsystems when possible
- Anchor to concrete evidence: failing tests, missing coverage, API gaps, operator visibility needs
- Avoid vague scope like "build the full foundation for X" — prefer narrow, verifiable slices
- If the input is vague, make reasonable assumptions and state them in the description
- Labels should include the relevant subsystem (e.g., arbitrage, execution, reconciliation, polymarket, kalshi, scanner, dashboard)

Respond with ONLY the JSON object, no markdown fences, no explanation.`;

      const response = await fetch("http://localhost:4001/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text.trim() },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(502).json({ error: `LLM proxy error: ${response.status}`, detail: errText });
      }

      const completion = await response.json();
      const raw = completion.choices?.[0]?.message?.content || "";

      // Parse the LLM JSON output (strip markdown fences if present)
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      let structured;
      try {
        structured = JSON.parse(cleaned);
      } catch {
        return res.status(422).json({ error: "LLM returned invalid JSON", raw });
      }

      if (!structured.title) {
        return res.status(422).json({ error: "LLM output missing title", raw });
      }

      // Add the item to backlog with enhanced fields
      const result = await addToBacklog({
        title: structured.title,
        category: structured.category || "uncategorized",
        source: "operator",
        priority: typeof structured.priority === "number" ? structured.priority : 0,
        description: structured.description || "",
        labels: Array.isArray(structured.labels) ? structured.labels : undefined,
        estimate: typeof structured.estimate === "number" ? structured.estimate : undefined,
      });

      res.json({ ...result, enhanced: structured });
    } catch (err: any) {
      console.error("[backlog/enhance] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /backlog/:id — Update item fields
  router.patch("/backlog/:id", async (req, res) => {
    try {
      const result = await updateItem(req.params.id, req.body || {});
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /backlog/:id/move — Move item between lanes
  router.patch("/backlog/:id/move", async (req, res) => {
    try {
      const { lane } = req.body || {};
      if (!lane) return res.status(400).json({ error: "Missing 'lane'" });
      const result = await moveItemToLane(req.params.id, lane);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/:id/approve — Move item from triage to backlog
  router.post("/backlog/:id/approve", async (req, res) => {
    try {
      const result = await moveItemToLane(req.params.id, "backlog");
      if (!result.ok) return res.status(404).json(result);
      res.json({ ...result, approved: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/:id/children — List child items for a parent
  router.get("/backlog/:id/children", async (req, res) => {
    try {
      const children = await getItemsByParent(req.params.id);
      res.json(children);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /backlog/:id — Remove an item
  router.delete("/backlog/:id", async (req, res) => {
    try {
      const result = await deleteItem(req.params.id);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/stale-claims — preview of inProgress items, with each claim's
  // current age, and which are over the configured `maxAgeMs` threshold (issue
  // #374). Optional `?maxAgeMs=N` overrides the default for diagnostic queries.
  router.get("/backlog/stale-claims", async (req, res) => {
    try {
      const rawMax = typeof req.query.maxAgeMs === "string" ? parseInt(req.query.maxAgeMs, 10) : NaN;
      const envMax = parseInt(process.env.HYDRA_CLAIM_MAX_AGE_MS ?? "") || 2 * 60 * 60 * 1000;
      const maxAgeMs = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : envMax;
      const { all, stale, maxAgeMs: usedMax } = await getStaleClaims({ maxAgeMs });
      const lifetime = await getString(redisKeys.claimsReapedLifetime());
      const isoDate = new Date().toISOString().split("T")[0];
      const day = await getString(redisKeys.claimsReapedDay(isoDate));
      const last = await getString(redisKeys.claimsReapedLast());
      res.json({
        maxAgeMs: usedMax,
        inProgress: all,
        stale,
        metrics: {
          claimsReapedLifetime: lifetime ? parseInt(lifetime, 10) : 0,
          claimsReapedToday: day ? parseInt(day, 10) : 0,
          lastReapedAt: last,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/stale-claims/reap — operator-triggered reaper run.
  router.post("/backlog/stale-claims/reap", async (req, res) => {
    try {
      const body = req.body || {};
      const envMax = parseInt(process.env.HYDRA_CLAIM_MAX_AGE_MS ?? "") || 2 * 60 * 60 * 1000;
      const maxAgeMs = typeof body.maxAgeMs === "number" && body.maxAgeMs > 0 ? body.maxAgeMs : envMax;
      const result = await reapStaleClaims({ maxAgeMs });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Atomic claim of next queued backlog item
  router.post("/backlog/claim", async (req, res) => {
    try {
      const { claimedBy } = req.body || {};
      const result = await claimNextQueuedItem(claimedBy || "claude");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
