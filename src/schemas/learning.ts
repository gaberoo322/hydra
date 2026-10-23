/**
 * Query-param schemas for the learning read routes (ADR-0022, slice 2).
 *
 * ADR-0022 brought `req.query` validation into the **Schemas** Seam for GET
 * read routes: every handler reads `req.query` through a `src/schemas/*` zod
 * schema, never via raw `parseInt(req.query.x)` / `typeof req.query.x ===
 * "string"`. This module owns the `learning.ts` query surface (the
 * `rule-action-log` and `reflection-health` pagers were deleted with their
 * routes, issue #4638):
 *
 *   - `GET /learning/context-trace?agent=&reference=&type=&files=` — three
 *     REQUIRED string params plus an optional `files` CSV. This route owns a
 *     bespoke 400 ("agent, reference, and type query params are required"), so
 *     per ADR-0022 §1 it `safeParse`s inline and keeps its own response shape
 *     rather than going through `aggregatorRoute`'s hard 500.
 */
import { z } from "zod";

/**
 * `GET /learning/context-trace?agent=&reference=&type=&files=`.
 *
 * `agent`, `reference`, and `type` are REQUIRED non-empty strings — an absent
 * or whitespace-only value can never address a real context composition, so
 * the route rejects it at the boundary (bespoke 400). `files` is an optional
 * comma-separated path hint for the by-file index.
 *
 * Non-strict (a plain object schema ignores unknown keys) so the route can
 * still parse these fields without tripping on any other query param.
 */
export const ContextTraceQuerySchema = z.object({
  agent: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  type: z.string().trim().min(1),
  files: z.string().optional(),
});
