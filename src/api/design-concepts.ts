/**
 * Design-concept API sub-router (Phase A of #437).
 *
 * Mounted by `src/api.ts`. Endpoints:
 *
 *   GET  /api/design-concepts                       — list (query: scope, limit)
 *   GET  /api/design-concepts/:anchorRef            — fetch one
 *   POST /api/design-concepts                       — create / overwrite (idempotent on anchorRef)
 *   POST /api/design-concepts/:anchorRef/approve    — mark approved, record approvedBy
 *
 * Phase A intentionally does NOT mount any gate-side enforcement —
 * `dev_orch` dispatch wiring is Phase B (`scripts/autopilot/decide.py`).
 * This sub-router only exposes the persistence layer + a `gateCheck`
 * read-through so callers can preview gate verdicts ahead of the wire-up.
 */

import { Router } from "express";

import {
  saveDesignConcept,
  getDesignConcept,
  listDesignConcepts,
  approveDesignConcept,
  gateCheck,
  type DesignConceptInput,
  type DesignConceptScope,
} from "../design-concept.ts";

export function createDesignConceptsRouter() {
  const router = Router();

  router.get("/design-concepts", async (req, res) => {
    try {
      const scopeRaw = (req.query.scope as string | undefined) ?? "";
      const scope: DesignConceptScope | undefined =
        scopeRaw === "orch" || scopeRaw === "target" ? scopeRaw : undefined;
      const limitParam = parseInt(req.query.limit as string, 10);
      const limit =
        Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;

      const items = await listDesignConcepts({ scope, limit });
      res.json({ items, count: items.length });
    } catch (err: any) {
      console.error("[api/design-concepts] list failed", err);
      res.status(500).json({ error: err?.message ?? "list failed" });
    }
  });

  router.get("/design-concepts/:anchorRef", async (req, res) => {
    try {
      const dc = await getDesignConcept(req.params.anchorRef);
      if (!dc) {
        res
          .status(404)
          .json({ error: `design-concept "${req.params.anchorRef}" not found` });
        return;
      }
      const gate = gateCheck(dc, Date.now());
      res.json({ ...dc, gate });
    } catch (err: any) {
      console.error("[api/design-concepts] get failed", err);
      res.status(500).json({ error: err?.message ?? "get failed" });
    }
  });

  router.post("/design-concepts", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<DesignConceptInput>;
      if (!body.anchorRef || typeof body.anchorRef !== "string") {
        res.status(400).json({ error: "anchorRef (string) is required" });
        return;
      }
      if (body.scope !== "orch" && body.scope !== "target") {
        res
          .status(400)
          .json({ error: "scope must be 'orch' or 'target'" });
        return;
      }

      const dc = await saveDesignConcept({
        anchorRef: body.anchorRef,
        scope: body.scope,
        glossaryTerms: body.glossaryTerms ?? [],
        glossaryGaps: body.glossaryGaps ?? [],
        modulesTouched: body.modulesTouched ?? [],
        invariants: body.invariants ?? [],
        rejectedAlternatives: body.rejectedAlternatives ?? [],
        qaTrace: body.qaTrace ?? [],
        prototypes: body.prototypes ?? [],
        status: body.status,
        approvedBy: body.approvedBy,
      });
      res.status(201).json(dc);
    } catch (err: any) {
      console.error("[api/design-concepts] create failed", err);
      res.status(500).json({ error: err?.message ?? "create failed" });
    }
  });

  router.post("/design-concepts/:anchorRef/approve", async (req, res) => {
    try {
      const by =
        typeof req.body?.by === "string" && req.body.by.length > 0
          ? req.body.by
          : "auto-gate";

      if (by !== "auto-gate" && !by.startsWith("operator:")) {
        res
          .status(400)
          .json({ error: "by must be 'auto-gate' or 'operator:<name>'" });
        return;
      }

      const dc = await approveDesignConcept(req.params.anchorRef, by);
      const gate = gateCheck(dc, Date.now());
      res.json({ ...dc, gate });
    } catch (err: any) {
      const msg = err?.message ?? "approve failed";
      if (msg.startsWith("approveDesignConcept: no artifact")) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error("[api/design-concepts] approve failed", err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
