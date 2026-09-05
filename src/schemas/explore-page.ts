/**
 * Schemas for the Dashboard v2 Explore page (issue #620, PRD #615).
 *
 * Slice 5 added five new endpoints under `/api/v2/explore/*`; the
 * `anomalies` and `flow` routes (and their response schemas) were removed as
 * orphaned dead code (issue #4356) — their frontend tabs were deleted in
 * #4012/#4256 but the backend routes were missed. The three that remain:
 *
 *   GET /v2/explore/friction       — friction-patterns aggregator
 *   GET /v2/explore/behavior       — behavior-gallery (autopilot run gallery)
 *   GET /v2/explore/lessons        — lessons-explorer (promoted lessons)
 *
 * The Architecture tab reuses the existing `/api/architecture` endpoint — no
 * new schema needed for it. (The Search tab's `/api/openviking/search` was
 * deleted with the knowledge plane, ADR-0033.)
 *
 * `AnomalyDirection`/`AnomalyDirectionSchema` and the `meanStd`/`zScore`/
 * `classifyZ` z-score primitives they backed were themselves deleted in this
 * same pass — a repo-wide grep confirmed classifyZ (their last consumer) had
 * no remaining callers once `anomaly-detector.ts` was gone.
 *
 * Conventions follow slice-1/2 (today.ts): `.strict()` objects, trimmed
 * coerce-from-string number queries, structured `schema-validation-failed`
 * envelope at the route boundary.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Outcome of an autopilot run, as recorded on the `hydra:autopilot:run:*`
 * hash. Closed set so the dashboard can render a coloured chip without
 * re-bucketing. `unknown` covers historical rows pre-dating outcome stamping.
 */
const AutopilotRunOutcomeSchema = z.enum([
  "success",
  "failure",
  "aborted",
  "in-progress",
  "unknown",
]);

export type AutopilotRunOutcome = z.infer<typeof AutopilotRunOutcomeSchema>;

// ---------------------------------------------------------------------------
// /v2/explore/friction
// ---------------------------------------------------------------------------

const FrictionPatternRowSchema = z
  .object({
    skill: z.string(),
    cue: z.string(),
    severity: z.enum(["prevent", "reinforce"]),
    hitCount: z.number().int().nonnegative(),
    hitsToPromotion: z.number().int().nonnegative(),
    promoted: z.boolean(),
    lastSeen: z.string(),
    firstSeen: z.string(),
    examples: z.array(z.string()),
    nearThreshold: z.boolean(),
  })
  .strict();

const FrictionGroupSchema = z
  .object({
    skill: z.string(),
    patterns: z.array(FrictionPatternRowSchema),
  })
  .strict();

const MetaFrictionIssueRefSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    createdAt: z.string(),
  })
  .strict();

const FrictionPatternsResponseSchema = z
  .object({
    bySkill: z.array(FrictionGroupSchema),
    thresholdCandidates: z.array(FrictionPatternRowSchema),
    recentMetaFrictionIssues: z.array(MetaFrictionIssueRefSchema),
    promotionThreshold: z.number().int().positive(),
    candidateWindow: z.number().int().positive(),
    windowHours: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type FrictionPatternsResponse = z.infer<typeof FrictionPatternsResponseSchema>;

// ---------------------------------------------------------------------------
// /v2/explore/behavior
// ---------------------------------------------------------------------------

export const BehaviorGalleryQuerySchema = z
  .object({
    limit: z.coerce
      .number({ message: "limit must be a number" })
      .int({ message: "limit must be an integer" })
      .min(1, { message: "limit must be >= 1" })
      .max(200, { message: "limit must be <= 200" })
      .default(50),
    class: z.string().trim().min(1).optional(),
    outcome: AutopilotRunOutcomeSchema.optional(),
  })
  .strict();

const BehaviorRowSchema = z
  .object({
    runId: z.string(),
    startedAt: z.string(),
    durationS: z.number().nullable(),
    status: z.string(),
    outcome: AutopilotRunOutcomeSchema,
    trigger: z.string(),
    turns: z.number().int().nonnegative(),
    dispatches: z.number().int().nonnegative(),
    mergedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    termReason: z.string().nullable(),
    classes: z.array(z.string()),
    detailHref: z.string(),
  })
  .strict();

const BehaviorGalleryResponseSchema = z
  .object({
    items: z.array(BehaviorRowSchema),
    limit: z.number().int().positive(),
    filters: z
      .object({
        class: z.string().nullable(),
        outcome: AutopilotRunOutcomeSchema.nullable(),
      })
      .strict(),
    generatedAt: z.string(),
  })
  .strict();

export type BehaviorGalleryResponse = z.infer<typeof BehaviorGalleryResponseSchema>;

// ---------------------------------------------------------------------------
// /v2/explore/lessons
// ---------------------------------------------------------------------------

export const LessonsExplorerQuerySchema = z
  .object({
    skill: z.string().trim().min(1).optional(),
  })
  .strict();

const PromotedLessonSchema = z
  .object({
    skill: z.string(),
    cue: z.string(),
    severity: z.enum(["prevent", "reinforce"]),
    hitCount: z.number().int().nonnegative(),
    hitsAtPromotion: z.number().int().nonnegative().nullable(),
    postPromotionHits: z.number().int().nonnegative().nullable(),
    promotedAt: z.string(),
    lastSeen: z.string(),
    examples: z.array(z.string()),
    demoted: z.boolean(),
  })
  .strict();

const LessonsExplorerResponseSchema = z
  .object({
    lessons: z.array(PromotedLessonSchema),
    promotionThreshold: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type LessonsExplorerResponse = z.infer<typeof LessonsExplorerResponseSchema>;
