/**
 * Boundary schemas for the cycle control POST surface (issue #3170).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / ADR-0011 / issue #562):
 * each schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape (built via the shared
 * `schemaValidationError()` helper in `src/api/route-helpers.ts`).
 *
 * Two boundaries (both POST, called by the Claude Code cycle harness):
 *   - POST /cycle/register — `CycleRegisterBodySchema`
 *   - POST /cycle/complete — `CycleCompleteBodySchema`
 *
 * `.strict()` mirrors the holdback convention (`src/schemas/holdback.ts`):
 * unknown keys (e.g. a `cycleID` typo) surface as a 400 rather than a silent
 * no-op. No known live caller sends extra fields.
 */
import { z } from "zod";

/**
 * Body for POST /cycle/register — register an external cycle (Claude Code).
 *
 * Both fields required and non-empty: the legacy inline guard 400s if either
 * `cycleId` or `source` is falsy, so `.min(1)` preserves the existing contract
 * (empty string already fails today).
 */
export const CycleRegisterBodySchema = z
  .object({
    cycleId: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

/**
 * Body for POST /cycle/complete — complete an external cycle.
 *
 * Only `cycleId` is required (non-empty). `source` and `status` stay optional so
 * the handler keeps its existing defaults (`source || "claude"`,
 * `status || "completed"`) — release/update semantics are unchanged. `status`
 * is left an optional free string (no enum) so custom status values still write
 * verbatim to the cycle hash.
 */
export const CycleCompleteBodySchema = z
  .object({
    cycleId: z.string().min(1),
    source: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
  })
  .strict();
