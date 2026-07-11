/**
 * Boundary schemas for the scheduler control POST surface (issue #3171).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / ADR-0011 / issue #562):
 * each schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape (built via the shared
 * `schemaValidationError()` helper in `src/api/route-helpers.ts`).
 *
 * One boundary (POST, called by the operator / autopilot):
 *   - POST /scheduler/start — `SchedulerStartBodySchema`
 *
 * `.strict()` mirrors the holdback convention (`src/schemas/holdback.ts`):
 * unknown keys surface as a 400 rather than a silent no-op.
 */
import { z } from "zod";

/**
 * Body for POST /scheduler/start — start automatic cycle scheduling.
 *
 * `intervalMs` is optional: omitting it uses the scheduler's default.
 * When provided it must be a positive integer (the scheduler's
 * MIN_INTERVAL_MS floor is enforced at the heartbeat layer, not here, so
 * the schema validates only structural shape; the 409 from heartbeat.start()
 * handles the semantic range check).
 */
export const SchedulerStartBodySchema = z
  .object({
    intervalMs: z.number().int().positive().optional(),
  })
  .strict();

export type SchedulerStartBody = z.infer<typeof SchedulerStartBodySchema>;
