import { Router } from "express";
import { listSpecs, getSpec, createSpec, archiveSpec } from "../specs.ts";

export function createSpecsRouter() {
  const router = Router();

  router.get("/specs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const specs = await listSpecs(limit);
      res.json({ specs, count: specs.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/specs/:slug", async (req, res) => {
    try {
      const spec = await getSpec(req.params.slug);
      if (!spec) {
        res.status(404).json({ error: `Spec "${req.params.slug}" not found` });
      } else {
        res.json(spec);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/specs", async (req, res) => {
    try {
      const { title, rationale, tasks } = req.body;
      if (!title || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
        res.status(400).json({ error: "title and tasks[] are required" });
        return;
      }
      const spec = await createSpec({
        title,
        rationale: rationale || "",
        source: "operator",
        tasks: tasks.map((t) => typeof t === "string" ? { title: t } : t),
      });
      if (!spec) {
        res.status(409).json({ error: "Spec with this title already exists" });
      } else {
        res.status(201).json(spec);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/specs/:slug/archive", async (req, res) => {
    try {
      const ok = await archiveSpec(req.params.slug);
      if (!ok) {
        res.status(404).json({ error: `Spec "${req.params.slug}" not found` });
      } else {
        res.json({ archived: true, slug: req.params.slug });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
