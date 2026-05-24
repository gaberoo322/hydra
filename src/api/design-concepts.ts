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
 * Phase B audit (issue #464):
 *
 *   GET  /api/design-concepts/exempt-log            — list audit entries (query: limit)
 *   POST /api/design-concepts/exempt-log            — append audit entry (called by GH workflow)
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
import {
  appendExemptLogEntry,
  readRecentExemptLogEntries,
} from "../redis/design-concept.ts";

/** Maximum number of audit entries the read endpoint will return. */
const EXEMPT_LOG_DEFAULT_LIMIT = 50;
const EXEMPT_LOG_MAX_LIMIT = 500;

export type ExemptLogEntry = {
  pr: number;
  applier: string;
  ts: number;
  anchorRef: string;
  gate_fail_reasons: string[];
};

function isExemptLogEntry(value: unknown): value is ExemptLogEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pr === "number" &&
    typeof v.applier === "string" &&
    typeof v.ts === "number" &&
    typeof v.anchorRef === "string" &&
    Array.isArray(v.gate_fail_reasons) &&
    (v.gate_fail_reasons as unknown[]).every((r) => typeof r === "string")
  );
}

export function createDesignConceptsRouter() {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Exempt-log endpoints (issue #464). Declared BEFORE the
  // `/:anchorRef` routes so the literal "exempt-log" path is not
  // captured as an anchorRef param.
  // ---------------------------------------------------------------------------

  router.get("/design-concepts/exempt-log", async (req, res) => {
    try {
      const limitParam = parseInt(req.query.limit as string, 10);
      const limit =
        Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(limitParam, EXEMPT_LOG_MAX_LIMIT)
          : EXEMPT_LOG_DEFAULT_LIMIT;

      const rawEntries = await readRecentExemptLogEntries(limit);
      const items: ExemptLogEntry[] = [];
      for (const raw of rawEntries) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (isExemptLogEntry(parsed)) {
            items.push(parsed);
          } else {
            // Surface schema drift without dropping the rest of the log.
            console.error(
              "[api/design-concepts] exempt-log entry rejected — bad shape",
              raw,
            );
          }
        } catch (parseErr) {
          console.error(
            "[api/design-concepts] exempt-log entry parse failed",
            { raw, err: parseErr },
          );
        }
      }
      res.json({ items, count: items.length });
    } catch (err: any) {
      console.error("[api/design-concepts] exempt-log read failed", err);
      res.status(500).json({ error: err?.message ?? "exempt-log read failed" });
    }
  });

  router.post("/design-concepts/exempt-log", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<ExemptLogEntry>;
      const pr = typeof body.pr === "number" ? body.pr : NaN;
      const applier = typeof body.applier === "string" ? body.applier : "";
      const anchorRef =
        typeof body.anchorRef === "string" ? body.anchorRef : "";
      const reasonsRaw = Array.isArray(body.gate_fail_reasons)
        ? body.gate_fail_reasons
        : [];
      const gate_fail_reasons = reasonsRaw
        .filter((r): r is string => typeof r === "string")
        // Truncate each reason — the audit log doesn't need full paragraphs.
        .map((r) => (r.length > 500 ? `${r.slice(0, 497)}...` : r));

      if (!Number.isFinite(pr) || pr <= 0) {
        res.status(400).json({ error: "pr (positive number) is required" });
        return;
      }
      if (!applier) {
        res.status(400).json({ error: "applier (non-empty string) is required" });
        return;
      }
      if (!anchorRef) {
        res
          .status(400)
          .json({ error: "anchorRef (non-empty string) is required" });
        return;
      }

      const ts =
        typeof body.ts === "number" && Number.isFinite(body.ts) && body.ts > 0
          ? body.ts
          : Date.now();

      const entry: ExemptLogEntry = {
        pr,
        applier,
        ts,
        anchorRef,
        gate_fail_reasons,
      };

      // LPUSH so reads return newest-first.
      await appendExemptLogEntry(JSON.stringify(entry));
      res.status(201).json(entry);
    } catch (err: any) {
      console.error("[api/design-concepts] exempt-log write failed", err);
      res
        .status(500)
        .json({ error: err?.message ?? "exempt-log write failed" });
    }
  });

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
