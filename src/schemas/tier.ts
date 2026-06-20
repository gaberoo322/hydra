/**
 * Schema for the `GET /api/tier?files=a,b,c` query (ADR-0022, issue #2183).
 *
 * This schema was inline in `src/api/misc.ts` before issue #2183 moved the
 * `GET /tier` route to its own domain Module (`src/api/tier.ts`). It now lives
 * under `src/schemas/` like every other API boundary contract (see the Schemas
 * seam in CONTEXT.md / CLAUDE.md), which also makes it directly unit-testable
 * instead of only being exercised through the route.
 *
 * `files` must be PRESENT (a string or repeated-param array) but may be empty —
 * the legacy read only 400s when the param is absent (undefined/null), and an
 * empty value classifies the empty change set. The schema requires presence
 * (any string or string[]); the handler splits/trims the CSV into the file list,
 * exactly mirroring the legacy `Array.isArray(raw) ? raw.flatMap(...) :
 * String(raw).split(",")` normalisation. The route owns its bespoke 400 via an
 * inline `safeParse`. Non-strict — unknown query params are ignored.
 */
import { z } from "zod";

export const TierQuerySchema = z.object({
  files: z.union([z.string(), z.array(z.string())]),
});
