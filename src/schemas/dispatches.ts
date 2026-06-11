/**
 * Schemas for the subagent-dispatch capture boundary (issue #692, PRD #690).
 *
 * Per ADR-0011 (Schemas seam for HTTP request bodies), every HTTP boundary
 * that accepts external input parses it through a `.strict()` zod schema in
 * `src/schemas/<domain>.ts`. The SessionStart hook (`scripts/hooks/
 * session-start-capture.sh`) POSTs a sentinel-derived payload to
 * `POST /api/dispatches/subagent`, and PATCHes a step update to
 * `PATCH /api/dispatches/subagent/:sessionId/current-step` — both bodies are
 * untrusted (they originate from a regex-scrape of a session JSONL written by
 * an arbitrary Claude Code session), so they MUST be validated here.
 *
 * The schema is the canonical source of BOTH the runtime parser and the
 * inferred TypeScript type (`z.infer<typeof ...>`). Follow the shape pinned by
 * the first landed schema (`src/schemas/queue.ts`): `.strict()` objects,
 * trimmed `min(1)` strings for required handles, `.optional()` for the rest.
 *
 * On parse failure the route returns HTTP 400 with
 * `{ code: "schema-validation-failed", issues: result.error.issues }` so
 * agents and clients pattern-match on a stable shape instead of parsing prose.
 */
import { z } from "zod";

/**
 * A trimmed, required, non-empty string — the shared shape for the dispatch
 * identity fields (`sessionId`, `skill`, `dispatchId`). Mirrors the
 * `reference` field discipline in `src/schemas/queue.ts`.
 */
function requiredHandle(name: string) {
  return z
    .string({ message: `${name} must be a string` })
    .trim()
    .min(1, { message: `${name} must be a non-empty string` });
}

/**
 * Body accepted by `POST /api/dispatches/subagent`.
 *
 * - `sessionId` — the Claude Code session id (the JSONL filename stem). The
 *   subagent-dispatch hash is keyed on this, so it's required.
 * - `skill` — the dispatched skill name (`hydra-dev`, `hydra-grill`, ...).
 * - `dispatchId` — the stable per-dispatch identifier the autopilot stamps
 *   into the sentinel (the synthesised worktree branch name). Required so the
 *   captured row can be joined back to the autopilot turn that launched it.
 * - `runId` — OPTIONAL. Present only when the dispatch happened inside an
 *   autopilot run; operator-launched sessions omit it.
 * - `startedAt` — OPTIONAL ISO timestamp. When omitted, the route stamps
 *   `new Date().toISOString()` so the index score lands at capture time.
 * - `projectDir`, `currentStep`, `issueRef`, `prRef` — OPTIONAL metadata
 *   mirroring the operator-dispatch shape.
 */
export const SubagentDispatchPostBodySchema = z
  .object({
    sessionId: requiredHandle("sessionId"),
    skill: requiredHandle("skill"),
    dispatchId: requiredHandle("dispatchId"),
    runId: z.string().trim().min(1).optional(),
    startedAt: z.string().trim().min(1).optional(),
    projectDir: z.string().trim().min(1).optional(),
    currentStep: z.string().optional(),
    issueRef: z.string().trim().min(1).optional(),
    prRef: z.string().trim().min(1).optional(),
  })
  .strict();


/**
 * Body accepted by `PATCH /api/dispatches/subagent/:sessionId/current-step`.
 *
 * `currentStep` is required (the whole point of the PATCH) but may be an
 * empty string — a caller clearing the step is legitimate, so we do NOT apply
 * the `min(1)` trim chain here.
 */
export const SubagentDispatchStepPatchBodySchema = z
  .object({
    currentStep: z.string({ message: "currentStep must be a string" }),
  })
  .strict();


/**
 * Query params accepted by
 * `GET /api/dispatches/:dispatchId/transcript?offset=0&limit=200` (issue #695).
 *
 * Both are OPTIONAL with defaults (offset=0, limit=200, oldest-first). They
 * arrive on the wire as strings (Express `req.query`), so we coerce through
 * `z.coerce.number()` and then constrain to non-negative integers. `limit` is
 * additionally capped at 1000 — the page virtualizes client-side above ~1000
 * messages, so a single response never needs to ship more than that, and the
 * cap stops a caller from asking the server to slurp an unbounded slice.
 *
 * Per ADR-0011 this is the canonical source of both the runtime parser and the
 * inferred TS type. On parse failure the route returns HTTP 400
 * `{ code: "schema-validation-failed", issues }` like every other boundary.
 */
export const TranscriptQuerySchema = z
  .object({
    offset: z.coerce
      .number({ message: "offset must be a number" })
      .int({ message: "offset must be an integer" })
      .min(0, { message: "offset must be >= 0" })
      .default(0),
    limit: z.coerce
      .number({ message: "limit must be a number" })
      .int({ message: "limit must be an integer" })
      .min(1, { message: "limit must be >= 1" })
      .max(1000, { message: "limit must be <= 1000" })
      .default(200),
  })
  .strict();

