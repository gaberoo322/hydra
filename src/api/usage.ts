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
  parseExhaustionBlock,
  getUsageByIssue,
  getWeightedQuotaTokensEstimate,
  getWeeklyResetAnchorMs,
  projectResetWindow,
} from "../cost/index.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import {
  getSessionBlockedUntil,
  setSessionBlockedUntil,
} from "../redis/session-block.ts";
import {
  getModelExhaustedUntil,
  setModelExhaustedUntil,
} from "../redis/model-exhaustion.ts";
import { getWorklessUntil } from "../redis/workless-hint.ts";
import { getEligibilityUsage } from "../cost/eligibility-usage.ts";
import { getEligibilityView } from "../aggregators/usage-eligibility.ts";
import { STREAMS } from "../event-bus-stream-keys.ts";
import type { PublishableBus } from "../event-bus-seams.ts";
import { booleanFlag } from "../schemas/common.ts";
import {
  recordDispatchCostJoin,
  isDispatchCostJoinWriteFailure,
  type DispatchCostJoinRecord,
} from "../redis/cost.ts";
import {
  DispatchCostJoinBodySchema,
  UsageByIssueQuerySchema,
} from "../schemas/usage.ts";
import { isolateAggregator } from "./route-helpers.ts";
import { logger } from "../logger.ts";

/**
 * Query schema for the `?force=1` cache-bust knob shared by both usage read
 * routes (ADR-0022). The common booleanFlag helper preserves the legacy
 * `force === "1" || force === "true"` semantics (and additionally accepts the
 * canonical `yes`/`on` truthy forms); absent => false.
 */
const ForceQuerySchema = z.object({ force: booleanFlag() });

/**
 * The model the model-scoped exhaustion flag (#4585) redirects OFF of while
 * live. Read from the SAME env var pace-gate.sh resolves its PRIMARY_MODEL
 * from (`HYDRA_AUTOPILOT_PRIMARY_MODEL`, default `fable`), so an operator
 * override of the launch-model pair stays in sync with the repeat-detection
 * check below (QA re-review hard-blocker fix on PR #4644) — a report naming
 * this model is never treated as a confirmed fallback death.
 */
const PRIMARY_MODEL_NAME = process.env.HYDRA_AUTOPILOT_PRIMARY_MODEL || "fable";

/**
 * The model the flag redirects ONTO while live. Read from the SAME env var
 * pace-gate.sh resolves its FALLBACK_MODEL from (`HYDRA_AUTOPILOT_FALLBACK_MODEL`,
 * default `opus`) — QA (PR #4644, 2026-09-24T09:49Z) found the `model-fallback`
 * bus event hardcoded the literal `"opus"`/`"fable"` strings, so an operator
 * override of the launch-model pair produced a correct launch but a
 * misreporting event/log line. Both model names used in the event payload
 * below MUST come from these two consts, never a literal.
 */
const FALLBACK_MODEL_NAME = process.env.HYDRA_AUTOPILOT_FALLBACK_MODEL || "opus";

/**
 * Body schema for `POST /api/usage/session-block` (issue #1089, widened by
 * #4583). The reap-on-exit backstop records an exhaustion hard block one of
 * three ways:
 *   - `{ line: "...You've hit your session limit · resets 4:40pm (...)" }` or
 *     `{ line: "You're out of usage credits. Switch to another model..." }`
 *     — the server classifies + parses the block instant via
 *     {@link parseExhaustionBlock} (keeps classification in TypeScript, where
 *     it is unit-tested, not in bash); OR
 *   - `{ blockedUntilMs: <epoch-ms> }` — a pre-parsed instant, optionally
 *     paired with `{ reason: "crash-streak" }` (issue #4583's message-agnostic
 *     backstop: N crash exits within a window with no recognised exhaustion
 *     line still arms a block). `reason` is only meaningful alongside
 *     `blockedUntilMs` — a `line`-driven block's `kind` is derived from the
 *     line itself.
 * At least one of `line` / `blockedUntilMs` must be present. The route ignores
 * a `line` that matches neither known exhaustion notice (returns
 * recorded:false) rather than erroring.
 *
 * `model` (QA re-review hard-blocker fix on PR #4644, issue #4585) — optional,
 * caller-reported name of the model that actually produced an `out-of-credits`
 * `line`. The reap-on-exit backstop resolves it from pace-gate.sh's last-tick
 * record (the model THIS run itself launched on). It exists solely to let the
 * out-of-credits repeat check tell "the fallback model died too" (a genuine
 * repeat) apart from "an independent, still-primary-model dispatch died while
 * the redirect flag happens to already be live" (a false positive — see the
 * repeat-branch comment below). Meaningless outside the out-of-credits `line`
 * path; an absent value is always treated conservatively (never a confirmed
 * repeat).
 */
