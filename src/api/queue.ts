import { Router } from "express";
import { getWorkQueueItems, pushToWorkQueue, getWorkQueueLen, findWorkQueueDuplicate } from "../redis-adapter.ts";
import { _admin } from "../backlog.ts";
const { getBacklogCounts, loadBacklog } = _admin;

export function createQueueRouter() {
  const router = Router();

  // POST /queue — Queue a work item for the next cycle
  router.post("/queue", async (req, res) => {
    try {
      const { reference, reason, context } = req.body || {};
      if (!reference) {
        return res.status(400).json({ error: "Missing 'reference' field — what should Hydra work on?" });
      }

      // Dedup: fuzzy check if a similar item already exists in the queue
      const matchedRef = await findWorkQueueDuplicate(reference);
      if (matchedRef) {
        console.log(`[WorkQueue] Dedup: rejected "${reference}" (matches existing: "${matchedRef}")`);
        return res.status(409).json({
          error: "Duplicate — a similar item already exists in the queue",
          reference,
          matchedExisting: matchedRef,
        });
      }

      const item = { reference, reason: reason || "queued by operator", context, queuedAt: new Date().toISOString() };
      await pushToWorkQueue(JSON.stringify(item));
      const queueLen = await getWorkQueueLen();
      res.json({ queued: true, item, position: queueLen });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /queue — View queued work items
  router.get("/queue", async (req, res) => {
    try {
      const items = await getWorkQueueItems();
      res.json(items.map((i) => { try { return JSON.parse(i); } catch { return i; } }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /queue/snapshot — Human-readable summary of queue + backlog state
  router.get("/queue/snapshot", async (req, res) => {
    try {
      const [rawItems, counts, backlog] = await Promise.all([
        getWorkQueueItems(),
        getBacklogCounts(),
        loadBacklog(),
      ]);

      const queueItems = rawItems.map((i) => { try { return JSON.parse(i); } catch { return { reference: i }; } });

      // Build human-readable markdown snapshot
      const lines: string[] = [];
      const now = new Date().toISOString().split("T")[0];
      lines.push(`# Work Snapshot (${now})`);
      lines.push("");
      lines.push(`## Lane Counts`);
      lines.push(`| Lane | Count |`);
      lines.push(`|------|-------|`);
      lines.push(`| Triage | ${counts.triage || 0} |`);
      lines.push(`| Backlog | ${counts.backlog || 0} |`);
      lines.push(`| Queued | ${counts.queued || 0} |`);
      lines.push(`| In Progress | ${counts.inProgress || 0} |`);
      lines.push(`| Blocked | ${counts.blocked || 0} |`);
      lines.push(`| Done | ${counts.done || 0} |`);
      lines.push("");

      // In-progress items
      const inProgress = (backlog as any).inProgress || [];
      if (inProgress.length > 0) {
        lines.push(`## In Progress`);
        for (const item of inProgress) {
          lines.push(`- ${item.title} (${item.meta?.claimedBy || "unknown"}, started ${item.meta?.startedAt || "?"})`);
        }
        lines.push("");
      }

      // Work queue
      lines.push(`## Work Queue (${queueItems.length} items)`);
      if (queueItems.length === 0) {
        lines.push("(empty)");
      } else {
        for (const item of queueItems) {
          const source = item.source || "operator";
          lines.push(`- [${source}] ${item.reference}`);
        }
      }
      lines.push("");

      // Triage items needing review
      const triage = (backlog as any).triage || [];
      if (triage.length > 0) {
        lines.push(`## Triage (${triage.length} awaiting review)`);
        for (const item of triage.slice(0, 10)) {
          lines.push(`- ${item.title} (${item.meta?.source || "unknown"}, ${item.meta?.addedAt || "?"})`);
        }
        if (triage.length > 10) lines.push(`  ... and ${triage.length - 10} more`);
        lines.push("");
      }

      // Blocked items
      const blocked = (backlog as any).blocked || [];
      if (blocked.length > 0) {
        lines.push(`## Blocked (${blocked.length})`);
        for (const item of blocked) {
          lines.push(`- ${item.title} — ${item.meta?.blockedReason || "no reason"}`);
        }
        lines.push("");
      }

      const markdown = lines.join("\n");

      // Return as markdown or JSON based on Accept header
      const accept = req.headers.accept || "";
      if (accept.includes("text/plain") || accept.includes("text/markdown")) {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.send(markdown);
      } else {
        res.json({ snapshot: markdown, counts, queueDepth: queueItems.length, generatedAt: new Date().toISOString() });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
