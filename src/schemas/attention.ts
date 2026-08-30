/**
 * Schemas for the attention feed (issue #4007, ADR-0034 §4 — the `/` Today
 * page's "what needs me" surface).
 *
 * One heterogeneous threshold-crossing feed mixing three signals —
 * blocked-on-human, breakage, repetition — under one common item shape. Each
 * item carries the line it crossed as its own explanation
 * (`observedValue` + `threshold` + `thresholdLabel`), so a derived value never
 * appears without the inputs it decomposes into (ADR-0034 §5.3).
 *
 * Deviation (spend / quota / duration outside a normal band) is deliberately
 * excluded from the signal vocabulary (ADR-0034 §4): money is something the
 * operator goes and looks at on `/health`, not something that interrupts
 * them. The closed enum below is the mechanical guard — a cost-shaped signal
 * cannot validate.
 *
 * Schema discipline follows the today-page seed (ADR-0011): `.strict()`
 * objects, `z.infer<>` for the canonical TypeScript type, structured
 * `schema-validation-failed` error envelope at the route.
 */
import { z } from "zod";

/**
 * The three attention signals (ADR-0034 §4). Closed by design — adding a
 * signal is an ADR-level decision, not a schema tweak. There is deliberately
 * NO spend / quota / duration / deviation member.
 */
export const AttentionSignalSchema = z.enum([
  "blocked-on-human",
  "breakage",
  "repetition",
]);

export type AttentionSignal = z.infer<typeof AttentionSignalSchema>;

/**
 * One crossed threshold, as the feed renders it. The common shape every
 * heterogeneous signal (issue, PR, friction pattern) maps onto.
 *
 * - `observedValue` / `threshold` are ALWAYS the literal numbers the
 *   underlying source already computed, sourced from the SAME threshold
 *   constants in production (`DEFAULT_THRESHOLDS` in stuck-items.ts,
 *   `PROMOTION_THRESHOLD` in pattern-memory/constants.ts). The composer never
 *   invents a new line (issue #4007).
 * - `thresholdLabel` renders the line in prose ("blocked ≥ 2d") so the row is
 *   its own explanation.
 * - `crossedAt` is the best-effort instant the item crossed (issue creation +
 *   threshold days for age lines; last observed failure / last hit for the
 *   others) — feeds sort oldest-crossing-first.
 * - `dismissed` is always `false` in a feed read: dismissed items are
 *   filtered out server-side (durable per item id), so the field exists to
 *   make the shape explicit, not to render a dismissed row.
 */
export const AttentionFeedItemSchema = z
  .object({
    /** Stable, durable dismissal key — survives across feed reads. */
    id: z.string().min(1),
    signal: AttentionSignalSchema,
    title: z.string(),
    /** Deep link to the page/entity that owns this item's detail. */
    url: z.string(),
    observedValue: z.number().int().nonnegative(),
    threshold: z.number().int().nonnegative(),
    thresholdLabel: z.string(),
    crossedAt: z.string(),
    dismissed: z.boolean(),
  })
  .strict();

export type AttentionFeedItem = z.infer<typeof AttentionFeedItemSchema>;

/**
 * Response body for `GET /api/attention/feed`. Carries the ADR-0034 §5.2
 * asserted-emptiness evidence (`scanned` + `sourcesOk`) — same contract as
 * `DecisionQueueResponse` from #4006 — so the client renders a genuine
 * all-clear ONLY on a proven empty list and UNKNOWN on an unproven one.
 */
export const AttentionFeedResponseSchema = z
  .object({
    items: z.array(AttentionFeedItemSchema),
    /** Pre-filter raw row count from the fulfilled sub-fetches (proof the lookup ran). */
    scanned: z.number().int().nonnegative(),
    /** True iff every underlying sub-fetch settled fulfilled (the emptiness assertion). */
    sourcesOk: z.boolean(),
    generatedAt: z.string(),
  })
  .strict();

export type AttentionFeedResponse = z.infer<typeof AttentionFeedResponseSchema>;

/**
 * Request body for `POST /api/attention/:id/dismiss`. `.strict()` — an
 * unexpected key is a 400, not a silently-ignored extra. `signal` keys the
 * per-threshold counters (dismissals are counted per LINE, not per item, so
 * the calibration signal survives across individual items — ADR-0034 §4);
 * `reason` is the mandatory dismiss-with-a-reason.
 */
export const DismissAttentionRequestSchema = z
  .object({
    reason: z
      .string({ message: "reason must be a string" })
      .trim()
      .min(1, { message: "reason must be a non-empty string" }),
    signal: AttentionSignalSchema,
  })
  .strict();

/** One per-threshold calibration row. */
export const AttentionThresholdCountSchema = z
  .object({
    signal: AttentionSignalSchema,
    /** Items this line has surfaced (counted once per item id). */
    surfaced: z.number().int().nonnegative(),
    /** Dismissals recorded against this line. */
    dismissed: z.number().int().nonnegative(),
  })
  .strict();

export type AttentionThresholdCount = z.infer<typeof AttentionThresholdCountSchema>;

/**
 * Response body for `GET /api/attention/counts` — the falsifiable-calibration
 * read (ADR-0034 §4): a line whose items are always dismissed unread is
 * miscalibrated and says so in the data.
 */
export const AttentionCountsResponseSchema = z
  .object({
    counts: z.array(AttentionThresholdCountSchema),
    generatedAt: z.string(),
  })
  .strict();

export type AttentionCountsResponse = z.infer<typeof AttentionCountsResponseSchema>;
