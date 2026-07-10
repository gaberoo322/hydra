/**
 * Request-body schemas for the metrics router's write hooks.
 *
 * CLAUDE.md § HTTP validation: "HTTP request bodies validate through
 * `src/schemas/<domain>.ts` (zod `safeParse`; on failure return 400
 * `{code:"schema-validation-failed", issues}`)." This module is the metrics
 * domain's body-schema home — before it existed, `POST /metrics/tokens`
 * hand-rolled its `typeof` checks and returned a non-canonical `{error}`
 * envelope (issue #3074).
 */
import { z } from "zod";

/**
 * Body schema for `POST /metrics/tokens` — the autopilot reap-time subagent
 * token write hook (issue #394; validation migrated to this seam in #3074).
 *
 * Payload shape:
 *   { skill: "hydra-dev", tokens: 12345, cycleId?: "<task_id>", date?: "<YYYY-MM-DD>" }
 *
 * `z.looseObject` (not strict), matching the sibling autopilot POST-body
 * schemas (`src/autopilot/schemas.ts`): the reap.py caller evolved alongside
 * the handler and the handler was tolerant by design — unknown fields pass
 * through and are ignored, preserving the prior runtime behaviour exactly.
 *
 *   skill   — the dispatched skill name; REQUIRED, non-empty after trim. The
 *             trim mirrors the handler's prior `body.skill.trim()` so a
 *             whitespace-only value is rejected, not recorded as a phantom
 *             skill bucket.
 *   tokens  — total tokens the subagent consumed. `z.coerce.number()` folds
 *             the string→number policy that the handler previously spelled as
 *             `parseInt(body.tokens, 10)` into the schema (the wire is
 *             JSON, but reap.py has historically posted a stringified count).
 *             Must be a finite, non-negative number.
 *   date    — OPTIONAL date override (`YYYY-MM-DD`); absent defers to the
 *             recorder's `todayDateString()` fallback. Trimmed, non-empty
 *             when present so an empty string does not shadow the default.
 *   cycleId — OPTIONAL autopilot turn ID; when present the recorder also bumps
 *             the per-cycle token hash. Trimmed, non-empty when present.
 */
export const SubagentTokensBodySchema = z.looseObject({
  skill: z
    .string()
    .trim()
    .min(1, { message: "Missing 'skill' (non-empty string)" }),
  tokens: z.coerce
    .number({ message: "Missing or invalid 'tokens' (non-negative number)" })
    .finite({ message: "Missing or invalid 'tokens' (non-negative number)" })
    .nonnegative({ message: "Missing or invalid 'tokens' (non-negative number)" }),
  date: z.string().trim().min(1).optional(),
  cycleId: z.string().trim().min(1).optional(),
});

export type SubagentTokensBody = z.infer<typeof SubagentTokensBodySchema>;
