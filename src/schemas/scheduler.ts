/**
 * Schema for the scheduler API request bodies (issue #3171).
 *
 * Follows the Schemas Seam discipline (ADR-0011 / CLAUDE.md): every HTTP
 * `req.body` at the orchestrator boundary parses through a zod schema in
 * `src/schemas/<domain>.ts`, and the handler emits the shared
 * `{code:"schema-validation-failed", issues}` 400 envelope on failure.
 *
 * A `z.object({...})` schema is BOTH the runtime parser AND the TypeScript
 * type source — the parse result is a tagged union with a stable
 * `error.issues[]` shape downstream agents/clients pattern-match on without
 * reading prose error strings. See src/schemas/queue.ts for the seed pattern.
 */
import { z } from "zod";

/**
 * Body accepted by `POST /scheduler/start` (src/api/scheduler.ts).
 *
 * - `intervalMs` is OPTIONAL. Omitting it must still start the scheduler at
 *   the stored/default interval: heartbeat.ts `start()` falls back to
 *   `opts.intervalMs || state.intervalMs || DEFAULT_INTERVAL_MS`, so callers
 *   legitimately POST an empty body to start at the default 5-minute cadence.
 *   A required field would break that documented start-with-default path.
 * - When present, `intervalMs` must be a positive integer (shape-level typing).
 *
 * NOTE — the 30000ms (`MIN_INTERVAL_MS`) semantic floor is deliberately NOT
 * duplicated here. That floor is scheduler-domain policy owned by
 * `heartbeat.ts` `startScheduler`, which already returns a 409 with a
 * human-readable message for sub-floor intervals. Enforcing `.min(30000)` in
 * the schema would split the source of truth and convert that 409 into a 400,
 * changing a status-code contract existing scheduler tests assert. ADR-0011
 * scopes schemas to shape/parse validation; the semantic floor stays with
 * `startScheduler` (issue #3171 design-concept rejectedAlternatives).
 *
 * `.strict()` so typo'd keys (e.g. `intervalMS`) are rejected rather than
 * silently ignored.
 */
export const SchedulerStartBodySchema = z
  .object({
    intervalMs: z.number().int().positive().optional(),
  })
  .strict();