const SessionBlockBodySchema = z
  .object({
    line: z.string().optional(),
    blockedUntilMs: z.number().finite().positive().optional(),
    reason: z.enum(["crash-streak"]).optional(),
    model: z.string().optional(),
  })
  .refine((b) => b.line !== undefined || b.blockedUntilMs !== undefined, {
    message: "one of `line` or `blockedUntilMs` is required",
  })
  .refine((b) => b.reason === undefined || b.blockedUntilMs !== undefined, {
    message: "`reason` is only valid alongside `blockedUntilMs`",
  });

export function createUsageRouter(eventBus?: PublishableBus | null) {
  const router = Router();

  // Best-effort bus publish — never throws into a route handler (same stance
  // as createAutopilotControlRouter's publishPauseEvent). The model-fallback
  // event (#4585 INV-7) is observability; the Redis flag write is the source
  // of truth, so an absent bus (tests construct the router bare) or a failed
  // publish degrades to a no-op, never a failed POST.
  async function publishModelFallbackEvent(payload: unknown): Promise<void> {
    if (!eventBus || typeof eventBus.publish !== "function") return;
    try {
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "model-fallback",
        source: "api/usage/session-block",
        payload,
      });
    } catch (err: any) {
      logger.error({ err }, "[usage] model-fallback event publish failed");
    }
  }

  router.get("/usage", async (req, res) => {
    const force = ForceQuerySchema.parse(req.query).force;
    return isolateAggregator(res, "api/usage", () => getUsage({ force }));
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
   * multi-source composition — the fail-safe overlay-input reads and the
   * `overlay*` chain — lives in `src/aggregators/usage-eligibility.ts`
   * as `getEligibilityView(deps)`. This route owns only the IO/wiring layer: it
   * reads the snapshot (OUTSIDE the fail-safe guards — a snapshot failure is a
   * genuine 500, not a degradable slice), builds the resolved deps bag from the
   * live Redis accessors, and formats the response.
   */
  router.get("/usage/eligibility", async (_req, res) =>
    // METER-ONLY (2026-07-30). This handler deliberately does NOT call
    // getUsage(): that runs the transcript scan, which grew to ~1.7 GB of
    // in-window JSONL and stopped answering inside the Pace Gate's 10s probe
    // budget, silently halting autopilot launches while /api/health stayed
    // green. Every field the verdict reads comes from the Anthropic OAuth
    // meter plus config — see src/cost/eligibility-usage.ts for the full
    // rationale, including why this is also the more ACCURATE source.
    //
    // `?force=1` is accepted and ignored here: it exists to bust the snapshot
    // scan cache, and there is no scan on this path. The meter has its own
    // independent TTL + backoff and must not be forced by an HTTP caller —
    // that is exactly how a rate-limited meter gets hammered.
    isolateAggregator(res, "api/usage/eligibility", async () => {
      const meter = await getEligibilityUsage();
      return getEligibilityView({
        snapshot: meter.input,
        // BLOCK when quota cannot be measured (2026-07-30 operator decision,
        // replacing the #1124 fail-open; hardened by issue #4165). True only
        // when there is NO fresh meter read AND no last-good reading inside
        // `HYDRA_ELIGIBILITY_LAST_GOOD_MAX_AGE_MS` (default 60 min). Transient
        // 429s are absorbed by last-good + the backoff gate well before this.
        //
        // #4165 removed the consecutive-failure threshold that used to also
        // gate this: a blind meter with fewer than 3 recorded failures reported
        // `false` alongside ZEROED percentages, and the governor admitted a run
        // at ~92% real weekly usage. A failure count is not evidence of
        // headroom. Do NOT reintroduce a fail-open default here by analogy with
        // `design-concept-reconcile-check` — that fail-open is correct for a
        // merge gate and inverted for a spend governor.
        meterUnavailable: meter.meterUnavailable,
        // Observability for the stale-but-usable case (#4165): the verdict is
        // gating on a REAL reading that is not fresh. Never flips `allow`.
        meterStale: meter.stale,
        meterAgeMs: meter.ageMs,
        readPaused: async () => (await getAutopilotPaused()).paused,
        readSessionBlockedUntil: () => getSessionBlockedUntil(),
        readWorklessUntil: () => getWorklessUntil(),
        // #4585: the model-scoped exhaustion flag — advisory only (the overlay
        // never flips `allow`), consumed by pace-gate's exec model choice and
        // the playbook's dispatch pre-resolution.
        readModelExhaustedUntil: () => getModelExhaustedUntil(),
        now: () => Date.now(),
      });
    }),
  );

  /**
   * POST /api/usage/session-block — record an exhaustion observation (#1089,
   * widened by #4583, narrowed by #4585).
   *
   * Called by the reap-on-exit backstop (`bootstrap.sh --reap`) when the
   * autopilot exited on a recognised exhaustion notice (`hit your session
   * limit`, `out of usage credits`) or on a message-agnostic crash-streak
   * (issue #4583). A `line` is classified server-side via
   * {@link parseExhaustionBlock}; a pre-parsed `blockedUntilMs` (optionally
   * tagged `reason: "crash-streak"`) is stored as-is.
   *
   * Where the observation LANDS depends on its kind (#4585 INV-3):
   *   - `session-limit` / `crash-streak` / pre-parsed → the session-block key
   *     (`setSessionBlockedUntil`), as before: while future, `.allow` is forced
   *     false and the launcher skips relaunch (#1089 semantics unchanged).
   *   - `out-of-credits` → the MODEL-SCOPED exhaustion flag
   *     (`setModelExhaustedUntil`, TTL = min(now + 60min, next Weekly Reset
   *     Anchor boundary)), surfaced as the ADVISORY `reasons.fableExhaustedUntil`
   *     — never `.allow`, never `sessionBlockedUntil`. The pace-gate launches
   *     on the fallback model while it is live, and a `model-fallback` event is
   *     published (best-effort).
   *   - `out-of-credits` **repeat** (hard-blocker fix, QA on PR #4644) → if
   *     `getModelExhaustedUntil()` is ALREADY live when this POST lands, the
   *     model this flag redirected onto has ALSO just run out of credits, so
   *     redirecting again would relaunch straight back into the same failure.
   *     This one instead falls through to the session-block key using the
   *     classifier's normally-discarded fixed 30-min instant
   *     (`CREDITS_EXHAUSTED_BLOCK_MS`) — the #4583 stop-the-relaunch behaviour
   *     — rather than re-arming the model flag. The model flag is left as-is
   *     (not cleared): once the session block itself expires, pace-gate reads
   *     the still-live model flag and correctly retries on the fallback, not
   *     back on the model that never worked this run.
   *
   * Idempotent-ish: a later/duplicate record simply refreshes the value. Never
   * throws — a classification miss returns `{ recorded: false, kind: null }`
   * (200), so a bad reap input can never abort the unit stop.
   */
  router.post("/usage/session-block", async (req, res) => {
    const parsed = SessionBlockBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const nowMs = Date.now();
    let blockedUntilMs: number | null = parsed.data.blockedUntilMs ?? null;
    let kind: "session-limit" | "out-of-credits" | "crash-streak" | null = null;
    if (blockedUntilMs !== null) {
      // Pre-parsed instant: the ONLY kind a pre-parsed instant can carry is
      // the caller-declared `reason` (today just crash-streak) — a line-driven
      // block's kind always comes from the line itself, never this branch.
      kind = parsed.data.reason === "crash-streak" ? "crash-streak" : null;
    } else if (parsed.data.line !== undefined) {
      const exhaustion = parseExhaustionBlock(parsed.data.line, nowMs);
      if (exhaustion !== null) {
        blockedUntilMs = exhaustion.blockedUntilMs;
        kind = exhaustion.kind;
      }
    }
    if (blockedUntilMs === null) {
      // Not a recognised exhaustion notice / unparseable time → nothing to record.
      return res.json({ recorded: false, blockedUntil: null, kind: null });
    }
    // Issue #4585 (INV-3): an out-of-credits line arms the MODEL-SCOPED
    // exhaustion flag, NOT a session block. Fable running out of weekly usage
    // kills only Fable — Opus/Sonnet/Haiku keep working — so stopping the
    // launch (what #4583's interim 30-min generic block did) idles the
    // autopilot instead of redirecting it. The flag TTL is computed HERE from
    // the Weekly Reset Anchor (INV-4: min(now + 60min, next boundary)), not
    // from #4583's 30-min block instant. The `blockedUntilMs` the classifier
    // produced for this kind is intentionally DISCARDED — UNLESS the repeat
    // branch just below reaches for it.
    if (kind === "out-of-credits") {
      const armNowMs = nowMs;
      // Hard-blocker fix (QA review on PR #4644, issue #4585): a repeat
      // out-of-credits exit while the model-exhaustion flag is ALREADY live
      // means the FALLBACK model (the one this flag redirected onto) also
      // just ran out of credits — e.g. an account-wide cap, or Opus getting
      // its own weekly limit. Simply re-arming the model flag again would
      // resend the parent onto the very model that just failed, reproducing
      // the unbounded relaunch storm #4583 fixed (bootstrap.sh's crash-streak
      // backstop can never reach this: `__reap_crash_streak_should_post` is
      // gated off whenever a recognised exhaustion line matched, INV-6 — it
      // only nets UNRECOGNISED strings). Falling through to the ORIGINAL
      // #4583 fixed-duration session block (`CREDITS_EXHAUSTED_BLOCK_MS`,
      // 30min — the very value this kind normally discards) actually stops
      // the launch loop instead of redirecting into another dead end.
      //
      // QA RE-REVIEW hard-blocker fix (PR #4644, issue #4585): the ORIGINAL
      // forward-fix above detected a "repeat" PURELY TEMPORALLY — whenever
      // the model flag was already live, regardless of WHICH model actually
      // produced this POST's `line`. That conflates two different situations:
      // the fallback dying again (a genuine repeat) vs. an ORDINARY BURST of
      // independent, still-primary-model dispatch failures arriving while the
      // redirect flag is already live (the normal concurrent-dispatch case —
      // the artifact's own qaTrace is a live reproduction of it), which armed
      // a session block and halted Opus launches too, violating INV-3 one
      // level up. `model` (added above) lets the caller name which model
      // actually died; only a report that explicitly names a model OTHER
      // than the primary is eligible for the repeat/session-block branch. An
      // absent `model` (an un-upgraded caller) or one naming the primary
      // model itself is treated conservatively — it falls through to the
      // re-arm branch below, which is a same-shape refresh of the redirect
      // that was already doing its job, never an escalation to a launch
      // block.
      const repeatBlockedUntilMs = blockedUntilMs;
      const reportedModel = parsed.data.model;
      const confirmedFallbackDeath =
        reportedModel !== undefined && reportedModel !== PRIMARY_MODEL_NAME;
      return isolateAggregator(res, "api/usage/session-block", async () => {
        const alreadyExhausted = await getModelExhaustedUntil(armNowMs);
        if (alreadyExhausted !== null && confirmedFallbackDeath) {
          const stored = await setSessionBlockedUntil(repeatBlockedUntilMs, armNowMs);
          const blockedUntilIso = stored !== null ? new Date(stored).toISOString() : null;
          logger.info(
            { routeLabel: "api/usage/session-block", kind: "out-of-credits", repeat: true, blockedUntil: blockedUntilIso },
            "[usage] out-of-credits repeat while the model-exhaustion flag was already live — arming a session block instead of re-arming the flag (#4585 hard-blocker fix)",
          );
          // Visibility (INV-7's spirit): this is a STOP, not a redirect, so
          // the event is best-effort exactly like the redirect case.
          await publishModelFallbackEvent({
            from: FALLBACK_MODEL_NAME,
            to: "session-block",
            reason: "out-of-credits-repeat",
            until: blockedUntilIso,
          });
          return {
            recorded: stored !== null,
            kind: "out-of-credits",
            blockedUntil: blockedUntilIso,
            blockedUntilMs: stored,
            // No model-flag change on this path — the session block is now
            // the thing stopping the launch loop.
            modelExhaustedUntil: null,
            modelExhaustedUntilMs: null,
          };
        }
        const anchorMs = getWeeklyResetAnchorMs();
        const nextResetMs =
          anchorMs !== null ? projectResetWindow(anchorMs, armNowMs).nextMs : null;
        const stored = await setModelExhaustedUntil(armNowMs, nextResetMs);
        const untilIso = new Date(stored).toISOString();
        logger.info(
          { routeLabel: "api/usage/session-block", kind: "out-of-credits", fableExhaustedUntil: untilIso },
          "[usage] model-exhaustion flag armed: model-fallback fable->opus reason=out-of-credits (#4585)",
        );
        // INV-7: the arming switch is visible on the bus. Best-effort — see
        // publishModelFallbackEvent.
        await publishModelFallbackEvent({
          from: PRIMARY_MODEL_NAME,
          to: FALLBACK_MODEL_NAME,
          reason: "out-of-credits",
          until: untilIso,
        });
        return {
          recorded: true,
          kind: "out-of-credits",
          // Deliberately null: this path arms NO launch block (INV-3).
          blockedUntil: null,
          blockedUntilMs: null,
          modelExhaustedUntil: untilIso,
          modelExhaustedUntilMs: stored,
        };
      });
    }
    // Captured into consts so the closure below keeps TS's null-narrowing
    // (a `let` is not narrowed across a nested-function boundary).
    const resolvedBlockedUntilMs = blockedUntilMs;
    const resolvedKind = kind;
    return isolateAggregator(res, "api/usage/session-block", async () => {
      const stored = await setSessionBlockedUntil(resolvedBlockedUntilMs, nowMs);
      if (stored === null) {
        return { recorded: false, blockedUntil: null, kind: null };
      }
      const blockedUntilIso = new Date(stored).toISOString();
      logger.info(
        { routeLabel: "api/usage/session-block", kind: resolvedKind, blockedUntil: blockedUntilIso },
        "[usage] session-block recorded",
      );
      return {
        recorded: true,
        blockedUntil: blockedUntilIso,
        blockedUntilMs: stored,
        kind: resolvedKind,
      };
    });
  });

  /**
   * POST /api/usage/dispatch-cost — record one dispatch -> issue cost-join
   * row (issue #4126, ADR-0032 epic #4123 slice gamma — the prerequisite for
   * the A/B primary endpoint). THE writer is `scripts/autopilot/reap.py`'s
   * `run_completion`, which POSTs here once per completed dispatch alongside
   * its existing `_fire_token_record` per-cycle write, for EVERY completed
   * class (not just code-writing) — including a GLM-arm issue's later
   * `qa_orch` / `sweep_orch` completions, so that issue's real Anthropic-side
   * QA/sweep cost lands here even though its own coding dispatch never does
   * (that dispatch ran on the GLM drainer, outside reap.py entirely).
   *
   * `reapedAt` is stamped here (server clock), not accepted from the body —
   * see `DispatchCostJoinBodySchema`'s docstring. Never blocks a completion:
   * reap swallows any non-2xx / network error the same way it already does
   * for `/api/metrics/tokens`.
   */
  // Not an isolateAggregator route: both the write-failure branch and the
  // catch return the specialized { recorded: false, error } envelope, not
  // the seam's { error } shape.
  router.post("/usage/dispatch-cost", async (req, res) => {
    const parsed = DispatchCostJoinBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    try {
      const skill = parsed.data.skill ?? null;
      // Issue #4126 INV-2: split the raw dispatch tokens across model
      // families using `skill`'s 7-day bySkillByModel mix (from the
      // already-memoized getUsage() snapshot) and apply the calibrated
      // per-family Quota-Weight — degrades to the raw identity when
      // uncalibrated or the skill has no mix yet.
      const { weightedQuotaTokensEstimate, quotaWeightCalibrated } = await getWeightedQuotaTokensEstimate(
        parsed.data.dispatchTokensEstimate,
        skill,
      );
      const record: DispatchCostJoinRecord = {
        issue: parsed.data.issue,
        class: parsed.data.class,
        dispatchKind: parsed.data.dispatchKind,
        dispatchTokensEstimate: parsed.data.dispatchTokensEstimate,
        skill,
        weightedQuotaTokensEstimate,
        quotaWeightCalibrated,
        reapedAt: new Date().toISOString(),
      };
      const result = await recordDispatchCostJoin(record);
      if (isDispatchCostJoinWriteFailure(result)) {
        logger.error(
          { routeLabel: "api/usage/dispatch-cost", err: result.error },
          "[usage] dispatch-cost record failed",
        );
        return res.status(500).json({ recorded: false, error: result.error });
      }
      return res.json({ recorded: true, attributed: result.attributed });
    } catch (err: any) {
      logger.error({ routeLabel: "api/usage/dispatch-cost", err }, "[usage] dispatch-cost failed");
      return res.status(500).json({ recorded: false, error: err?.message || String(err) });
    }
  });

  /**
   * GET /api/usage/by-issue — per-issue attributed dispatch cost (issue
   * #4126). The read surface #4123's A/B primary endpoint is blocked on:
   * without `?issue=`, returns every attributed issue's rollup PLUS the
   * unattributable residual and its `attributedPercent` — never a silent
   * drop, mirroring the `attributedPercent` convention `/api/usage` already
   * established at the skill level (~90% attributed there). With
   * `?issue=N`, narrows `byIssue` to just that issue while the residual /
   * `attributedPercent` stay computed over the WHOLE ledger (a GLM-arm
   * issue's own residual visibility must not depend on which issue the
   * caller happened to query).
   */
  router.get("/usage/by-issue", async (req, res) => {
    const parsed = UsageByIssueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    return isolateAggregator(res, "api/usage/by-issue", () => getUsageByIssue(parsed.data.issue));
  });

  return router;
}
