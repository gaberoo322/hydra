/**
 * Schemas for the dispatch-class taxonomy endpoint (issue #2524).
 *
 * One read-only endpoint:
 *
 *   GET /api/taxonomy/classes → TaxonomyClassesResponse
 *
 * # Why this exists
 *
 * The **Dispatch-Class Taxonomy** (`scripts/autopilot/classes.json`, surfaced
 * as typed views by `src/taxonomy/classes.ts`) is the single machine-readable
 * table owning the autopilot class alphabet — pipeline-slot names, signal-class
 * names, and the per-signal cooldown map. `decide.py` derives its
 * `PIPELINE_SLOTS` / `SIGNAL_CLASSES` / `SIGNAL_COOLDOWNS` tuples from the same
 * file, so the Python and TS views can never drift.
 *
 * But the dashboard hard-codes three independent copies of this alphabet
 * (`Autopilot.jsx` PIPELINE_SLOTS/SIGNAL_CLASSES/SIGNAL_COOLDOWN_SEC, and
 * `now-pixel/sprite-map.ts` PIPELINE_CLASSES/SIGNAL_CLASSES/SIGNAL_COOLDOWNS).
 * Those copies already diverge and require a 3-4 file manual edit whenever a
 * class is added or retired. This endpoint exposes the authoritative typed
 * views over HTTP so the dashboard fetches the alphabet instead of mirroring it.
 *
 * The route is read-only over `src/taxonomy/classes.ts`; it never re-spells a
 * class name, slot order, or cooldown value — `classes.json` stays the single
 * source of truth.
 *
 * Schema discipline mirrors `src/schemas/autopilot-board.ts` (ADR-0011):
 * `.strict()` objects, `z.infer<>` for canonical types, a
 * `schema-validation-failed` error envelope at the route boundary.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/taxonomy/classes`. The endpoint takes no
 * parameters today; `.strict()` rejects unexpected query keys so a typo
 * surfaces as a 400 rather than being silently ignored, mirroring the
 * request-validation contract of the board-state endpoint.
 */
export const TaxonomyClassesQuerySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * One dispatch-class row, projected for HTTP consumers. A direct read-only
 * view of `DispatchClassRow` from `src/taxonomy/classes.ts` — the same columns
 * the typed module already validates at import time. Nullable columns are
 * always present (explicit `null`, never absent) so a consumer miss is loud.
 */
const TaxonomyClassRowSchema = z
  .object({
    /** The class name decide.py dispatches on, e.g. `dev_orch`. */
    name: z.string().min(1),
    /** `pipeline` = slot semantics (≤1 in flight); `signal` = cooldown-gated. */
    kind: z.enum(["pipeline", "signal"]),
    /** The Claude Code skill the class dispatches, e.g. `hydra-dev`. */
    skill: z.string().min(1),
    /** Cost-attribution bucket. */
    costClass: z.string().min(1),
    /** Which pattern-memory agent the class's lessons train (null = neither). */
    learningAgent: z.enum(["planner", "executor"]).nullable(),
    /** Signal classes: seconds (≥0). Pipeline slots: null (no class cooldown). */
    cooldownSeconds: z.number().int().nonnegative().nullable(),
    /** Which side of the system the class works on. */
    scope: z.enum(["orch", "target", "both"]),
    /** GitHub label the class's filing skill stamps; null = files nothing. */
    provenanceLabel: z.string().min(1).nullable(),
    /** Free-form design rationale. Optional. */
    notes: z.string().optional(),
  })
  .strict();

export type TaxonomyClassRow = z.infer<typeof TaxonomyClassRowSchema>;

/**
 * The dispatch-class alphabet, as served to dashboard clients. `classes` is the
 * full table in dispatch order (file order — pipeline rows first, then signal
 * rows). The three derived projections (`pipelineSlots`, `signalClasses`,
 * `signalCooldowns`) mirror decide.py's `PIPELINE_SLOTS` / `SIGNAL_CLASSES` /
 * `SIGNAL_COOLDOWNS` so the dashboard can substitute them 1:1 for its
 * hard-coded constants.
 */
export const TaxonomyClassesResponseSchema = z
  .object({
    /** Every dispatch class, in dispatch order. */
    classes: z.array(TaxonomyClassRowSchema),
    /** Pipeline-slot names, in slot order — mirrors decide.py `PIPELINE_SLOTS`. */
    pipelineSlots: z.array(z.string().min(1)),
    /** Signal-class names, in order — mirrors decide.py `SIGNAL_CLASSES`. */
    signalClasses: z.array(z.string().min(1)),
    /** Signal-class cooldowns (seconds) — mirrors decide.py `SIGNAL_COOLDOWNS`. */
    signalCooldowns: z.record(z.string(), z.number().int().nonnegative()),
    /**
     * `true` when the taxonomy could not be read and the body is the empty safe
     * default. The dashboard treats a degraded response as "fall back to the
     * last-known / built-in alphabet" so a transient outage never render-crashes
     * the habitat grid.
     */
    degraded: z.boolean(),
    /** ISO timestamp the projection was assembled. */
    generatedAt: z.string(),
  })
  .strict();

export type TaxonomyClassesResponse = z.infer<
  typeof TaxonomyClassesResponseSchema
>;
