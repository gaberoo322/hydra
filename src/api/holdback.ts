/**
 * Outcome Holdback producer API (issue #786, ADR-0004 step 4).
 *
 * The HTTP surface the hydra-qa **Post-merge Regression Check** calls. The
 * playbook is a shell script dispatched by the autopilot poll loop — it cannot
 * touch Redis directly (Redis-seam rule) — so it drives the in-process producer
 * (`src/holdback.ts`) over HTTP, the same dependency-free pattern the CI
 * scope-check gate uses to feed `POST /api/builder-health/scope-violation`.
 *
 *   - POST /holdback/enroll        — capture the pre-merge baseline of the
 *                                    leading outcomes for a just-merged commit.
 *   - POST /holdback/check         — sample the leading outcomes once and decide
 *                                    whether to revert. Emits the holdback.*
 *                                    events the digest consumes.
 *   - POST /holdback/revert-failed — emit holdback.revert_failed when the
 *                                    caller's git-revert / PR-open failed.
 *   - POST /holdback/pending       — register a PR the autopilot has armed for
 *                                    auto-merge but that has not yet landed
 *                                    (issue #2622). Idempotent on prNumber.
 *   - GET  /holdback/enrolments    — read-only list of enrol-state records
 *                                    (issue #4632), the failed-state source
 *                                    for the operator's "Enrol now" feed row.
 *
 * Holdback is read-only with respect to merge: these routes run strictly AFTER
 * a merge and never block one. The actual `git revert` + PR is performed by the
 * playbook caller on a `revert` decision — this service only persists the
 * baseline, enforces the per-day cap, and emits events.
 */

import { Router } from "express";
import {
  HoldbackEnrollBodySchema,
  HoldbackCheckBodySchema,
  HoldbackRevertFailedBodySchema,
  HoldbackPendingBodySchema,
  HoldbackEnrolmentsQuerySchema,
} from "../schemas/holdback.ts";
import {
  enrollHoldback,
  checkHoldback,
  reportRevertFailed,
  recordEnrolOutcome,
  recordEnrolAttemptFailure,
  type HoldbackEventBus,
} from "../holdback.ts";
import { classifyEnrolNoEnrollState, shouldRecordManualAttemptFailure } from "../holdback-policy.ts";
import {
  pendingEnrollAdd,
  getEnrolState,
  listEnrolStates,
  getMergeEventHealth,
  type PendingEnrollEntry,
} from "../redis/holdback-merge-watch.ts";
import { isolateAggregator, aggregatorRoute } from "./route-helpers.ts";
import { logger } from "../logger.ts";

export function createHoldbackRouter(eventBus: HoldbackEventBus) {
  const router = Router();

  // POST /holdback/enroll — snapshot the pre-merge baseline.
  router.post("/holdback/enroll", async (req, res) => {
    const parsed = HoldbackEnrollBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const commitSha = parsed.data.commitSha;
    const prNumber = parsed.data.prNumber ?? null;
    const tier = parsed.data.tier ?? null;
    const result = await enrollHoldback({
      commitSha,
      prNumber,
      tier,
      windowCycles: parsed.data.windowCycles,
    });
    if (result.ok === false) {
      // Issue #4632 INV-11: an attempt failure is recorded ONLY when an
      // enrol-state record already exists for this SHA — a manual call for an
      // arbitrary SHA the enrol-state substrate has never seen must never
      // invent a row. Best-effort; never affects the HTTP response.
      try {
        const existing = await getEnrolState(commitSha);
        if (existing.ok && shouldRecordManualAttemptFailure(existing.state)) {
          await recordEnrolAttemptFailure({ commitSha, prNumber, tier, source: "manual", reason: result.error });
        }
      } catch (err: any) {
        logger.error({ commitSha, err }, "[holdback] enroll: enrol-state attempt-failure write failed (non-fatal)");
      }
      return res.status(500).json({ error: result.error });
    }
    // Issue #4632 INV-11: upsert the enrol-state record on success so a prior
    // 'failed' row clears once an operator's "Enrol now" succeeds. Request/
    // response shape is unchanged; this is a side-effect only. Best-effort.
    try {
      const state = result.enrolled === true ? "enrolled" : classifyEnrolNoEnrollState(result.reason);
      await recordEnrolOutcome({
        commitSha,
        prNumber,
        tier,
        source: "manual",
        state,
        reason: result.enrolled === true ? undefined : result.reason,
      });
    } catch (err: any) {
      logger.error({ commitSha, err }, "[holdback] enroll: enrol-state outcome write failed (non-fatal)");
    }
    res.json(result);
  });

  // GET /holdback/enrolments — read-only list of enrol-state records (issue
  // #4632 INV-10), the failed-state source for the operator's "Enrol now" feed
  // row. Pure read, no writes; the #4630 list-envelope convention
  // (asserted-zero counts + generatedAt) — a Redis failure degrades to an
  // empty list rather than a 500, so this route always answers 200.
  router.get(
    "/holdback/enrolments",
    aggregatorRoute(HoldbackEnrolmentsQuerySchema, "api/holdback/enrolments", async (query) => {
      const [listed, scan] = await Promise.all([
        listEnrolStates({ state: query.state, limit: query.limit }),
        getMergeEventHealth(),
      ]);
      return {
        enrolments: listed.ok ? listed.states : [],
        scanned: scan?.scanned ?? 0,
        scan,
        generatedAt: new Date().toISOString(),
      };
    }),
  );

  // POST /holdback/check — evaluate one window sample, emit events.
  router.post("/holdback/check", async (req, res) => {
    const parsed = HoldbackCheckBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const result = await checkHoldback(eventBus, { commitSha: parsed.data.commitSha });
    if (result.ok === false) {
      return res.status(500).json({ error: result.error });
    }
    res.json({ ok: true, ...result.result });
  });

  // POST /holdback/revert-failed — emit holdback.revert_failed.
  router.post("/holdback/revert-failed", async (req, res) => {
    const parsed = HoldbackRevertFailedBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    // Issue #909 / ADR-0027 eighth sweep: the 500 envelope + pino `err`-field
    // log live in the isolateAggregator seam (route-helpers.ts) once.
    return isolateAggregator(res, "holdback/revert-failed", async () => {
      await reportRevertFailed(eventBus, parsed.data.commitSha, parsed.data.reason);
      return { ok: true };
    });
  });

  // POST /holdback/pending — register an armed-but-not-landed PR (issue #2622).
  // Idempotent on prNumber; records intent only (never arms/blocks/performs a
  // merge). No GET route — the #2623 watcher reads the registry in-process via
  // pendingEnrollList, not over HTTP.
  router.post("/holdback/pending", async (req, res) => {
    const parsed = HoldbackPendingBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const entry: PendingEnrollEntry = {
      prNumber: parsed.data.prNumber,
      tier: parsed.data.tier,
      cycleId: parsed.data.cycleId,
      registeredAt: Date.now(),
    };
    // Issue #2800: carry the explicit dispatch-class anchorType through to the
    // merge-watch enrichment so a first-write enrichment classifies explicitly
    // instead of bucketing to `unclassified`. Only set it when the arming caller
    // supplied one — omit it (leaving the field absent from the persisted JSON)
    // otherwise, so a legacy/omitting caller degrades to the prior behaviour.
    if (parsed.data.anchorType !== undefined) {
      entry.anchorType = parsed.data.anchorType;
    }
    const result = await pendingEnrollAdd(entry);
    if (result.ok === false) {
      return res.status(500).json({ error: result.error });
    }
    res.json({ ok: true, entry });
  });

  return router;
}
