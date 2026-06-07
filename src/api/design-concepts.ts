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
import { z } from "zod";

import { countQuerySchema } from "../schemas/common.ts";
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

/**
 * Query schemas for the design-concept read routes (ADR-0022).
 *
 * Both reuse the shared `countQuerySchema` factory (the `parseInt(...) || N`
 * default-on-garbage + clamp idiom) under the wire-name `limit`:
 *
 *   - `GET /design-concepts/exempt-log?limit=N` — historic default 50, cap 500.
 *   - `GET /design-concepts?scope=&limit=N` — historic default 50 (no explicit
 *     cap previously; the factory's 1000 cap bounds an otherwise-unbounded
 *     slice). `scope` is an optional `"orch" | "target"` enum; any other value
 *     (or absence) collapses to `undefined`, exactly the legacy ternary.
 *
 * Non-strict (plain object schemas ignore unknown keys); the routes pass the
 * whole `req.query` to `safeParse` and read typed, always-present fields.
 */
const ExemptLogQuerySchema = z.object({
  limit: countQuerySchema(EXEMPT_LOG_DEFAULT_LIMIT, EXEMPT_LOG_MAX_LIMIT).shape.count,
});

const DesignConceptListQuerySchema = z.object({
  scope: z
    .enum(["orch", "target"])
    .optional()
    .catch(undefined),
  limit: countQuerySchema(50).shape.count,
});

// ---------------------------------------------------------------------------
// Green-light criterion (issue #736)
// ---------------------------------------------------------------------------

/**
 * The promotion clock is idle-tolerant (issue #736): Phase C of #437 may
 * flip when at least `GREEN_LIGHT_REQUIRED_DAYS` of the most-recent
 * `GREEN_LIGHT_WINDOW_DAYS` snapshot days produced ≥1 design concept.
 *
 * Chosen form: "N of last M days" rather than a pure consecutive run.
 * Rationale (the open design choice the design-concept artifact deferred
 * to implementation): a strict `consecutiveGreenDays >= 7` punishes
 * legitimately-quiet orch days (no `ready-for-agent` issue lacking a fresh
 * artifact ⇒ nothing to grill), which is exactly the failure the issue
 * reports. "7 of last 10" tolerates up to 3 quiet days inside the window
 * while still demanding sustained production. Both the threshold and the
 * window stay well inside MAX_SNAPSHOT_DAYS (14) so the HASH always holds
 * enough history to evaluate.
 */
const GREEN_LIGHT_WINDOW_DAYS = 10;
const GREEN_LIGHT_REQUIRED_DAYS = 7;

type GreenLightMetrics = {
  /** Legacy field: green days counted consecutively from the newest. */
  consecutiveGreenDays: number;
  /** Green (production > 0) days within the trailing window. */
  greenDaysInWindow: number;
  windowDays: number;
  requiredGreenDays: number;
  greenLightReady: boolean;
};

/**
 * Compute the green-light metrics from a newest-first snapshot list. Pure
 * — no Redis IO — so it is unit-testable. A "green" day is one whose
 * production count is > 0.
 */
function computeGreenLight(
  snapshots: Array<{ date: string; count: number }>,
  windowDays: number = GREEN_LIGHT_WINDOW_DAYS,
  requiredGreenDays: number = GREEN_LIGHT_REQUIRED_DAYS,
): GreenLightMetrics {
  // `consecutiveGreenDays`: walk from newest until the first zero day.
  let consecutiveGreenDays = 0;
  for (const s of snapshots) {
    if (s.count > 0) consecutiveGreenDays += 1;
    else break;
  }
  // `greenDaysInWindow`: count green days among the newest `windowDays`.
  const window = snapshots.slice(0, windowDays);
  const greenDaysInWindow = window.reduce(
    (n, s) => (s.count > 0 ? n + 1 : n),
    0,
  );
  return {
    consecutiveGreenDays,
    greenDaysInWindow,
    windowDays,
    requiredGreenDays,
    greenLightReady: greenDaysInWindow >= requiredGreenDays,
  };
}

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
   * GET /api/design-concepts/snapshots (issue #628; metric revised in #736)
   *
   * Returns the daily-snapshot HASH as `{ snapshots: [{date, count}, ...],
   * consecutiveGreenDays, greenDaysInWindow, windowDays, requiredGreenDays,
   * indexSizeNow, greenLightReady }`. Snapshots newest-first.
   *
   * `count` is now the per-day *production count* (concepts created that
   * day), not the index `ZCARD` — see issue #736. The green-light
   * criterion that gates Phase C of #437 is **idle-tolerant**: at least
   * `GREEN_LIGHT_REQUIRED_DAYS` of the last `GREEN_LIGHT_WINDOW_DAYS`
   * snapshot days produced a concept. A legitimately-quiet orch day (no
   * pending anchor to grill) is therefore neutral, not streak-breaking.
   * `consecutiveGreenDays` is retained for visibility but no longer gates.
   */
  router.get("/design-concepts/snapshots", async (_req, res) => {
    try {
      const snapshots = await readDailySnapshots();
      const indexSizeNow = await getDesignConceptIndexSize();
      const metrics = computeGreenLight(snapshots);
      res.json({
        snapshots,
        ...metrics,
        indexSizeNow,
      });
    } catch (err: any) {
      console.error("[api/design-concepts] snapshots read failed", err);
      res.status(500).json({ error: err?.message ?? "snapshots read failed" });
    }
  });

  router.get("/design-concepts/exempt-log", async (req, res) => {
    try {
      // ADR-0022: read `limit` through the Schemas seam. Default-on-garbage to
      // EXEMPT_LOG_DEFAULT_LIMIT, clamped to EXEMPT_LOG_MAX_LIMIT.
      const limit = ExemptLogQuerySchema.safeParse(req.query).data?.limit ?? EXEMPT_LOG_DEFAULT_LIMIT;

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
      // ADR-0022: read `scope` + `limit` through the Schemas seam. `scope`
      // collapses any non-enum value to undefined; `limit` defaults to 50.
      const parsedQuery = DesignConceptListQuerySchema.safeParse(req.query);
      const scope: DesignConceptScope | undefined = parsedQuery.data?.scope;
      const limit = parsedQuery.data?.limit ?? 50;

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
