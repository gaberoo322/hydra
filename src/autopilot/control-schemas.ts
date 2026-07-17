/**
 * Operator-control-flag POST body schemas — the stable, operator-only toggle
 * surface for the autopilot control router (`src/api/autopilot-control.ts`).
 *
 * Split out of `src/autopilot/schemas.ts` (issue #3410): that file co-located
 * two orthogonal schema families with different consumers, strictness modes,
 * and volatility axes. The *lifecycle write schemas* there are loose objects on
 * a volatile dispatch protocol (they grow with every dispatch evolution); these
 * *control schemas* are strict objects on a stable toggle surface consumed only
 * by `autopilot-control.ts`. Co-locating each family with its sole consumer's
 * domain keeps the volatile lifecycle protocol and the stable control-flag
 * definitions in separate diffs.
 *
 * These are NEW-endpoint schemas, so they follow `src/schemas/queue.ts`'s
 * strict pattern: an unknown field is a caller bug we want surfaced, not
 * silently ignored (the opposite of the loose lifecycle schemas' by-design
 * unknown-field tolerance).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Emergency brake — POST /api/autopilot/emergency-brake (issue #744)
// ---------------------------------------------------------------------------

/**
 * Operator-only emergency-brake toggle body. NEW endpoint, so strict
 * (per the "For NEW endpoints, follow queue.ts's strict pattern" note):
 * an unknown field is a caller bug we want surfaced, not silently ignored.
 *
 *   engaged: true  => pull the brake (pause all auto-merge, route open PRs to
 *                     /hydra-review).
 *   engaged: false => release the brake (resume ADR-0015 depth-gated merge).
 *
 * `engagedBy` is an optional operator-attribution string recorded for the
 * incident audit trail (defaults server-side to "operator").
 */
export const EmergencyBrakeBodySchema = z
  .strictObject({
    engaged: z.boolean({ message: "engaged must be a boolean" }),
    engagedBy: z.string().trim().min(1).optional(),
  });

// ---------------------------------------------------------------------------
// Autopilot pause — POST /api/autopilot/paused (issue #988)
// ---------------------------------------------------------------------------

/**
 * Operator-only autopilot-pause toggle body. NEW endpoint, so strict (per the
 * "For NEW endpoints, follow queue.ts's strict pattern" note): an unknown field
 * is a caller bug we want surfaced, not silently ignored.
 *
 *   paused: true  => pause autopilot (launcher skips, brain drains — no new
 *                    dispatches; in-flight subagents are untouched).
 *   paused: false => resume autopilot.
 *
 * No attribution field (unlike the emergency-brake's `engagedBy`): the pause
 * blob is `{paused, since}` only, by design (issue #988).
 */
export const AutopilotPauseBodySchema = z
  .strictObject({
    paused: z.boolean({ message: "paused must be a boolean" }),
  });
