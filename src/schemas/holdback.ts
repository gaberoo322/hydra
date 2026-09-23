/**
 * Boundary schemas for the Outcome Holdback producer surface (issue #786).
 *
 * Follows the `src/schemas/` zod convention (CLAUDE.md / issue #562): each
 * schema is both the runtime parser and the inferred TypeScript type, and a
 * `safeParse()` failure returns HTTP 400 with the structured
 * `{ code: "schema-validation-failed", issues }` shape.
 *
 * Five boundaries (all POST, called by the hydra-qa post-merge path / autopilot):
 *   - POST /api/holdback/enroll        — `HoldbackEnrollBodySchema`
 *   - POST /api/holdback/check         — `HoldbackCheckBodySchema`
 *   - POST /api/holdback/revert-failed — `HoldbackRevertFailedBodySchema`
 *   - POST /api/holdback/pending       — `HoldbackPendingBodySchema` (issue #2622)
 *   - POST /api/holdback/merge-event-enrol/retry — `HoldbackMergeEventEnrolRetryBodySchema`
 *     (issue #4632) — the confirm-first "Enrol now" manual retry of a
 *     recorded merge-event-enrol FAILURE (ADR-0034 §8.1/§8.3).
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

/**
 * Body for POST /api/holdback/merge-event-enrol/retry (issue #4632, ADR-0034
 * §8.1/§8.3) — the confirm-first "Enrol now" manual retry of a PR the
 * `holdback-merge-event-enrol` chore already recorded a FAILED enrolment
 * attempt for. `prNumber` is the sole input: the server re-reads the prior
 * failure record (commit SHA, tier) rather than trusting anything the caller
 * supplies about the merge itself — a confirm-first control only confirms
 * *that* retry should happen, never *what* to enrol.
 */
export const HoldbackMergeEventEnrolRetryBodySchema = z
  .object({
    prNumber: z.number().int().positive(),
  })
  .strict();
