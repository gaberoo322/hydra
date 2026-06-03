/**
 * Schemas for the run-tree retro-bundle read surface (issue #918, epic #917).
 *
 * Per ADR-0011 (Schemas seam for HTTP request bodies + query params), every
 * HTTP boundary that accepts external input parses it through a zod schema in
 * `src/schemas/<domain>.ts`. The retro-bundle endpoint
 * (`GET /api/autopilot/runs/:runId/retro`) reads a single untrusted path
 * parameter — the autopilot `run_id` — which is the index key for every Redis
 * lookup the bundle performs, so it MUST be validated before we touch Redis.
 *
 * On parse failure the route returns HTTP 400 with
 * `{ code: "schema-validation-failed", issues }` so clients pattern-match on a
 * stable shape instead of parsing prose. The schema is the canonical source of
 * BOTH the runtime parser and the inferred TypeScript type.
 */
import { z } from "zod";

/**
 * Path parameter accepted by `GET /api/autopilot/runs/:runId/retro`.
 *
 * `run_id` is the autopilot run identifier (the index key for
 * `hydra:autopilot:run:<runId>` and every per-run sub-source the bundle
 * joins). Required, trimmed, non-empty — an empty or whitespace-only id can
 * never address a real run, so we reject it at the boundary rather than
 * round-tripping a guaranteed miss through Redis.
 */
export const RetroBundleParamsSchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be a non-empty string" }),
  })
  .strict();

/** Inferred TS type — canonical shape of the retro-bundle path params. */
export type RetroBundleParams = z.infer<typeof RetroBundleParamsSchema>;
