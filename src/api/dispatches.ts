/**
 * Dispatch-registry sub-router (issue #692, PRD #690).
 *
 * Exposes the write surface the SessionStart hook
 * (`scripts/hooks/session-start-capture.sh`) calls to register an
 * Agent-tool subagent session into the subagent-dispatch registry:
 *
 *   POST  /api/dispatches/subagent
 *   PATCH /api/dispatches/subagent/:sessionId/current-step
 *
 * Both bodies parse through `src/schemas/dispatches.ts` (ADR-0011 Schemas
 * seam). On parse failure they return HTTP 400
 * `{ code: "schema-validation-failed", issues }` so the hook (and any other
 * caller) can pattern-match on a stable error shape.
 *
 * Per CLAUDE.md: this file is a thin route factory; all Redis access goes
 * through the typed `src/redis/dispatches.ts` accessor (ADR-0009).
 */
import { Router } from "express";
import {
  registerSubagentDispatch,
  setSubagentDispatchStep,
  getSubagentDispatch,
  type SubagentDispatch,
} from "../redis/dispatches.ts";
import {
  SubagentDispatchPostBodySchema,
  SubagentDispatchStepPatchBodySchema,
} from "../schemas/dispatches.ts";

export function createDispatchesRouter() {
  const router = Router();

  // POST /dispatches/subagent — register a subagent session.
  router.post("/dispatches/subagent", async (req, res) => {
    try {
      const parsed = SubagentDispatchPostBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }
      const body = parsed.data;

      // startedAt is optional on the wire — stamp capture time when omitted so
      // the index score is always meaningful.
      const startedAt = body.startedAt || new Date().toISOString();
      const dispatch: SubagentDispatch = {
        sessionId: body.sessionId,
        skill: body.skill,
        dispatchId: body.dispatchId,
        startedAt,
      };
      if (body.runId !== undefined) dispatch.runId = body.runId;
      if (body.projectDir !== undefined) dispatch.projectDir = body.projectDir;
      if (body.currentStep !== undefined) dispatch.currentStep = body.currentStep;
      if (body.issueRef !== undefined) dispatch.issueRef = body.issueRef;
      if (body.prRef !== undefined) dispatch.prRef = body.prRef;

      await registerSubagentDispatch(dispatch);
      res.json({ registered: true, dispatch });
    } catch (err: any) {
      console.error("[api/dispatches] POST /dispatches/subagent failed:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /dispatches/subagent/:sessionId/current-step — update the step.
  router.patch("/dispatches/subagent/:sessionId/current-step", async (req, res) => {
    try {
      const sessionId = (req.params.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: [{ path: ["sessionId"], message: "sessionId path param is required" }],
        });
      }
      const parsed = SubagentDispatchStepPatchBodySchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsed.error.issues,
        });
      }

      await setSubagentDispatchStep(sessionId, parsed.data.currentStep);
      const updated = await getSubagentDispatch(sessionId);
      res.json({ updated: true, dispatch: updated });
    } catch (err: any) {
      console.error(
        "[api/dispatches] PATCH /dispatches/subagent/:sessionId/current-step failed:",
        err,
      );
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
