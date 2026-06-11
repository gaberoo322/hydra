/**
 * Boundary schemas for the Outcome Holdback producer surface (issue #786).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / issue #562): each
 * schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape.
 *
 * Three boundaries (all POST, called by the hydra-qa post-merge path):
 *   - POST /api/holdback/enroll        — `HoldbackEnrollBodySchema`
 *   - POST /api/holdback/check         — `HoldbackCheckBodySchema`
 *   - POST /api/holdback/revert-failed — `HoldbackRevertFailedBodySchema`
 */
import { z } from "zod";

const commitSha = z
  .string()
  .min(7, { message: "commitSha must be at least 7 chars" })
  .max(64, { message: "commitSha must be <= 64 chars" });

/** Body for POST /api/holdback/enroll — snapshot the pre-merge baseline. */
export const HoldbackEnrollBodySchema = z
  .object({
    commitSha,
    prNumber: z.number().int().positive().nullable().optional(),
    tier: z.number().int().min(1).max(4).nullable().optional(),
    windowCycles: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Body for POST /api/holdback/check — evaluate one window sample. */
export const HoldbackCheckBodySchema = z
  .object({
    commitSha,
  })
  .strict();

/** Body for POST /api/holdback/revert-failed — emit holdback.revert_failed. */
export const HoldbackRevertFailedBodySchema = z
  .object({
    commitSha,
    reason: z.string().max(2000).optional(),
  })
  .strict();
