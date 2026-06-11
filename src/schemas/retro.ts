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

// ---------------------------------------------------------------------------
// Persisted retro artifacts (issue #921, retro-4)
// ---------------------------------------------------------------------------

/**
 * Query parameter accepted by `GET /api/autopilot/retros?limit=N`, which
 * returns the recent persisted retro artifacts newest-first for the dashboard
 * Retro panel.
 *
 * `limit` arrives on the wire as a string (Express `req.query`), so we coerce
 * through `z.coerce.number()` then constrain to a positive integer capped at
 * 100 — the panel only ever renders a handful of recent retrospectives, so the
 * cap stops a caller asking the server to slurp an unbounded slice. OPTIONAL
 * with a default of 20, matching the other paged read surfaces.
 */
export const RecentRetrosQuerySchema = z
  .object({
    limit: z.coerce
      .number({ message: "limit must be a number" })
      .int({ message: "limit must be an integer" })
      .min(1, { message: "limit must be >= 1" })
      .max(100, { message: "limit must be <= 100" })
      .default(20),
  })
  .strict();

/**
 * One synthesised finding inside a persisted artifact. `recurrence` is the
 * cross-run gotcha count that gates whether a prompt/doc fix is emitted.
 */
const RetroFindingSchema = z
  .object({
    cue: z.string().min(1, { message: "cue must be a non-empty string" }),
    summary: z.string(),
    recurrence: z.number().int().min(0),
    disposition: z.string(),
  })
  .strict();

/** A GitHub ref (issue or PR) the retrospective produced from the run. */
const RetroEmittedRefSchema = z
  .object({
    kind: z.enum(["issue", "pr"]),
    number: z.number().int().positive(),
    title: z.string().optional(),
  })
  .strict();

/**
 * The durable retrospective artifact persisted per autopilot run. This is the
 * canonical shape of both the Redis-stored record and the read-endpoint
 * response items, so the `/hydra-retro` skill and the dashboard agree on it.
 */
export const RetroArtifactSchema = z
  .object({
    run_id: z.string().min(1, { message: "run_id must be a non-empty string" }),
    generatedAt: z.string().min(1, { message: "generatedAt must be a non-empty string" }),
    findings: z.array(RetroFindingSchema),
    emitted: z.array(RetroEmittedRefSchema),
    summary: z.string().optional(),
  })
  .strict();
