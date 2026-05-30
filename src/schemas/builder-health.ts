/**
 * Boundary schemas for the Builder-Health Scorecard surface (issue #732).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / issue #562): each
 * schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape.
 *
 * Three boundaries:
 *   - GET  /api/builder-health                  — `BuilderHealthQuerySchema`
 *   - POST /api/builder-health/scope-violation  — `ScopeViolationBodySchema`
 *   - POST /api/builder-health/dispatch-pr      — `DispatchPrBodySchema`
 */
import { z } from "zod";

/**
 * Query for GET /api/builder-health. Two independent windows: `prWindow`
 * (the GitHub-derived autonomy / time-to-merge metrics) and `windowDays`
 * (the day-bucketed scope-violation + learning metrics). Each metric also
 * echoes its OWN native window in the response — these query params only
 * cap the two new derived metrics.
 */
export const BuilderHealthQuerySchema = z
  .object({
    prWindow: z.coerce
      .number()
      .int({ message: "prWindow must be an integer" })
      .min(1, { message: "prWindow must be >= 1" })
      .max(200, { message: "prWindow must be <= 200" })
      .optional(),
    windowDays: z.coerce
      .number()
      .int({ message: "windowDays must be an integer" })
      .min(1, { message: "windowDays must be >= 1" })
      .max(90, { message: "windowDays must be <= 90" })
      .optional(),
  })
  .strict();

export type BuilderHealthQuery = z.infer<typeof BuilderHealthQuerySchema>;

/**
 * Body for POST /api/builder-health/scope-violation. Written best-effort by
 * the CI `scope-check` gate when it blocks a PR for scope. `date` defaults to
 * the server's UTC today when omitted.
 */
export const ScopeViolationBodySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
      .optional(),
    count: z
      .number()
      .int({ message: "count must be an integer" })
      .min(1, { message: "count must be >= 1" })
      .optional(),
  })
  .strict();

export type ScopeViolationBody = z.infer<typeof ScopeViolationBodySchema>;

/**
 * Body for POST /api/builder-health/dispatch-pr. Stamps the dispatch->PR link
 * the Autonomy Rate + time-to-merge metrics derive from. Only `prNumber` is
 * required; the rest is dispatch provenance for the audit breakdown.
 */
export const DispatchPrBodySchema = z
  .object({
    prNumber: z
      .number()
      .int({ message: "prNumber must be an integer" })
      .min(1, { message: "prNumber must be >= 1" }),
    runId: z.string().trim().min(1).optional(),
    dispatchId: z.string().trim().min(1).optional(),
    skill: z.string().trim().min(1).optional(),
    issueRef: z.string().trim().min(1).optional(),
    openedAt: z.string().trim().min(1).optional(),
  })
  .strict();

export type DispatchPrBody = z.infer<typeof DispatchPrBodySchema>;
