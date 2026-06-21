/**
 * Request-body schemas for the Pattern Memory write routes (ADR-0022, issue #2181).
 *
 * The four Pattern Memory write routes previously lived in `src/api/misc.ts`
 * with raw `req.body` destructuring and manual presence guards. This module
 * replaces those inline guards with `safeParse`-validated schemas, closing
 * `src/api/misc.ts`'s Schemas Seam gap and making the valid payload shape
 * explicit and testable.
 *
 * Each schema is the single source of truth for both the Zod parser and the
 * inferred TypeScript type (ADR-0011: "schema is the type").
 *
 * Routes:
 *   POST /memory/:agent/pattern    — PatternBodySchema
 *   GET  /memory/:agent            — (no body; no schema needed)
 *   POST /memory/subagent-lesson   — SubagentLessonBodySchema
 *   POST /memory/subagent-friction — SubagentFrictionBodySchema
 */
import { z } from "zod";

/**
 * POST /memory/:agent/pattern
 *
 * Required: category (string), action (string).
 * Optional: example (string), cycleId (string), severity ("prevent" | "reinforce").
 *
 * The legacy inline guard was `if (!category || !action) → 400`.
 * This schema preserves that exact contract: absent / blank values fail
 * the `.min(1)` and the handler returns `{code:"schema-validation-failed",issues}`.
 */
export const PatternBodySchema = z.object({
  category: z.string().min(1),
  action: z.string().min(1),
  example: z.string().optional(),
  cycleId: z.string().optional(),
  severity: z.enum(["prevent", "reinforce"]).optional(),
});

/**
 * POST /memory/subagent-lesson
 *
 * Required: skill (SubagentSkill union), outcome (SubagentOutcome union), cue (non-empty string).
 * Optional: context (string), action (string), severity ("prevent" | "reinforce"), cycleId (string).
 *
 * The skill and outcome values are validated downstream by isValidSkill /
 * isValidOutcome, so this schema uses z.string().min(1) for both — the domain
 * module owns the enum gate; the schema owns the presence gate. This avoids
 * coupling the schema to the Dispatch-Class Taxonomy runtime list.
 */
export const SubagentLessonBodySchema = z.object({
  skill: z.string().min(1),
  outcome: z.string().min(1),
  cue: z.string().min(1),
  context: z.string().optional(),
  action: z.string().optional(),
  severity: z.enum(["prevent", "reinforce"]).optional(),
  cycleId: z.string().optional(),
});

/**
 * POST /memory/subagent-friction
 *
 * Required: skill (string), cue (non-empty string), workaround (non-empty string).
 * Optional: context (string), cycleId (string).
 *
 * Same skill presence gate as SubagentLessonBodySchema — isValidSkill owns the
 * domain check; this schema owns the presence check.
 */
export const SubagentFrictionBodySchema = z.object({
  skill: z.string().min(1),
  cue: z.string().min(1),
  workaround: z.string().min(1),
  context: z.string().optional(),
  cycleId: z.string().optional(),
});
