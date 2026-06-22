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
// All design-concept domain symbols live in the single deep module (issue #2316).
import {
  saveDesignConcept,
  getDesignConcept,
  listDesignConcepts,
  approveDesignConcept,
  resolveDesignConceptForQa,
  computeGreenLight,
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
import { aggregatorRouteNoQuery } from "./route-helpers.ts";

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
//
// `computeGreenLight` + its policy constants (`GREEN_LIGHT_WINDOW_DAYS`,
// `GREEN_LIGHT_REQUIRED_DAYS`) and the `GreenLightMetrics` type were extracted
// to their domain home `src/design-concept.ts` (issue #1875) so the pure
// function is directly unit-testable and the policy thresholds are importable
// without HTTP overhead. The `GET /design-concepts/snapshots` handler below
// imports `computeGreenLight` from there — the wire behaviour is unchanged.

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
  //
  // Issue #1863: never-throw-500 isolation via the aggregatorRouteNoQuery seam
  // (route-helpers.ts, #909). No query to parse.
  router.get(
    "/design-concepts/snapshots",
    aggregatorRouteNoQuery("api/design-concepts/snapshots", async () => {
      const snapshots = await readDailySnapshots();
      const indexSizeNow = await getDesignConceptIndexSize();
      const metrics = computeGreenLight(snapshots);
      return {
        snapshots,
        ...metrics,
        indexSizeNow,
      };
    }),
  );

  //
  // Issue #1863: never-throw-500 isolation via the aggregatorRouteNoQuery seam
  // (route-helpers.ts, #909). `limit` keeps its soft-parse (default-on-garbage,
  // no 400) inside `produce`.
  router.get(
    "/design-concepts/exempt-log",
    aggregatorRouteNoQuery("api/design-concepts/exempt-log", async (req) => {
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
      return { items, count: items.length };
    }),
  );

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

  //
  // Issue #1863: never-throw-500 isolation via aggregatorRouteNoQuery (#909).
  // `scope`/`limit` keep their soft-parse (collapse-to-default, no 400) inside
  // `produce`.
  router.get(
    "/design-concepts",
    aggregatorRouteNoQuery("api/design-concepts", async (req) => {
      // ADR-0022: read `scope` + `limit` through the Schemas seam. `scope`
      // collapses any non-enum value to undefined; `limit` defaults to 50.
      const parsedQuery = DesignConceptListQuerySchema.safeParse(req.query);
      const scope: DesignConceptScope | undefined = parsedQuery.data?.scope;
      const limit = parsedQuery.data?.limit ?? 50;

      const items = await listDesignConcepts({ scope, limit });
      return { items, count: items.length };
    }),
  );

  /**
   * GET /api/design-concepts/:anchorRef/resolve — QA-time retrievability probe
   * (issue #1450).
   *
   * The single retrieval path the hydra-qa verdict flow consumes. Returns the
   * resolution discriminated on `found`:
   *
   *   200 { found:true,  handle, concept:{...flat artifact..., gate} }
   *   404 { found:false, handle, reason }
   *
   * `handle` is ALWAYS present (the stable canonical Redis key + API path the
   * artifact lives under for the anchor's lifetime), so a 404 tells QA exactly
   * WHERE the artifact was looked for and carries a loud, structured `reason`.
   * QA logs that reason rather than silently falling back to
   * `recordAnchorReflection` — the gap #1450 closes.
   *
   * NOTE the `.concept` envelope here is intentional and scoped to THIS route
   * only: the discriminated result needs `found`/`handle`/`reason` at the top
   * level, so the artifact fields nest under `.concept`. The bare
   * `/:anchorRef` route below keeps its FLAT ADR-0008 shape unchanged.
   *
   * Declared BEFORE the bare `/:anchorRef` route so the literal `resolve`
   * sub-path is matched here and never captured as an anchorRef.
   */
  router.get("/design-concepts/:anchorRef/resolve", async (req, res) => {
    try {
      const resolution = await resolveDesignConceptForQa(req.params.anchorRef);
      if (resolution.found && resolution.concept) {
        const gate = gateCheck(resolution.concept, Date.now());
        res.json({
          found: true,
          handle: resolution.handle,
          concept: { ...resolution.concept, gate },
        });
        return;
      }
      // Miss — loud server-side log; a missing artifact at QA time is a real
      // gap, not noise. The handle names exactly where we looked.
      console.error("[api/design-concepts] QA resolve MISS", {
        handle: resolution.handle,
        reason: resolution.reason,
      });
      res.status(404).json({
        found: false,
        handle: resolution.handle,
        reason: resolution.reason,
      });
    } catch (err: any) {
      console.error("[api/design-concepts] QA resolve failed", err);
      res.status(500).json({ error: err?.message ?? "resolve failed" });
    }
  });

  /**
   * GET /api/design-concepts/:anchorRef — fetch one artifact.
   *
   * RESPONSE SHAPE IS FLAT (ADR-0008 — authoritative). The body spreads the
   * stored artifact's top-level fields (`anchorRef`, `scope`, `invariants`,
   * `qaTrace`, `modulesTouched`, `glossaryTerms`, `rejectedAlternatives`,
   * `prototypes`, `status`, `approvedBy`, `artifactHash`, `createdAt`, ...)
   * plus a single `gate` sub-object (`gateCheck(dc, now)`). There is NO
   * `.concept` envelope — consumers read the artifact fields at the TOP
   * level (e.g. `.invariants`, NOT `.concept.invariants`) and the gate verdict
   * at `.gate`. Probing for a `.concept` field returns `undefined`; do not add
   * one — it would break `test/api-design-concepts-schema.test.mts` and every
   * existing consumer (decide.py, hydra-qa's Spec axis, grill-artifact.sh).
   */
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
      // Discriminate on the typed `err.code` (NotFoundError →
      // "not-found"), not a message-prefix match (#756 / #2350). Falls
      // back to the legacy prefix only for an untyped throw.
      if (
        err?.code === "not-found" ||
        msg.startsWith("approveDesignConcept: no artifact")
      ) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error("[api/design-concepts] approve failed", err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
