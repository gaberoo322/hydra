/**
 * OTLP trace ingest sub-router (issue #5177, epic #5171).
 *
 *   POST /api/otel/v1/traces
 *
 * Receives Claude Code's enhanced-telemetry `claude_code.llm_request` spans and
 * records per-agent token totals through `src/redis/otel-spans.ts`. Shadow only:
 * no cost consumer reads the store.
 *
 * Fail-closed access: the orchestrator API is public + unauthenticated via the
 * admin tunnel, so this write route requires `HYDRA_OTEL_INGEST_KEY` to be set
 * AND the `x-hydra-otel-key` header to match. Both checks run in `otelKeyGuard`, before the body
 * is parsed and write nothing.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { OtlpTraceExportBodySchema, extractLlmRequests } from "../schemas/otel.ts";
import { recordOtelRequest } from "../redis/otel-spans.ts";
import { isolateAggregator, schemaValidationError } from "./route-helpers.ts";

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time string equality (hashes first so differing lengths cannot throw). */
export function keysMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * Key guard (503 unset / 401 mismatch). Mounted in `src/api.ts` AHEAD of the
 * 4mb body parser so unauthenticated callers never get a body buffered/parsed.
 */
export function otelKeyGuard(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.HYDRA_OTEL_INGEST_KEY;
  if (!expected) {
    res.status(503).json({ code: "otel-ingest-disabled" });
    return;
  }
  const header = req.headers["x-hydra-otel-key"];
  const provided = typeof header === "string" ? header : "";
  if (!provided || !keysMatch(provided, expected)) {
    res.status(401).json({ code: "otel-ingest-unauthorized" });
    return;
  }
  next();
}

export function createOtelRouter() {
  const router = Router();

  router.post("/otel/v1/traces", async (req, res) => {
    // Auth already enforced by otelKeyGuard (mounted ahead of the body parser).
    const parsed = OtlpTraceExportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { samples, ignored } = extractLlmRequests(parsed.data);

    return isolateAggregator(res, "api/otel/v1/traces", async () => {
      let accepted = 0;
      let deduped = 0;
      for (const sample of samples) {
        const outcome = await recordOtelRequest(sample);
        if (outcome === "accepted") accepted++;
        else deduped++;
      }
      return { ok: true, accepted, ignored, deduped };
    });
  });

  return router;
}
