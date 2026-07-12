/**
 * Schemas for the design-concept HTTP boundary (slice 1 of ADR-0011).
 *
 * These zod schemas are the canonical shape of every body accepted by
 * `src/api/design-concepts.ts`. Per ADR-0011, each `src/schemas/<domain>.ts`
 * exports exactly two things per shape: a `z.object().strict()` schema and a
 * `z.infer<typeof Schema>` type. No express imports, no middleware, no
 * `parseRequest(req, Schema)` facade — handlers call `safeParse` inline and
 * return `400 {code: "schema-validation-failed", issues: result.error.issues}`
 * on failure.
 *
 * The domain type `DesignConceptInput` and the nested value-object types
 * (`ModuleTouched` / `RejectedAlternative` / `QaTurn` / `Prototype`) are
 * inferred here so this file is the single source of truth for the input
 * contract. The `ExemptLogEntry` domain type + its `isExemptLogEntry` guard
 * live in `src/design-concept.ts` (issue #3226) — this file owns only the
 * `ExemptLogEntryInputSchema` wire-body parse, not the stored shape.
 *
 * See:
 *   - ADR-0011 — Schemas Seam for HTTP request bodies (slicing plan)
 *   - ADR-0008 — Design Concept gate (the artifact shape being typed)
 *   - issue #562 — zod adoption + `src/schemas/queue.ts` seed
 */
import { z } from "zod";

import { countQuerySchema } from "./common.ts";

// ---------------------------------------------------------------------------
// Nested value-object schemas
// ---------------------------------------------------------------------------

/**
 * One entry in `modulesTouched`. Mirrors the `ModuleTouched` type that
 * `src/design-concept.ts` used to define inline.
 */
const ModuleTouchedSchema = z
  .object({
    path: z.string().trim().min(1, { message: "path must be a non-empty string" }),
    interfaceImpact: z.enum(["none", "extend", "breaking"]),
    depthClassification: z.enum(["deep", "shallow", "unknown"]),
  })
  .strict();
type ModuleTouched = z.infer<typeof ModuleTouchedSchema>;

/** One rejected alternative — paired text fields. */
const RejectedAlternativeSchema = z
  .object({
    alt: z.string(),
    why: z.string(),
  })
  .strict();
type RejectedAlternative = z.infer<typeof RejectedAlternativeSchema>;

/** One Q&A turn in the design trace. */
const QaTurnSchema = z
  .object({
    q: z.string(),
    a: z.string(),
  })
  .strict();
type QaTurn = z.infer<typeof QaTurnSchema>;

/** One prototype snippet that resolved a hard logic/UI question. */
const PrototypeSchema = z
  .object({
    question: z.string(),
    branch: z.enum(["logic", "ui"]),
    snippet: z.string(),
    answer: z.string(),
    workTreePath: z.string(),
  })
  .strict();
type Prototype = z.infer<typeof PrototypeSchema>;

// ---------------------------------------------------------------------------
// Top-level enums (re-exported as the canonical type source)
// ---------------------------------------------------------------------------

const DesignConceptScopeSchema = z.enum(["orch", "target"]);

const DesignConceptStatusSchema = z.enum(["draft", "approved", "stale"]);

/**
 * `approvedBy` is one of:
 *   - `""` (unset — default for draft artifacts)
 *   - `"auto-gate"` (the autopilot's automatic approval path)
 *   - `"operator:<name>"` (operator-applied)
 *
 * Encoded as a `z.string()` with a `.refine` rather than a `z.union` of
 * literals + template, because zod's template-literal support is limited
 * and a refine gives a clearer error message.
 */
type ApprovedBy = "" | "auto-gate" | `operator:${string}`;
const ApprovedBySchema: z.ZodType<ApprovedBy> = z
  .string()
  .refine(
    (s): s is ApprovedBy =>
      s === "" || s === "auto-gate" || s.startsWith("operator:"),
    {
      message: 'approvedBy must be "", "auto-gate", or "operator:<name>"',
    },
  ) as z.ZodType<ApprovedBy>;

// ---------------------------------------------------------------------------
// Body for POST /api/design-concepts (create / overwrite)
// ---------------------------------------------------------------------------

/**
 * Body accepted by `POST /api/design-concepts`. Mirrors the field set of
 * the existing `DesignConceptInput` type in `src/design-concept.ts`:
 *
 *   - `anchorRef` (required) — the unique handle for this artifact.
 *   - `scope` (required) — `"orch"` or `"target"`.
 *   - `glossaryTerms` / `glossaryGaps` — string lists; default to `[]` when
 *     omitted (the handler used `?? []` for this).
 *   - `modulesTouched` / `invariants` / `rejectedAlternatives` / `qaTrace` /
 *     `prototypes` — typed lists; default to `[]` when omitted.
 *   - `status` (optional) — defaults to `"draft"` server-side.
 *   - `approvedBy` (optional) — defaults to `""` server-side.
 *
 * The server fills in `createdAt` and `artifactHash`, so they are NOT
 * accepted from the wire (`.strict()` rejects them).
 */
