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
 *   - GET  /holdback/merge-event-enrol       — list every merge-event-enrol
 *                                    outcome (issue #4632, ADR-0034 §8.1) —
 *                                    the read-only `/work` surface.
 *   - POST /holdback/merge-event-enrol/retry — confirm-first "Enrol now"
 *                                    manual retry of a recorded FAILURE.
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
  HoldbackMergeEventEnrolRetryBodySchema,
} from "../schemas/holdback.ts";
import { enrollHoldback, checkHoldback, reportRevertFailed, type HoldbackEventBus } from "../holdback.ts";
import {
  pendingEnrollAdd,
  type PendingEnrollEntry,
  markEnrolled,
  getMergeEventEnrolRecord,
  listMergeEventEnrolRecords,
  recordMergeEventEnrolResult,
} from "../redis/holdback-merge-watch.ts";
import { isolateAggregator } from "./route-helpers.ts";

export function createHoldbackRouter(eventBus: HoldbackEventBus) {
  const router = Router();

  // POST /holdback/enroll — snapshot the pre-merge baseline.
  router.post("/holdback/enroll", async (req, res) => {
    const parsed = HoldbackEnrollBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const result = await enrollHoldback({
      commitSha: parsed.data.commitSha,
      prNumber: parsed.data.prNumber ?? null,
      tier: parsed.data.tier ?? null,
      windowCycles: parsed.data.windowCycles,
    });
    if (result.ok === false) {
      return res.status(500).json({ error: result.error });
    }
    res.json(result);
  });

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

  // GET /holdback/merge-event-enrol — list every merge-event-enrol outcome
  // (issue #4632, ADR-0034 §8.1). Read-only: the `holdback-merge-event-enrol`
  // housekeeping chore is the sole writer. Serves the "record enrol state so
  // /work can show it read-only" half of the issue, and is the "queryable"
  // half of the acceptance criterion for a failed enrolment — a caller filters
  // on `status === "failed"` for the breakage-feed view.
  router.get("/holdback/merge-event-enrol", async (_req, res) => {
    return isolateAggregator(res, "holdback/merge-event-enrol", async () => {
      const result = await listMergeEventEnrolRecords();
      if (result.ok === false) {
        throw new Error(result.error);
      }
      return { records: result.records };
    });
  });

  // POST /holdback/merge-event-enrol/retry — confirm-first "Enrol now" manual
  // retry of a PR the chore already recorded a FAILED enrolment for (issue
  // #4632, ADR-0034 §8.1/§8.3). The chore itself never auto-retries a
  // recorded failure, so this route is the ONLY path back to `enrolled`. The
  // server re-reads the prior failure record for the commit SHA + tier —
  // never trusting anything the caller supplies about the merge itself.
  router.post("/holdback/merge-event-enrol/retry", async (req, res) => {
    const parsed = HoldbackMergeEventEnrolRetryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }
    const { prNumber } = parsed.data;
    const existing = await getMergeEventEnrolRecord(prNumber);
    if (existing == null) {
      return res.status(404).json({ error: `no merge-event-enrol record for PR ${prNumber}` });
    }
    if (existing.status !== "failed") {
      return res
        .status(409)
        .json({ error: `PR ${prNumber} is not in a failed state (status: ${existing.status})` });
    }

    const enrollRes = await enrollHoldback({
      commitSha: existing.commitSha,
      prNumber,
      tier: existing.tier,
    });
    if (enrollRes.ok === false) {
      await recordMergeEventEnrolResult({
        prNumber,
        commitSha: existing.commitSha,
        tier: existing.tier,
        status: "failed",
        error: enrollRes.error,
        recordedAt: Date.now(),
      });
      return res.status(500).json({ error: enrollRes.error });
    }

    await markEnrolled(prNumber, existing.commitSha);
    await recordMergeEventEnrolResult({
      prNumber,
      commitSha: existing.commitSha,
      tier: existing.tier,
      status: "enrolled",
      recordedAt: Date.now(),
    });
    res.json({ ok: true, prNumber });
  });

  return router;
}
