/**
 * Schemas for the Dashboard v2 Today page (issue #616, PRD #615).
 *
 * Slice 1 — tracer-bullet: ONE aggregator → ONE endpoint → ONE banner.
 *
 * Why a `v2/` sub-directory: the v2 dashboard rebuild (PRD #615) introduces
 * a parallel route tree at `/v2/*` while the existing dashboard keeps
 * serving its routes unchanged. The schemas namespace mirrors that route
 * namespace so cross-references stay readable (`v2/today.ts` ↔ `/v2/today`).
 *
 * Schema discipline follows the queue.ts seed (see ADR-0011): `.strict()`
 * objects, trimmed validators, `z.infer<>` for the canonical TypeScript
 * type, structured `schema-validation-failed` error envelope at the route.
 */
import { z } from "zod";

/**
 * Query body for `GET /api/v2/today/summary`.
 *
 * - `windowHours` defaults to 12 (overnight). Operator can override via
 *   `?windowHours=N`. Clamped at [1, 168] (one hour through one week) — a
 *   week is the upper bound the underlying data sources can sensibly cover:
 *   autopilot run index TTL is 7d, surrogate cost is daily-bucketed, and a
 *   `gh issue list` for >1w would page heavily.
 * - Comes from Express `req.query` so the raw value is a string — we coerce
 *   via `z.coerce.number()` to keep route code tidy.
 */
export const OvernightSummaryQuerySchema = z
  .object({
    windowHours: z.coerce
      .number({ message: "windowHours must be a number" })
      .int({ message: "windowHours must be an integer" })
      .min(1, { message: "windowHours must be >= 1" })
      .max(168, { message: "windowHours must be <= 168" })
      .default(12),
  })
  .strict();

export type OvernightSummaryQuery = z.infer<typeof OvernightSummaryQuerySchema>;

/**
 * Headroom verdict — derived from the Subscription Usage Tracker.
 *
 * - `green`  — projectedWeeklyPercent < 80, no pressure.
 * - `yellow` — pacing flagged "on" (80–100% projection) — operator should
 *   watch but no action required.
 * - `red`    — pacing "over" OR `emergencyStop` true — autopilot will start
 *   shedding non-essential classes.
 * - `unknown` — quota envs not calibrated; usage tracker is reporting 0%.
 *
 * Keeping this as a discriminated string (not a number) so the dashboard
 * can render a colored chip directly without re-thresholding.
 */
export const HeadroomLevelSchema = z.enum(["green", "yellow", "red", "unknown"]);

/**
 * Response body for `GET /api/v2/today/summary`.
 *
 * Mirrors `OvernightSummary` from the aggregator. The aggregator is the
 * authoritative source of the field set; this schema exists so the HTTP
 * boundary has a runtime-checkable contract independent of TypeScript
 * compilation. Keep the two in lockstep — a test pins this.
 */
export const OvernightSummaryResponseSchema = z
  .object({
    /** PRs merged to master inside the window (counted via `git log`). */
    mergeCount: z.number().int().nonnegative(),
    /** Autopilot runs started inside the window (`hydra:autopilot:runs:index`). */
    runCount: z.number().int().nonnegative(),
    /**
     * USD spent over the window — surrogate from `getDailySpendSurrogate()`.
     * Sub-day windows still get the full day's surrogate (the surrogate is
     * day-bucketed and the operator-facing number is "today so far"). When
     * the window crosses a UTC day boundary we still return today's
     * surrogate; the field is informational, not financial.
     */
    costSpent: z.number().nonnegative(),
    /** Issues opened on gaberoo322/hydra during the window. */
    issuesOpened: z.number().int().nonnegative(),
    /** Quota headroom verdict — see HeadroomLevelSchema. */
    headroom: HeadroomLevelSchema,
    /** Echo of the window used so the client can render "Last N hours". */
    windowHours: z.number().int().positive(),
    /** ISO timestamp of when the aggregation ran. */
    generatedAt: z.string(),
  })
  .strict();

export type OvernightSummaryResponse = z.infer<typeof OvernightSummaryResponseSchema>;

// ---------------------------------------------------------------------------
// Slice-2 schemas (issue #617)
// ---------------------------------------------------------------------------

/** Source vocabulary for `DecisionItem.source` — mirror of the aggregator type. */
export const DecisionItemSourceSchema = z.enum([
  "operator-decision-queue",
  "ready-for-human",
  "needs-info",
]);

/**
 * Response body for `GET /api/v2/today/decision-queue`. The aggregator
 * returns an array — the schema wraps it under `{ items }` so the route
 * has a place to grow other top-level fields (counts, generatedAt) later
 * without breaking clients.
 */
