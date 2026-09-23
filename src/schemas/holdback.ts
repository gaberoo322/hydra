/**
 * Boundary schemas for the Outcome Holdback producer surface (issue #786).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / issue #562): each
 * schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape.
 *
 * Six boundaries (called by the hydra-qa post-merge path / autopilot / the
 * merge-event-enrol chore):
 *   - POST /api/holdback/enroll        — `HoldbackEnrollBodySchema`
 *   - POST /api/holdback/check         — `HoldbackCheckBodySchema`
 *   - POST /api/holdback/revert-failed — `HoldbackRevertFailedBodySchema`
 *   - POST /api/holdback/pending       — `HoldbackPendingBodySchema` (issue #2622)
 *   - GET  /api/holdback/enrolments    — `HoldbackEnrolmentsQuerySchema` (issue #4632)
 *   - (storage) enrol-state record     — `HoldbackEnrolStateSchema` (issue #4632)
 */
import { z } from "zod";

const commitSha = z
  .string()
  .min(7, { message: "commitSha must be at least 7 chars" })
  .max(64, { message: "commitSha must be <= 64 chars" });

/** Body for POST /api/holdback/enroll — snapshot the pre-merge baseline. */
export const HoldbackEnrollBodySchema = z
  .object({
    commitSha,
    prNumber: z.number().int().positive().nullable().optional(),
    tier: z.number().int().min(1).max(4).nullable().optional(),
    windowCycles: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Body for POST /api/holdback/check — evaluate one window sample. */
export const HoldbackCheckBodySchema = z
  .object({
    commitSha,
  })
  .strict();

/** Body for POST /api/holdback/revert-failed — emit holdback.revert_failed. */
export const HoldbackRevertFailedBodySchema = z
  .object({
    commitSha,
    reason: z.string().max(2000).optional(),
  })
  .strict();

/**
 * Body for POST /api/holdback/pending (issue #2622) — register a PR the
 * autopilot has armed for auto-merge but that has not yet landed.
 *
 * `prNumber` keys the entry (idempotent upsert) and `cycleId` audits which
 * autopilot cycle armed it — both required. `tier` is nullable to mirror the
 * enroll schema: registration is permissive (records what was armed); the
 * tier-enrollment filter is a landing-time concern for the #2623 watcher.
 *
 * `anchorType` (issue #2800) is the explicit dispatch-class anchorType
 * (`work-queue` / `qa-review` / ...) the arming caller knows. The #2623
 * merge-watch chore forwards it on its landing-time cycle-record enrichment so
 * that, when reap never wrote a cycle-record for this cycleId (the qa_orch relay
 * case), the enrichment is the FIRST write yet still carries an explicit
 * anchorType — instead of the bare-UUID cycleId falling through the slot-suffix
 * inference to the `unclassified` sentinel (the 32%-unclassified data-quality
 * gap). Optional: an arming caller that omits it degrades to the prior behaviour
 * (inference, then `unclassified`).
 */
export const HoldbackPendingBodySchema = z
  .object({
    prNumber: z.number().int().positive(),
    tier: z.number().int().min(1).max(4).nullable(),
    cycleId: z.string().min(1).max(200),
    anchorType: z.string().min(1).max(200).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Enrol-state record (issue #4632, ADR-0034 §8/§9)
// ---------------------------------------------------------------------------

/**
 * The five terminal/in-flight states an enrol-state record can carry (issue
 * #4632 INV-5). Only `'failed'` is the operator-visible breakage signal
 * (ADR-0034 §8.1 "not a bucket") — the other four are healthy outcomes.
 */
export const HOLDBACK_ENROL_STATES = [
  "enrolled",
  "exempt",
  "no-signal",
  "retrying",
  "failed",
] as const;

/**
 * Who wrote this enrol-state record: `'registry'` (holdback-merge-watch.ts,
 * a PR armed via the pending-enroll registry), `'merge-event'` (the new
 * merge-event-enrol chore, for an unregistered merge), `'manual'` (an operator
 * "Enrol now" via `POST /holdback/enroll`), or `'backfill'` (the merge-event
 * chore found a pre-existing holdback baseline for the SHA and recorded the
 * fact without re-enrolling — issue #4632 INV-2c).
 */
export const HOLDBACK_ENROL_SOURCES = ["registry", "merge-event", "manual", "backfill"] as const;

/**
 * One per-merge-commit enrol-state record (issue #4632 INV-5). Stored as a
 * single JSON value per SHA behind `src/redis/holdback-merge-watch.ts`'s
 * `hydra:holdback:enrol-state:<sha>` key (30d TTL) plus a `mergedAt`-scored
 * ZSET index for newest-first listing. Written by the merge-event-enrol chore,
 * by `holdback-merge-watch.ts` for its own tier-known landings, and by
 * `POST /holdback/enroll` on a manual "Enrol now". Read by
 * `GET /holdback/enrolments`. The reader `safeParse`s every stored row and
 * skips+logs an unparseable one rather than failing the whole list (the same
 * posture as the pending-enroll registry's malformed-field skip).
 *
 * `prNumber`/`tier` are nullable to mirror the `HoldbackEnrollBodySchema` /
 * `HoldbackPendingBodySchema` nullable semantics — a manual enrol call may
 * omit either.
 */
export const HoldbackEnrolStateSchema = z
  .object({
    commitSha,
    prNumber: z.number().int().positive().nullable(),
    tier: z.number().int().min(1).max(4).nullable(),
    source: z.enum(HOLDBACK_ENROL_SOURCES),
    state: z.enum(HOLDBACK_ENROL_STATES),
    /** Why `enrolled:false` / the last attempt-failure's error, when applicable. */
    reason: z.string().max(2000).optional(),
    /** Automatic-attempt count; reset to 0 on a terminal non-`'retrying'` write. */
    attempts: z.number().int().min(0),
    /** ISO timestamp the PR merged, when known (drives the ZSET index score). */
    mergedAt: z.string().optional(),
    /** ISO timestamp this SHA was first observed by any writer. */
    firstSeenAt: z.string(),
    /** ISO timestamp of this write. */
    updatedAt: z.string(),
  })
  .strict();

export type HoldbackEnrolState = z.infer<typeof HoldbackEnrolStateSchema>;

/** Query for `GET /api/holdback/enrolments` (issue #4632 INV-10). */
export const HoldbackEnrolmentsQuerySchema = z
  .object({
    state: z.enum(HOLDBACK_ENROL_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type HoldbackEnrolmentsQuery = z.infer<typeof HoldbackEnrolmentsQuerySchema>;
