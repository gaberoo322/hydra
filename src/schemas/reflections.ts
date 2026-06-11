/**
 * Query-param schema for the reflections read route (ADR-0022, slice 2).
 *
 * ADR-0022 brought `req.query` validation into the **Schemas** Seam for GET
 * read routes: a handler reads typed fields off a parsed `src/schemas/*` zod
 * schema rather than `typeof req.query.x === "string"` raw reads.
 *
 * `GET /reflections?anchor=&files=` returns the per-anchor + by-file
 * reflection narrative (the live injection path, issue #841), with an optional
 * `files` CSV scope hint.
 *
 * Issue #1454: `anchor` is now REQUIRED and non-empty. The legacy no-anchor
 * "mode 1" returned the dead global reflection buffer, which was deleted with
 * the buffer subsystem — so an absent/blank `anchor` is a client error (400),
 * not a valid request. The `.trim()` runs before the min-length check so a
 * whitespace-only `anchor` rejects too. `files` stays optional.
 *
 * NOTE: the sibling `GET /calibration/outcomes` proxy builds
 * `new URLSearchParams(req.query)` to forward the WHOLE query string
 * downstream rather than reading named fields — that is an accepted ADR-0022
 * §3 exception (proxy pass-through) and is intentionally NOT migrated here.
 */
import { z } from "zod";

/** `GET /reflections?anchor=&files=` — `anchor` required non-empty; `files` optional. */
export const ReflectionsQuerySchema = z.object({
  anchor: z.string().trim().min(1, "anchor is required"),
  files: z.string().optional(),
});
