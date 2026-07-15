/**
 * Schema for the `GET /api/attribution/impact?topN=N` query (ADR-0022, issue
 * #3283, epic #2628 — the reverse-loop read surface).
 *
 * ADR-0022 §1 forbids an HTTP handler from reading `req.query.<field>` directly:
 * every query-string read routes the WHOLE `req.query` through a
 * `src/schemas/<domain>.ts` zod `safeParse`, then reads typed fields off the
 * PARSED result (see the Schemas seam in CONTEXT.md / CLAUDE.md). This schema is
 * that boundary contract for the impact route, and makes the query parse
 * directly unit-testable instead of only exercised through Express.
 *
 * `topN` is the OPTIONAL cap on the number of ranked producer classes returned:
 *
 *   - Absent ⇒ `undefined` ⇒ return ALL ranked rows (the reverse loop usually
 *     wants the full ranking; the cap is a convenience for a top-of-list peek).
 *   - Present ⇒ coerced to a non-negative integer. A malformed value (a
 *     non-numeric string, a fraction, or a negative number) is a 400
 *     `{code:"schema-validation-failed", issues}` — the route owns that response.
 *
 * Non-strict — unknown query params are ignored (the route consumes only
 * `topN`).
 */
import { z } from "zod";

export const AttributionImpactQuerySchema = z.object({
  /**
   * Optional top-N cap. `z.coerce.number()` folds the query string to a number,
   * then the pipe requires a non-negative integer. Absent ⇒ `undefined`
   * (return all). A present-but-malformed value fails the parse, so the handler
   * returns 400 rather than silently returning all.
   */
  topN: z.coerce
    .number()
    .int()
    .min(0)
    .optional(),
});
