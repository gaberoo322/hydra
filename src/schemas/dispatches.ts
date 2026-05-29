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

/** Inferred TS type — canonical shape of a subagent-dispatch POST body. */
export type SubagentDispatchPostBody = z.infer<typeof SubagentDispatchPostBodySchema>;

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

/** Inferred TS type — canonical shape of a current-step PATCH body. */
export type SubagentDispatchStepPatchBody = z.infer<
  typeof SubagentDispatchStepPatchBodySchema
>;
