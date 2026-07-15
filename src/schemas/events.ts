/**
 * Boundary schema for the `POST /events/publish` external publish endpoint
 * (issue #3259).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / ADR-0022 / issue #562):
 * the schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the canonical
 * `{ code: "schema-validation-failed", issues }` envelope (built via
 * `schemaValidationError()` in `src/api/route-helpers.ts`).
 *
 * This replaces the handler's prior ad-hoc inline extraction
 * (`const { type, payload, correlationId } = req.body || {}` + a hand-rolled
 * `if (!type)` 400), routing the body through the Schemas seam instead.
 *
 * Behavior preserved for the previously-accepted payloads:
 *  - `type` is required and must be a non-empty string. The old guard rejected
 *    any falsy `type` (absent, empty string, null) with a 400; a
 *    `.min(1)` non-empty string reproduces that rejection through the seam.
 *  - `payload` is optional; the handler defaults an absent payload to `{}`.
 *  - `correlationId` is optional; the handler defaults an absent value to null.
 *
 * `.passthrough()` allows unknown top-level keys — the handler reads only the
 * named fields, so extra keys are ignored rather than rejected, matching the
 * prior destructuring behavior.
 */
import { z } from "zod";

export const PublishEventBodySchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
    correlationId: z.string().nullish(),
  })
  .passthrough();