export const DesignConceptInputSchema = z
  .object({
    anchorRef: z
      .string({ message: "anchorRef must be a string" })
      .trim()
      .min(1, { message: "anchorRef (string) is required" }),
    scope: DesignConceptScopeSchema,
    glossaryTerms: z.array(z.string()).optional(),
    glossaryGaps: z.array(z.string()).optional(),
    modulesTouched: z.array(ModuleTouchedSchema).optional(),
    invariants: z.array(z.string()).optional(),
    rejectedAlternatives: z.array(RejectedAlternativeSchema).optional(),
    qaTrace: z.array(QaTurnSchema).optional(),
    prototypes: z.array(PrototypeSchema).optional(),
    status: DesignConceptStatusSchema.optional(),
    approvedBy: ApprovedBySchema.optional(),
  })
  .strict();
export type DesignConceptInput = z.infer<typeof DesignConceptInputSchema>;

// ---------------------------------------------------------------------------
// Body for POST /api/design-concepts/:anchorRef/approve
// ---------------------------------------------------------------------------

/**
 * Body accepted by `POST /api/design-concepts/:anchorRef/approve`.
 *
 * Pre-migration the handler accepted an optional `by` field that defaulted
 * to `"auto-gate"` and required either `"auto-gate"` or `"operator:<name>"`
 * — we preserve the optional-with-server-side-default semantics here so
 * existing callers don't break. Validation of the literal value lives on
 * the schema, so the handler no longer needs a hand-rolled prefix check.
 */
export const DesignConceptApproveBodySchema = z
  .object({
    by: z
      .string()
      .trim()
      .min(1)
      .refine((s) => s === "auto-gate" || s.startsWith("operator:"), {
        message: "by must be 'auto-gate' or 'operator:<name>'",
      })
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Body for POST /api/design-concepts/exempt-log
// ---------------------------------------------------------------------------

/**
 * Body accepted by `POST /api/design-concepts/exempt-log`. Mirrors the
 * `ExemptLogEntry` shape that `src/api/design-concepts.ts` used to define
 * inline, with one wire-only difference: `ts` is optional on input and
 * defaults to `Date.now()` server-side (the existing handler behaviour).
 *
 * `gate_fail_reasons` is required as an array; the handler still truncates
 * individual entries to 500 chars after parsing — that's a transformation,
 * not a validation concern.
 */
export const ExemptLogEntryInputSchema = z
  .object({
    pr: z
      .number()
      .int()
      .positive({ message: "pr (positive number) is required" }),
    applier: z.string().trim().min(1, {
      message: "applier (non-empty string) is required",
    }),
    anchorRef: z.string().trim().min(1, {
      message: "anchorRef (non-empty string) is required",
    }),
    ts: z.number().positive().optional(),
    gate_fail_reasons: z.array(z.string()),
  })
  .strict();

// ---------------------------------------------------------------------------
// Query schemas for the design-concept read routes (ADR-0022)
// ---------------------------------------------------------------------------
//
// Relocated from `src/api/design-concepts.ts` (issue #3226) so the DC
// validation grammar concentrates in this file and the route layer reduces to
// pure HTTP wiring. Both reuse the shared `countQuerySchema` factory (the
// `parseInt(...) || N` default-on-garbage + clamp idiom) under the wire-name
// `limit`. Non-strict (plain object schemas ignore unknown keys); the routes
// pass the whole `req.query` to `safeParse` and read typed, always-present
// fields.

/** Maximum number of audit entries the exempt-log read endpoint returns. */
export const EXEMPT_LOG_DEFAULT_LIMIT = 50;
const EXEMPT_LOG_MAX_LIMIT = 500;

/**
 * `GET /design-concepts/exempt-log?limit=N` — historic default 50, cap 500.
 */
export const ExemptLogQuerySchema = z.object({
  limit: countQuerySchema(EXEMPT_LOG_DEFAULT_LIMIT, EXEMPT_LOG_MAX_LIMIT).shape
    .count,
});

/**
 * `GET /design-concepts?scope=&limit=N` — historic default 50 (no explicit
 * cap previously; the factory's 1000 cap bounds an otherwise-unbounded slice).
 * `scope` is an optional `"orch" | "target"` enum; any other value (or absence)
 * collapses to `undefined`, exactly the legacy ternary.
 */
export const DesignConceptListQuerySchema = z.object({
  scope: z.enum(["orch", "target"]).optional().catch(undefined),
  limit: countQuerySchema(50).shape.count,
});
