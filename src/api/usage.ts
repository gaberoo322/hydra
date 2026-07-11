/**
 * Usage HTTP routes — thin adapter over `src/cost/usage-tracker.ts`.
 *
 * The Subscription Usage Tracker projection — token counts, calibrated
 * percentages, pacing verdict, emergency-stop flag. The actual scanning
 * + math lives in the tracker module; this route just translates the
 * snapshot to JSON and surfaces a `?force=1` cache-bust knob for the
 * dashboard to invalidate the 60s in-process memoize.
 *
 * Future PR wires `emergencyStop` / `pacingState` into the autopilot
 * tick. PR A ships the read-only endpoint so the operator can compare
 * the tracker's numbers against `/usage` and calibrate the env vars
 * before any dispatch behavior changes.
 */

import { Router } from "express";
import { z } from "zod";
import {
  getUsage,
  parseSessionLimitReset,
} from "../cost/index.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import {
  getSessionBlockedUntil,
  setSessionBlockedUntil,
} from "../redis/session-block.ts";
import { getWorklessUntil } from "../redis/workless-hint.ts";
import { getEligibilityView } from "../aggregators/usage-eligibility.ts";
import { booleanFlag } from "../schemas/common.ts";

/**
 * Query schema for the `?force=1` cache-bust knob shared by both usage read
 * routes (ADR-0022). The common booleanFlag helper preserves the legacy
 * `force === "1" || force === "true"` semantics (and additionally accepts the
 * canonical `yes`/`on` truthy forms); absent => false.
 */
const ForceQuerySchema = z.object({ force: booleanFlag() });

/**
 * Body schema for `POST /api/usage/session-block` (issue #1089). The reap-on-
 * exit backstop records a session-limit hard block one of two ways:
 *   - `{ line: "...You've hit your session limit · resets 4:40pm (...)" }`
 *     — the server parses the reset (keeps the brittle wall-clock→instant
 *     resolution in TypeScript where it is unit-tested, not in bash); OR
 *   - `{ blockedUntilMs: <epoch-ms> }` — a pre-parsed instant.
 * At least one must be present. The route ignores a `line` that is not a
 * session-limit notice (returns recorded:false) rather than erroring.
 */
const SessionBlockBodySchema = z
  .object({
    line: z.string().optional(),
    blockedUntilMs: z.number().finite().positive().optional(),
  })
  .refine((b) => b.line !== undefined || b.blockedUntilMs !== undefined, {
    message: "one of `line` or `blockedUntilMs` is required",
  });

export function createUsageRouter() {
  const router = Router();

  router.get("/usage", async (req, res) => {
    const force = ForceQuerySchema.parse(req.query).force;
    try {
      const snapshot = await getUsage({ force });
      return res.json(snapshot);
    } catch (err: any) {
      console.error(`[usage] /api/usage failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  /**
   * GET /api/usage/eligibility — autopilot dispatch verdict.
   *
   * Consumed by `scripts/autopilot/collect-state.sh` once per turn; the
   * playbook merges the response under `state.usage_eligibility` so
   * `decide.py` can gate dispatches without re-fetching. `?force=1`
   * bypasses the 60s tracker cache for the underlying snapshot.
   *
   * Issue #988: the operator-only **Autopilot pause** flag is overlaid here,
   * at the route seam. `projectEligibility` stays a pure function of the
   * snapshot; the Redis pause read happens in this caller and is folded onto
   * the verdict via `overlayPauseEligibility` (paused => allow=false +
   * reasons.paused=true). Both readers consume this single projection: the
   * launcher (`pace-gate.sh` reads `.reasons.paused`) and the brain (decide.py
   * rides the `allow=false` drain path). The pause read fails SAFE — a Redis
   * error degrades to not-paused so it can never wedge the loop off.
   *
   * Issue #1089: the session-limit hard block is overlaid the same way. The
   * recorded block-until instant (`hydra:autopilot:session-blocked-until`) is
   * read here and folded onto the verdict via `overlaySessionBlockEligibility`
   * — while it is a FUTURE instant, `allow=false` and
   * `reasons.sessionBlockedUntil` carries the ISO reset time, so the launcher
   * skips relaunch into the exhausted quota (the OAuth 5h `emergencyStop`
   * undershoots the true session limit). Fails SAFE to no-block on a read
   * error, and the block self-clears (TTL + past-instant read guard) once the
   * reset passes, so admission resumes automatically.
   *
   * Issue #2956: the workless-board backoff hint is overlaid last, the same way
   * — but UNLIKE the two above it does NOT flip `allow`. Stamped by endRun when
   * a run terminates cause=idle having dispatched nothing, it surfaces under
   * `reasons.worklessUntil` and is consumed ONLY by the launcher (pace-gate.sh
   * skips relaunch while future) — decide.py never drains on it. Fails SAFE to
   * not-workless and self-clears by TTL, so a stale hint can never wedge the
   * launcher off.
   *
   * This handler is now a THIN ADAPTER (issue #3182, arch-scan #788). The pure
   * multi-source composition — the three fail-safe overlay-input reads and the
   * four-level `overlay*` chain — lives in `src/aggregators/usage-eligibility.ts`
   * as `getEligibilityView(deps)`. This route owns only the IO/wiring layer: it
   * reads the snapshot (OUTSIDE the fail-safe guards — a snapshot failure is a
   * genuine 500, not a degradable slice), builds the resolved deps bag from the
   * live Redis accessors, and formats the response.
   */
  router.get("/usage/eligibility", async (req, res) => {
    const force = ForceQuerySchema.parse(req.query).force;
    try {
      const snapshot = await getUsage({ force });
      const eligibility = await getEligibilityView({
        snapshot,
        readPaused: async () => (await getAutopilotPaused()).paused,
        readSessionBlockedUntil: () => getSessionBlockedUntil(),
        readWorklessUntil: () => getWorklessUntil(),
        now: () => Date.now(),
      });
      return res.json(eligibility);
    } catch (err: any) {
      console.error(`[usage] /api/usage/eligibility failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  /**
   * POST /api/usage/session-block — record a session-limit hard block (#1089).
   *
   * Called by the reap-on-exit backstop (`bootstrap.sh --reap`) when the
   * autopilot exited with `You've hit your session limit · resets <t>`. Accepts
   * either the raw exit `line` (parsed server-side) or a pre-parsed
   * `blockedUntilMs`. Records the instant in Redis with a self-expiring TTL so
   * the launcher skips relaunch until the quota resets. Idempotent-ish: a
   * later/duplicate record simply refreshes the value. Never throws — a parse
   * miss or non-future instant returns `{ recorded: false }` (200), so a bad
   * reap input can never abort the unit stop.
   */
  router.post("/usage/session-block", async (req, res) => {
    const parsed = SessionBlockBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const nowMs = Date.now();
    let blockedUntilMs = parsed.data.blockedUntilMs ?? null;
    if (blockedUntilMs === null && parsed.data.line !== undefined) {
      blockedUntilMs = parseSessionLimitReset(parsed.data.line, nowMs);
    }
    if (blockedUntilMs === null) {
      // Not a session-limit notice / unparseable time → nothing to record.
      return res.json({ recorded: false, blockedUntil: null });
    }
    try {
      const stored = await setSessionBlockedUntil(blockedUntilMs, nowMs);
      if (stored === null) {
        return res.json({ recorded: false, blockedUntil: null });
      }
      return res.json({
        recorded: true,
        blockedUntil: new Date(stored).toISOString(),
        blockedUntilMs: stored,
      });
    } catch (err: any) {
      console.error(`[usage] /api/usage/session-block record failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
