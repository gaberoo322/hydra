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
} from "../schemas/holdback.ts";
import { enrollHoldback, checkHoldback, reportRevertFailed, type HoldbackEventBus } from "../holdback.ts";

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
    try {
      await reportRevertFailed(eventBus, parsed.data.commitSha, parsed.data.reason);
      res.json({ ok: true });
    } catch (err: any) {
      console.error(`[holdback-api] revert-failed emit failed: ${err?.message || String(err)}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
