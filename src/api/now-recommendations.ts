/**
 * Dashboard v2 — Now page recommendation write-path HTTP surface.
 *
 * Extracted from `src/api/now-page.ts` (issue #1323) so the recommendation
 * read+write lifecycle lives apart from the uniform dashboard read-aggregator
 * routes. The three routes here are bespoke read/write handlers (they do NOT
 * use the `aggregatorRoute`/`aggregatorRouteNoQuery` wrapper):
 *
 *   GET  /now/recommendations              — active (non-dismissed, non-muted) recs
 *   POST /now/recommendations/:id/dismiss  — dismiss a single rec
 *   POST /now/recommendations/mute-class   — mute a severity class
 *
 * The router is mounted prefix-less from `src/api.ts` (exactly like
 * `createNowPageRouter()`), so Express registers the same literal `/now/*`
 * paths and dashboard clients see no URL change. The `Rec*` query/body schemas
 * are local-only (consumed by this router alone) and stay inline here, mirroring
 * how `now-page.ts` previously inlined them — they are NOT promoted to
 * `src/schemas/now-page.ts`.
 */

import { Router } from "express";
import { z } from "zod";

import * as defaultRecsRedis from "../redis/recommendations.ts";
import { RUN_TTL_SECONDS } from "../autopilot/sweep-reader.ts";

// ---------------------------------------------------------------------------
// Recommendations sub-router schemas (issue #674)
// ---------------------------------------------------------------------------

const RecListQuerySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
  })
  .strict();

const RecMuteClassBodySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
    severity: z.enum(["info", "warn", "critical"], {
      message: "severity must be one of info|warn|critical",
    }),
  })
  .strict();

