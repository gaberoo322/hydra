/**
 * Query-param schema for the OpenViking proxy read route (ADR-0022, slice 3).
 *
 * ADR-0022 brought `req.query` validation into the **Schemas** Seam for GET
 * read routes: every handler reads `req.query` through a `src/schemas/*` zod
 * schema, never via raw `parseInt(req.query.x)` / `req.query.x` reads. This
 * module owns the `GET /openviking/search?q=&limit=N` surface:
 *
 *   - `q` is a REQUIRED non-empty string — an absent or whitespace-only value
 *     cannot address a search, so the route rejects it with its historic
 *     bespoke 400 ("Missing query parameter 'q'"). Per ADR-0022 §1 the route
 *     owns that 400, `safeParse`ing inline and keeping its response shape.
 *   - `limit` reuses the shared `countQuerySchema` factory (the
 *     `parseInt(req.query.limit ?? "") || 10` idiom) with the route's historic
 *     default of 10 — default-on-garbage + clamp, no behaviour change.
 *
 * Non-strict (a plain object schema ignores unknown keys) so the route can
 * still parse these fields without tripping on any other query param.
 */
import { z } from "zod";
import { countQuerySchema } from "./common.ts";

/**
 * `GET /openviking/search?q=&limit=N`.
 *
 * `q` REQUIRED non-empty string; `limit` reuses the `countQuerySchema(10)`
 * coercion (default-on-garbage to 10, clamped to `[1, 1000]`) under the `limit`
 * field name. The route passes the WHOLE `req.query` to `safeParse`.
 */
export const OpenVikingSearchQuerySchema = z.object({
  q: z.string().trim().min(1),
  limit: countQuerySchema(10).shape.count,
});

/** Inferred TS type — `{ q: string; limit: number }` for the OV search proxy. */
export type OpenVikingSearchQuery = z.infer<typeof OpenVikingSearchQuerySchema>;
