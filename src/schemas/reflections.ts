/**
 * Query-param schema for the reflections read route (ADR-0022, slice 2).
 *
 * ADR-0022 brought `req.query` validation into the **Schemas** Seam for GET
 * read routes: a handler reads typed fields off a parsed `src/schemas/*` zod
 * schema rather than `typeof req.query.x === "string"` raw reads.
 *
 * `GET /reflections?anchor=&files=` has two modes selected by `anchor`:
 *   - absent → global reflection buffer;
 *   - present → per-anchor + by-file reflection narrative (the live injection
 *     path, issue #841), with an optional `files` CSV scope hint.
 *
 * Both fields are OPTIONAL strings — an absent `anchor` is a valid request
 * (mode 1), not a client error — so this schema never rejects; the route reads
 * the typed fields and branches on `anchor` exactly as before. The legacy code
 * `.trim()`ed `anchor`; the schema carries that trim so the route's
 * mode-select branch behaves identically.
 *
 * NOTE: the sibling `GET /calibration/outcomes` proxy builds
 * `new URLSearchParams(req.query)` to forward the WHOLE query string
 * downstream rather than reading named fields — that is an accepted ADR-0022
 * §3 exception (proxy pass-through) and is intentionally NOT migrated here.
 */
import { z } from "zod";

/** `GET /reflections?anchor=&files=` — both optional; non-strict. */
export const ReflectionsQuerySchema = z.object({
  anchor: z.string().trim().optional(),
  files: z.string().optional(),
});

/** Inferred TS type — canonical shape of the reflections query params. */
export type ReflectionsQuery = z.infer<typeof ReflectionsQuerySchema>;