const RecDismissBodySchema = z
  .object({
    run_id: z
      .string({ message: "run_id must be a string" })
      .trim()
      .min(1, { message: "run_id must be non-empty" })
      .default("current"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router factory deps
// ---------------------------------------------------------------------------

export interface RecommendationsReaderDeps {
  getAllRecommendations(runId: string): Promise<Record<string, string>>;
  getDismissedSet(runId: string): Promise<string[]>;
  getMutedClassesSet(runId: string): Promise<string[]>;
  dismissRecommendation(
    runId: string,
    recId: string,
    ttlSeconds: number,
  ): Promise<void>;
  muteSeverityClass(
    runId: string,
    severity: string,
    ttlSeconds: number,
  ): Promise<void>;
}

export interface CurrentRunIdReader {
  (): Promise<string | null>;
}

export interface NowRecommendationsRouterDeps {
  /**
   * Reader returning the current run_id (most-recent run), for
   * `?run_id=current` resolution. Defaults to a thin call into
   * autopilot/runs.ts.
   */
  readCurrentRunId?: CurrentRunIdReader;
  /**
   * Recommendations Redis facade — defaults to the typed accessor
   * module. Tests inject an in-memory stub.
   */
  recsRedis?: RecommendationsReaderDeps;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export function createNowRecommendationsRouter(
  deps: NowRecommendationsRouterDeps = {},
) {
  const router = Router();
  const readCurrentRunId = deps.readCurrentRunId ?? defaultReadCurrentRunId;
  const recsRedis: RecommendationsReaderDeps =
    deps.recsRedis ?? defaultRecsRedis;
  const clock = deps.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // GET /now/recommendations — active (non-dismissed, non-muted-class) recs
  // -------------------------------------------------------------------------
  router.get("/now/recommendations", async (req, res) => {
    const parsed = RecListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const runId = await resolveRunId(parsed.data.run_id, readCurrentRunId);
      if (!runId) {
        return res.json({
          run_id: null,
          items: [],
          generatedAt: clock().toISOString(),
        });
      }

      const [rawHash, dismissed, muted] = await Promise.all([
        recsRedis.getAllRecommendations(runId),
        recsRedis.getDismissedSet(runId),
        recsRedis.getMutedClassesSet(runId),
      ]);

      const items = filterActiveRecommendations({
        rawHash,
        dismissed,
        muted,
      });

      return res.json({
        run_id: runId,
        items,
        generatedAt: clock().toISOString(),
      });
    } catch (err: any) {
      console.error(
        `[now/recommendations] read failed: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /now/recommendations/:id/dismiss
  // -------------------------------------------------------------------------
  router.post("/now/recommendations/:id/dismiss", async (req, res) => {
    const recId = String(req.params.id || "").trim();
    if (!recId) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: [{ message: "rec id must be non-empty" }],
      });
    }
    const parsed = RecDismissBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const runId = await resolveRunId(parsed.data.run_id, readCurrentRunId);
      if (!runId) {
        return res.status(404).json({ error: "no current run" });
      }
      await recsRedis.dismissRecommendation(runId, recId, RUN_TTL_SECONDS);
      return res.json({ run_id: runId, rec_id: recId, dismissed: true });
    } catch (err: any) {
      console.error(
        `[now/recommendations/dismiss] write failed: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /now/recommendations/mute-class
  // -------------------------------------------------------------------------
  router.post("/now/recommendations/mute-class", async (req, res) => {
    const parsed = RecMuteClassBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    try {
      const runId = await resolveRunId(parsed.data.run_id, readCurrentRunId);
      if (!runId) {
        return res.status(404).json({ error: "no current run" });
      }
      await recsRedis.muteSeverityClass(
        runId,
        parsed.data.severity,
        RUN_TTL_SECONDS,
      );
      return res.json({
        run_id: runId,
        severity: parsed.data.severity,
        muted: true,
      });
    } catch (err: any) {
      console.error(
        `[now/recommendations/mute-class] write failed: ${err?.message || err}`,
      );
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Resolve a logical `run_id` parameter into a concrete run id. `"current"`
 * is the canonical synonym for "the most recent run"; any other string is
 * treated as an explicit id and returned verbatim. Returns `null` when
 * `"current"` is requested but no run exists yet.
 */
export async function resolveRunId(
  rawRunId: string,
  readCurrentRunId: CurrentRunIdReader,
): Promise<string | null> {
  if (rawRunId === "current") return readCurrentRunId();
  return rawRunId;
}

/**
 * Pure filter — exported for direct test coverage. Given the raw rec hash
 * (id → JSON) and the dismissed/muted sets, returns the active recs
 * newest-first. Drops:
 *  - any rec whose id is in the dismissed set
 *  - any rec whose severity is in the muted set
 *  - any rec whose JSON fails to parse (logged once per call)
 *
 * Sorting is newest-first on `created_at`. Ties break on id so the order
 * is deterministic in tests.
 */
export function filterActiveRecommendations(input: {
  rawHash: Record<string, string>;
  dismissed: string[];
  muted: string[];
}): Array<Record<string, unknown>> {
  const dismissed = new Set(input.dismissed);
  const muted = new Set(input.muted);
  const out: Array<Record<string, unknown>> = [];

  for (const [id, json] of Object.entries(input.rawHash)) {
    if (dismissed.has(id)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      console.error(`[now/recommendations] dropping unparseable rec id=${id}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const severity = typeof parsed.severity === "string" ? parsed.severity : "";
    if (severity && muted.has(severity)) continue;
    out.push(parsed);
  }

  out.sort((a, b) => {
    const ta = Date.parse(String(a.created_at ?? "")) || 0;
    const tb = Date.parse(String(b.created_at ?? "")) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  return out;
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

async function defaultReadCurrentRunId(): Promise<string | null> {
  const { getCurrentRun } = await import("../autopilot/runs.ts");
  const result = await getCurrentRun();
  if (!result.ok) return null;
  const view = result.view as Record<string, unknown>;
  const id = typeof view.run_id === "string" ? view.run_id : "";
  return id || null;
}
