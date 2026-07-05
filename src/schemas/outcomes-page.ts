/**
 * Schemas for the Dashboard v2 Outcomes page (issue #619, PRD #615).
 *
 * Slice 4 — three 7-day-trend aggregators with their HTTP boundary schemas:
 *
 *   GET /api/v2/outcomes/trends      — per-outcome time series + delta
 *   GET /api/v2/outcomes/lessons     — promotion rate + top friction
 *   GET /api/v2/outcomes/quota       — subscription quota burn/headroom
 *
 * NB: the `GET /api/v2/outcomes/calibration` schema (tier + cost accuracy
 * time series) was removed with the endpoint in issue #2876 — its backing
 * lane (`hydra:anchors:calibration:*`) has had no writer since ADR-0016.
 *
 * Schema discipline follows the queue.ts seed (see ADR-0011): `.strict()`
 * objects, trimmed validators, `z.infer<>` for canonical TypeScript types,
 * structured `schema-validation-failed` error envelope at the route.
 *
 * All three endpoints share a `window=7d`-style query — parsed via
 * `WindowedDaysQuerySchema`. The dashboard polls every 5min (slow review).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Query schema — shared across all four endpoints
// ---------------------------------------------------------------------------

/**
 * Query schema for the Outcomes endpoints. `window` accepts the literal
 * form `7d` (or any positive integer of days, capped at 30) and resolves
 * to a number of days via `.transform()`. Defaults to 7.
 *
 * The bound of 30 days is deliberate — the underlying aggregators (Redis
 * scans + `gh issue list`) are happy at 7d but get expensive at 90d, and
 * the Outcomes page is for weekly review, not historical archaeology.
 */
export const WindowedDaysQuerySchema = z
  .object({
    window: z
      .string({ message: "window must be a string like '7d'" })
      .regex(/^(\d+)d$/, {
        message: "window must be of the form '<N>d' (e.g. '7d')",
      })
      .default("7d")
      .transform((s) => Number(s.slice(0, -1)))
      .pipe(
        z
          .number()
          .int({ message: "window must be an integer number of days" })
          .min(1, { message: "window must be >= 1 day" })
          .max(30, { message: "window must be <= 30 days" }),
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared time-series point — reused by trends, lessons, quota
// ---------------------------------------------------------------------------

const TrendPointSchema = z
  .object({
    t: z.string(),
    v: z.number(),
  })
  .strict();

// ---------------------------------------------------------------------------
// GET /api/v2/outcomes/trends
// ---------------------------------------------------------------------------

const OutcomeTrendSchema = z
  .object({
    name: z.string(),
    direction: z.enum(["up", "down"]),
    points: z.array(TrendPointSchema),
    baseline: z.number(),
    target: z.number(),
    deltaPct: z.number().nullable(),
  })
  .strict();

const OutcomeTrendsResponseSchema = z
  .object({
    windowDays: z.number().int().positive(),
    generatedAt: z.string(),
    outcomes: z.array(OutcomeTrendSchema),
  })
  .strict();

export type OutcomeTrendsResponse = z.infer<typeof OutcomeTrendsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/v2/outcomes/lessons
// ---------------------------------------------------------------------------

const FrictionItemSchema = z
  .object({
    skill: z.string(),
    cue: z.string(),
    hitCount: z.number().int().nonnegative(),
    lastSeen: z.string(),
  })
  .strict();

const LessonsTrendResponseSchema = z
  .object({
    windowDays: z.number().int().positive(),
    generatedAt: z.string(),
    promotionRate: z.array(TrendPointSchema),
    topFriction: z.array(FrictionItemSchema),
    metaFrictionOpened: z.number().int().nonnegative(),
    promotionThreshold: z.number().int().positive(),
  })
  .strict();

export type LessonsTrendResponse = z.infer<typeof LessonsTrendResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/v2/outcomes/quota
// ---------------------------------------------------------------------------

const QuotaSeriesSchema = z
  .object({
    points: z.array(TrendPointSchema),
  })
  .strict();

const QuotaTrendResponseSchema = z
  .object({
    windowDays: z.number().int().positive(),
    generatedAt: z.string(),
    percentBurned: QuotaSeriesSchema,
    headroom: QuotaSeriesSchema,
    calibrated: z.boolean(),
  })
  .strict();

export type QuotaTrendResponse = z.infer<typeof QuotaTrendResponseSchema>;
