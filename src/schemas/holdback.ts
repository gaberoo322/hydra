/**
 * Boundary schemas for the Outcome Holdback producer surface (issue #786).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / issue #562): each
 * schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape.
 *
 * Four boundaries (all POST, called by the hydra-qa post-merge path / autopilot):
 *   - POST /api/holdback/enroll        — `HoldbackEnrollBodySchema`
 *   - POST /api/holdback/check         — `HoldbackCheckBodySchema`
 *   - POST /api/holdback/revert-failed — `HoldbackRevertFailedBodySchema`
 *   - POST /api/holdback/pending       — `HoldbackPendingBodySchema` (issue #2622)
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

/**
 * Body for POST /api/holdback/pending (issue #2622) — register a PR the
 * autopilot has armed for auto-merge but that has not yet landed.
 *
 * `prNumber` keys the entry (idempotent upsert) and `cycleId` audits which
 * autopilot cycle armed it — both required. `tier` is nullable to mirror the
 * enroll schema: registration is permissive (records what was armed); the
 * tier-enrollment filter is a landing-time concern for the #2623 watcher.
 */
export const HoldbackPendingBodySchema = z
  .object({
    prNumber: z.number().int().positive(),
    tier: z.number().int().min(1).max(4).nullable(),
    cycleId: z.string().min(1).max(200),
  })
  .strict();