export const DecisionItemSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    createdAt: z.string(),
    labels: z.array(z.string()),
    source: DecisionItemSourceSchema,
    sources: z.array(DecisionItemSourceSchema),
  })
  .strict();

export const DecisionQueueResponseSchema = z
  .object({
    items: z.array(DecisionItemSchema),
    generatedAt: z.string(),
  })
  .strict();

export type DecisionQueueResponse = z.infer<typeof DecisionQueueResponseSchema>;

/**
 * Response body for `GET /api/v2/today/stuck`. Three pre-classified
 * buckets plus the thresholds used so the dashboard can render labels
 * like "blocked > 2d".
 */
export const StuckIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    createdAt: z.string(),
    ageDays: z.number().int().nonnegative(),
    labels: z.array(z.string()),
  })
  .strict();

export const StuckPrSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    failedChecks: z.array(z.string()),
    updatedAt: z.string(),
  })
  .strict();

export const StuckThresholdsSchema = z
  .object({
    blockedDays: z.number().int().positive(),
    needsInfoDays: z.number().int().positive(),
  })
  .strict();

export const StuckItemsResponseSchema = z
  .object({
    blockedOver2d: z.array(StuckIssueSchema),
    needsInfoWaiting: z.array(StuckIssueSchema),
    prsWithFailedCi: z.array(StuckPrSchema),
    thresholds: StuckThresholdsSchema,
    generatedAt: z.string(),
  })
  .strict();

export type StuckItemsResponse = z.infer<typeof StuckItemsResponseSchema>;

/**
 * Query schema for `GET /api/v2/today/merges`. `limit` defaults to 10
 * and is clamped at [1, 50] — same bound as the aggregator's `clampLimit`.
 */
export const RecentMergesQuerySchema = z
  .object({
    limit: z.coerce
      .number({ message: "limit must be a number" })
      .int({ message: "limit must be an integer" })
      .min(1, { message: "limit must be >= 1" })
      .max(50, { message: "limit must be <= 50" })
      .default(10),
  })
  .strict();

export type RecentMergesQuery = z.infer<typeof RecentMergesQuerySchema>;

export const MergeItemSchema = z
  .object({
    prNumber: z.number().int().positive(),
    title: z.string(),
    tier: z.number().int().nullable(),
    classLabel: z.string().nullable(),
    mergedAt: z.string(),
    url: z.string(),
  })
  .strict();

export const RecentMergesResponseSchema = z
  .object({
    items: z.array(MergeItemSchema),
    limit: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type RecentMergesResponse = z.infer<typeof RecentMergesResponseSchema>;

/**
 * Query schema for window-scoped endpoints — reused by `findings` and
 * `lessons-overnight`. Same bounds as the overnight-summary query, but
 * defaulted to 24h since both endpoints describe "recent" findings rather
 * than the 12h overnight window of the summary.
 */
export const WindowedQuerySchema = z
  .object({
    windowHours: z.coerce
      .number({ message: "windowHours must be a number" })
      .int({ message: "windowHours must be an integer" })
      .min(1, { message: "windowHours must be >= 1" })
      .max(168, { message: "windowHours must be <= 168" })
      .default(24),
  })
  .strict();

export type WindowedQuery = z.infer<typeof WindowedQuerySchema>;

export const FindingSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    createdAt: z.string(),
    labels: z.array(z.string()),
    excerpt: z.string(),
  })
  .strict();

export const FindingsResponseSchema = z
  .object({
    items: z.array(FindingSchema),
    windowHours: z.number().int().positive(),
    generatedAt: z.string(),
  })
  .strict();

export type FindingsResponse = z.infer<typeof FindingsResponseSchema>;

export const PromotionCandidateSchema = z
  .object({
    skill: z.string(),
    cue: z.string(),
    hitCount: z.number().int().nonnegative(),
    hitsToPromotion: z.number().int().positive(),
    lastSeen: z.string(),
    examples: z.array(z.string()),
  })
  .strict();

export const MetaFrictionIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const LessonsOvernightResponseSchema = z
  .object({
    promotionCandidates: z.array(PromotionCandidateSchema),
    metaFrictionOpened: z.array(MetaFrictionIssueSchema),
    windowHours: z.number().int().positive(),
    generatedAt: z.string(),
    promotionThreshold: z.number().int().positive(),
  })
  .strict();

export type LessonsOvernightResponse = z.infer<typeof LessonsOvernightResponseSchema>;
