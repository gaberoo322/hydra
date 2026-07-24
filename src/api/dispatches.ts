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
 * Plus the operator-facing transcript read surface (issue #695, PRD #690):
 *
 *   GET   /api/dispatches/:dispatchId/transcript?offset=0&limit=200
 *
 * Both write bodies parse through `src/schemas/dispatches.ts` (ADR-0011
 * Schemas seam). On parse failure they return HTTP 400
 * `{ code: "schema-validation-failed", issues }` so the hook (and any other
 * caller) can pattern-match on a stable error shape.
 *
 * Per CLAUDE.md: this file is a thin route factory; all Redis access goes
 * through the typed `src/redis/dispatches.ts` accessor (ADR-0009). The
 * transcript read additionally touches the filesystem — the harness writes
 * each session's conversation to a line-delimited JSONL under
 * `~/.claude/projects`. That read is on-demand and READ-ONLY (grounding.ts
 * discipline): the route never mutates anything, and the resolved path is
 * confined to `~/.claude/projects` so a client-supplied dispatchId can't
 * traverse out of the transcript root.
 */
import { Router } from "express";
import { promises as fs } from "node:fs";
import {
  registerSubagentDispatch,
  setSubagentDispatchStep,
  getSubagentDispatch,
  type SubagentDispatch,
} from "../redis/dispatches.ts";
import {
  SubagentDispatchPostBodySchema,
  SubagentDispatchStepPatchBodySchema,
  TranscriptQuerySchema,
} from "../schemas/dispatches.ts";
import { resolveTranscriptPath } from "../transcript-store.ts";
import { parseTranscript, paginate } from "../transcript-projection.ts";
import { logger } from "../logger.ts";
import { isolateAggregator } from "./route-helpers.ts";

// ===========================================================================
// Transcript reading (issue #695).
//
// Two boundary Seams own the substance; this router is a thin caller of both:
//   - **Transcript Store** (`src/transcript-store.ts`, issue #951) owns layout
//     / IO: the `~/.claude/projects` root, the
//     `<encoded-projectDir>/<sessionId>.jsonl` layout, the path-traversal
//     confinement guard, and the session-id → path resolution.
//   - **Transcript Projection** (`src/transcript-projection.ts`, issue #987)
//     owns schema-knowledge: turning raw JSONL lines into the flattened
//     message list (`parseTranscript` / `projectMessage` / `paginate`).
//
// The GET handler reads: resolve path (Store) → read file → parseTranscript →
// paginate → respond. No projection or layout logic lives in this file.
// ===========================================================================

/** Metadata block echoed on every transcript response (known or not-available). */
export function sessionMetadataFrom(dispatch: SubagentDispatch) {
  return {
    skill: dispatch.skill,
    dispatchId: dispatch.dispatchId,
    runId: dispatch.runId ?? null,
    startedAt: dispatch.startedAt,
    projectDir: dispatch.projectDir ?? null,
  };
}

export function createDispatchesRouter() {
  const router = Router();

  // POST /dispatches/subagent — register a subagent session.
  //
  // Issue #909 / ADR-0027 eighth sweep: the schema-validation 400 stays inline;
  // the never-throw-500 isolation + pino `err`-field log come from the
  // isolateAggregator seam (route-helpers.ts) once.
  router.post("/dispatches/subagent", async (req, res) => {
    const parsed = SubagentDispatchPostBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    return isolateAggregator(res, "api/dispatches/subagent", async () => {
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
      return { registered: true, dispatch };
    });
  });

  // PATCH /dispatches/subagent/:sessionId/current-step — update the step.
  router.patch("/dispatches/subagent/:sessionId/current-step", async (req, res) => {
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

    // Issue #909 / ADR-0027 eighth sweep: the two validation 400s stay inline;
    // the never-throw-500 isolation + pino `err`-field log come from the seam.
    return isolateAggregator(
      res,
      "api/dispatches/subagent/current-step",
      async () => {
        await setSubagentDispatchStep(sessionId, parsed.data.currentStep);
        const updated = await getSubagentDispatch(sessionId);
        return { updated: true, dispatch: updated };
      },
    );
  });

  // GET /dispatches/:dispatchId/transcript — render a subagent session's
  // JSONL conversation (issue #695).
  //
  // The `:dispatchId` path param carries the harness sessionId (in the unified
  // active-dispatch row, `id === sessionId` for source === "subagent"; see
  // src/aggregators/active-dispatches.ts). Resolution:
  //   - Unknown dispatchId            → 404
  //   - Known dispatch, missing JSONL → 200 + transcriptStatus:"not-available"
  //   - Known dispatch, intact JSONL  → 200 + paginated messages
  // A malformed JSONL line is skipped, never 500.
  router.get("/dispatches/:dispatchId/transcript", async (req, res) => {
    const dispatchId = (req.params.dispatchId || "").trim();
    try {
      const parsedQuery = TranscriptQuerySchema.safeParse(req.query ?? {});
      if (!parsedQuery.success) {
        return res.status(400).json({
          code: "schema-validation-failed",
          issues: parsedQuery.error.issues,
        });
      }
      const { offset, limit } = parsedQuery.data;

      const dispatch = await getSubagentDispatch(dispatchId);
      if (!dispatch) {
        return res.status(404).json({
          code: "dispatch-not-found",
          dispatchId,
        });
      }

      const sessionMetadata = sessionMetadataFrom(dispatch);

      // dispatchId === sessionId for the subagent source. Resolve the JSONL.
      const path = await resolveTranscriptPath(
        dispatch.sessionId,
        dispatch.projectDir,
      );
      if (!path) {
        // Known dispatch but the transcript file is gone (cleanup / >30d) or
        // never materialised. NOT a 500 — render metadata, empty messages.
        return res.json({
          transcriptStatus: "not-available",
          messages: [],
          total: 0,
          offset,
          limit,
          sessionMetadata,
        });
      }

      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (err) {
        // The file vanished between resolve and read, or is unreadable. Treat
        // as not-available rather than 500 — same contract as a missing file.
        // ADR-0027 eighth sweep: the catch adopts the pino `err`-field seam.
        logger.error(
          { dispatchId, path, err },
          "[api/dispatches] transcript read failed",
        );
        return res.json({
          transcriptStatus: "not-available",
          messages: [],
          total: 0,
          offset,
          limit,
          sessionMetadata,
        });
      }

      const all = parseTranscript(raw);
      const { page, total } = paginate(all, offset, limit);
      return res.json({
        transcriptStatus: "available",
        messages: page,
        total,
        offset,
        limit,
        sessionMetadata,
      });
    } catch (err: any) {
      // Not an isolateAggregator route: the success path writes 404 /
      // not-available branches directly, which the seam can't express. ADR-0027
      // eighth sweep: the catch adopts the pino `err`-field seam.
      logger.error(
        { dispatchId, err },
        "[api/dispatches] GET transcript failed",
      );
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
