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
  type DesignConceptScope,
} from "../design-concept.ts";
import {
  appendExemptLogEntry,
  readRecentExemptLogEntries,
  readDailySnapshots,
  getDesignConceptIndexSize,
} from "../redis/design-concept.ts";
import {
  DesignConceptInputSchema,
  DesignConceptApproveBodySchema,
  ExemptLogEntryInputSchema,
} from "../schemas/design-concept.ts";

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

  /**
   * GET /api/design-concepts/snapshots (issue #628)
   *
   * Returns the daily-snapshot HASH as `{ snapshots: [{date, count}, ...],
   * consecutiveGreenDays, indexSizeNow, greenLightReady }` — the
   * green-light criterion for Phase C of #437 is `consecutiveGreenDays
   * >= 7`. Newest-first.
   */
  router.get("/design-concepts/snapshots", async (_req, res) => {
    try {
      const snapshots = await readDailySnapshots();
      const indexSizeNow = await getDesignConceptIndexSize();
      // Count consecutive non-zero days from the newest snapshot backwards.
      // The "newest-first" sort from readDailySnapshots() means we just
      // walk until we hit a zero or run out.
      let consecutiveGreenDays = 0;
      for (const s of snapshots) {
        if (s.count > 0) consecutiveGreenDays += 1;
        else break;
      }
      const greenLightReady = consecutiveGreenDays >= 7;
      res.json({
        snapshots,
        consecutiveGreenDays,
        indexSizeNow,
        greenLightReady,
      });
    } catch (err: any) {
      console.error("[api/design-concepts] snapshots read failed", err);
      res.status(500).json({ error: err?.message ?? "snapshots read failed" });
    }
  });

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
      // Zod boundary parse (ADR-0011, slice 1). Replaces the hand-rolled
      // `typeof body.pr === "number"` / falsy-string checks with a
      // structured 400 that downstream clients can pattern-match on.
      const parsed = ExemptLogEntryInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
        return;
      }
      const body = parsed.data;

      // Truncate each reason — the audit log doesn't need full paragraphs.
      // This is a transformation, not a validation, so it stays in the
      // handler rather than the schema.
      const gate_fail_reasons = body.gate_fail_reasons.map((r) =>
        r.length > 500 ? `${r.slice(0, 497)}...` : r,
      );

      const ts = typeof body.ts === "number" ? body.ts : Date.now();

      const entry: ExemptLogEntry = {
        pr: body.pr,
        applier: body.applier,
        ts,
        anchorRef: body.anchorRef,
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
      // Zod boundary parse (ADR-0011, slice 1). The schema enforces both
      // anchorRef (non-empty string) and scope (orch | target), so the
      // hand-rolled prose 400s are gone.
      const parsed = DesignConceptInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
        return;
      }
      const body = parsed.data;

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
      // Zod boundary parse (ADR-0011, slice 1). `by` is optional on the
      // wire — when omitted it defaults to "auto-gate" (preserving the
      // pre-migration behaviour). When supplied, the schema enforces the
      // "auto-gate" | "operator:<name>" union.
      const parsed = DesignConceptApproveBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
        return;
      }
      const by = parsed.data.by ?? "auto-gate";

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
