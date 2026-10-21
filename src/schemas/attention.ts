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
import {
  ADMISSION_LINE_KEYS,
  BUCKETS,
  BucketSchema,
  OperatorActionEntrySchema,
  isAdmissionLineKey,
} from "./operator-actions.ts";
import {
  CALIBRATION_VERDICTS,
  CALIBRATION_WINDOW_DAYS,
} from "../attention-calibration.ts";

/**
 * The three attention signals (ADR-0034 §4). Closed by design — adding a
 * signal is an ADR-level decision, not a schema tweak. There is deliberately
 * NO spend / quota / duration / deviation member.
 */
// Module-private (issue #4259): the schema const has no importer outside this
// file — every other module consumes the derived `AttentionSignal` type below
// or (for the closed-vocabulary values) `AttentionSignal`-typed data.
const AttentionSignalSchema = z.enum([
  "blocked-on-human",
  "breakage",
  "repetition",
]);

type AttentionSignal = z.infer<typeof AttentionSignalSchema>;

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
/**
 * A `<bucket>:<line>` admission-line key (ADR-0034 §8.1) — the vocabulary is
 * `BUCKET_LINES` in src/schemas/operator-actions.ts, never a second copy.
 */
const AdmissionLineKeySchema = z.string().refine(isAdmissionLineKey, {
  message: 'key must be a "<bucket>:<line>" admission line drawn from BUCKET_LINES',
});

/**
 * One active line of the rank-0 "machine stopped" aggregate row (issue #4623,
 * ADR-0034 §8.1): `paused` / `session-blocked` / `scheduler-deliberate` /
 * `sha-drift`, each with its own resolved registry action.
 */
const MachineStoppedSubLineSchema = z
  .object({
    key: AdmissionLineKeySchema,
    line: z.string().min(1),
    detail: z.string(),
    action: OperatorActionEntrySchema,
  })
  .strict();

export type MachineStoppedSubLine = z.infer<typeof MachineStoppedSubLineSchema>;

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
    /** The ADR-0034 §8.1 bucket this item drains in (issue #4623). */
    bucket: BucketSchema,
    /** The bucket's drain rank, 0 (machine stopped) .. 5 (parked over cap). */
    rank: z.number().int().min(0).max(BUCKETS.length - 1),
    /** The `<bucket>:<line>` admission line the item crossed. */
    key: AdmissionLineKeySchema,
    /**
     * The registry entry for `key` (ADR-0034 §8.2), with `{repo}` /
     * `{number}` / `{kind}` templates resolved server-side from the item.
     */
    action: OperatorActionEntrySchema,
    /**
     * Optional one-line context (issue #4625): a reframe row's attempt count /
     * transcript deep link, or the archived-Target row's hint. The title keeps
     * linking to the owning entity; this is purely additive.
     */
    detail: z.string().optional(),
    /** Rank-0 aggregate only: the active machine-stopped lines, in line order. */
    subLines: z.array(MachineStoppedSubLineSchema).optional(),
  })
  .strict();

export type AttentionFeedItem = z.infer<typeof AttentionFeedItemSchema>;

/**
 * Response body for `GET /api/attention/feed`. Carries the ADR-0034 §5.2
 * asserted-emptiness evidence (`scanned` + `sourcesOk`) — same contract as
 * `DecisionQueueResponse` from #4006 — so the client renders a genuine
 * all-clear ONLY on a proven empty list and UNKNOWN on an unproven one.
 */
/**
 * One bucket summary (issue #4623, ADR-0034 §5.2 per-bucket asserted
 * emptiness). Items are NOT nested here — each item carries its own
 * `bucket` + `rank`; this row asserts the bucket's zero (or names the sources
 * that failed to prove it). `wired:false` marks a bucket with no source yet —
 * never an asserted zero.
 */
const AttentionBucketSummarySchema = z
  .object({
    rank: z.number().int().min(0).max(BUCKETS.length - 1),
    bucket: BucketSchema,
    wired: z.boolean(),
    count: z.number().int().nonnegative(),
    scanned: z.number().int().nonnegative(),
    sourcesOk: z.boolean(),
    sourceErrors: z.array(z.string().min(1)),
  })
  .strict();

export type AttentionBucketSummary = z.infer<typeof AttentionBucketSummarySchema>;

export const AttentionFeedResponseSchema = z
  .object({
    items: z.array(AttentionFeedItemSchema),
    /** Exactly six bucket summaries, in BUCKETS drain order. */
    buckets: z.array(AttentionBucketSummarySchema).length(BUCKETS.length),
    /** Pre-filter raw row count from the fulfilled sub-fetches (proof the lookup ran). */
    scanned: z.number().int().nonnegative(),
    /** True iff every underlying sub-fetch settled fulfilled (the emptiness assertion). */
    sourcesOk: z.boolean(),
    generatedAt: z.string(),
  })
  .strict();

export type AttentionFeedResponse = z.infer<typeof AttentionFeedResponseSchema>;

/**
 * Request body for `POST /api/attention/:id/dismiss` (ADR-0034 §8.4). The
 * dismiss is TYPED — one of the three reasons — and carries the admission
 * line `key` so the server never parses a line out of an item id (the
 * machine-stopped aggregate's id is a sorted set of lines; the episode is
 * the (key, id) pair). `.strict()` — `signal` and free-text reasons are a
 * 400 `schema-validation-failed`, not a silently-ignored extra.
 */
export const DismissAttentionRequestSchema = z
  .object({
    reason: z.enum(["not-a-problem", "handled-elsewhere", "later"]),
    key: AdmissionLineKeySchema,
  })
  .strict();

export type AttentionDismissReason = z.infer<typeof DismissAttentionRequestSchema>["reason"];

/**
 * One per-line calibration row of `GET /attention/counts` (ADR-0034 §8.4).
 * The verdict's two inputs (`surfaced`, `notAProblem`) plus the reported
 * but non-falsifying counters, and the §5.3 `because` decomposition.
 */
const AttentionCalibrationLineSchema = z
  .object({
    key: AdmissionLineKeySchema,
    /** Episodes this line surfaced in the window (once per episode). */
    surfaced: z.number().int().nonnegative(),
    /** Surfaced episodes that cleared from a healthy source, never dismissed. */
    resolved: z.number().int().nonnegative(),
    notAProblem: z.number().int().nonnegative(),
    handledElsewhere: z.number().int().nonnegative(),
    later: z.number().int().nonnegative(),
    verdict: z.enum(CALIBRATION_VERDICTS),
    /** The §5.3 decomposition — cites the inputs and the constant. */
    because: z.string().min(1),
  })
  .strict();


/**
 * Response body for `GET /api/attention/counts` — the per-line falsifiable
 * calibration read (ADR-0034 §8.4): every registry line, zeros asserted, so
 * a line whose items are mostly dismissed *not-a-problem* is miscalibrated
 * and says so in the data. Module-private (issue #4259) — the derived
 * `AttentionCountsResponse` type is what `src/api/attention.ts` imports.
 */
const AttentionCountsResponseSchema = z
  .object({
    windowDays: z.literal(CALIBRATION_WINDOW_DAYS),
    generatedAt: z.string(),
    /** Exactly ADMISSION_LINE_KEYS.length rows, in drain order. */
    lines: z.array(AttentionCalibrationLineSchema).length(ADMISSION_LINE_KEYS.length),
  })
  .strict();

export type AttentionCountsResponse = z.infer<typeof AttentionCountsResponseSchema>;
