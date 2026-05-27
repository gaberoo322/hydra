/**
 * Schemas for the Dashboard v2 Explore page (issue #620, PRD #615).
 *
 * Slice 5 adds five new endpoints under `/api/v2/explore/*`:
 *
 *   GET /v2/explore/friction       — friction-patterns aggregator
 *   GET /v2/explore/behavior       — behavior-gallery (autopilot run gallery)
 *   GET /v2/explore/flow           — backlog-flow (per-class added/closed/blocked)
 *   GET /v2/explore/lessons        — lessons-explorer (promoted lessons)
 *   GET /v2/explore/anomalies      — anomaly-detector (z-score deviations)
 *
 * The Architecture and Search tabs reuse the existing `/api/architecture`
 * and `/api/openviking/search` endpoints — no new schemas needed for those.
 *
 * Conventions follow slice-1/2 (today.ts): `.strict()` objects, trimmed
 * coerce-from-string number queries, structured `schema-validation-failed`
 * envelope at the route boundary.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared vocabulary (mirrors aggregators/types.ts)
// ---------------------------------------------------------------------------

export const AutopilotRunOutcomeSchema = z.enum([
  "success",
  "failure",
  "aborted",
  "in-progress",
  "unknown",
]);

export const AnomalyMetricSchema = z.enum([
  "cost-per-hour",
  "abandonment-rate",
  "dispatch-class-failure-rate",
]);

export const AnomalyDirectionSchema = z.enum(["high", "low"]);

// ---------------------------------------------------------------------------
// /v2/explore/friction
// ---------------------------------------------------------------------------

export const FrictionPatternRowSchema = z
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

export const FrictionGroupSchema = z
  .object({
    skill: z.string(),
    patterns: z.array(FrictionPatternRowSchema),
  })
  .strict();

export const MetaFrictionIssueRefSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const FrictionPatternsResponseSchema = z
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

export type BehaviorGalleryQuery = z.infer<typeof BehaviorGalleryQuerySchema>;

export const BehaviorRowSchema = z
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
    totalCostUsd: z.number().nonnegative(),
    exitCode: z.number().int().nullable(),
    termReason: z.string().nullable(),
    classes: z.array(z.string()),
    detailHref: z.string(),
  })
  .strict();

export const BehaviorGalleryResponseSchema = z
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
// /v2/explore/flow
// ---------------------------------------------------------------------------

export const BacklogFlowQuerySchema = z
  .object({
    window: z
      .string()
      .trim()
      .regex(/^\d+d$/, { message: "window must look like '7d'" })
      .default("7d"),
  })
  .strict();

export type BacklogFlowQuery = z.infer<typeof BacklogFlowQuerySchema>;

export const ClassFlowRowSchema = z
  .object({
    class: z.string(),
    added: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  })
  .strict();

export const BacklogFlowResponseSchema = z
  .object({
    byClass: z.array(ClassFlowRowSchema),
    windowDays: z.number().int().positive(),
    totals: z
      .object({
        added: z.number().int().nonnegative(),
        closed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
      })
      .strict(),
    generatedAt: z.string(),
  })
  .strict();

export type BacklogFlowResponse = z.infer<typeof BacklogFlowResponseSchema>;

// ---------------------------------------------------------------------------
// /v2/explore/lessons
// ---------------------------------------------------------------------------

export const LessonsExplorerQuerySchema = z
  .object({
    skill: z.string().trim().min(1).optional(),
  })
  .strict();

export type LessonsExplorerQuery = z.infer<typeof LessonsExplorerQuerySchema>;

export const PromotedLessonSchema = z
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

export const LessonsExplorerResponseSchema = z
  .object({
    lessons: z.array(PromotedLessonSchema),
    promotionThreshold: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type LessonsExplorerResponse = z.infer<typeof LessonsExplorerResponseSchema>;

// ---------------------------------------------------------------------------
// /v2/explore/anomalies
// ---------------------------------------------------------------------------

export const AnomalySchema = z
  .object({
    metric: AnomalyMetricSchema,
    subKey: z.string().nullable(),
    latest: z.number(),
    baselineMean: z.number(),
    baselineStd: z.number(),
    zScore: z.number(),
    direction: AnomalyDirectionSchema,
    threshold: z.number(),
    sampleAt: z.string(),
  })
  .strict();

export const AnomalyDetectorResponseSchema = z
  .object({
    anomalies: z.array(AnomalySchema),
    threshold: z.number(),
    baselineWindowDays: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type AnomalyDetectorResponse = z.infer<typeof AnomalyDetectorResponseSchema>;
