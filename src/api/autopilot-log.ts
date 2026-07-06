/**
 * Autopilot observability log/journal serving routes.
 *
 *   GET /autopilot/runs/:runId/log      — log tail
 *   GET /autopilot/runs/:runId/journal  — systemd journal slice
 *
 * Split out of the combined `autopilot.ts` router (#2034). These two reads
 * stream raw text (NOT JSON) and evolved with the Journal Adapter Seam split
 * (#1958): the log tail comes from `src/autopilot/log.ts`, the journalctl slice
 * from its own private-spawn `src/journal/read.ts` accessor. Both first resolve
 * the run row via the lifecycle Module (`getRunRow`) so a missing/invalid run
 * answers 404 before any I/O. No direct Redis access in this file.
 */

import { Router } from "express";
import { z } from "zod";
import { getRunRow } from "../autopilot/run-reads.ts";
import {
  readLogTail,
  LOG_TAIL_DEFAULT,
  LOG_TAIL_MAX,
} from "../autopilot/log.ts";
// Journal Adapter seam (issue #1958): the journalctl slice moved out of
// autopilot/log.ts behind its own private spawn primitive + typed accessor.
import { readJournalSlice, isJournalSliceFailure } from "../journal/read.ts";

export function createAutopilotLogRouter() {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/log — log tail.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/log", async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    const runRowResult = await getRunRow(runId);
    if (!runRowResult.ok) {
      const status = runRowResult.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: runRowResult.detail || runRowResult.code });
    }

    // ADR-0022: read `tail` through the Schemas seam. This route keeps its
    // bespoke hard-400 on out-of-range input, so it safeParses inline (strict
    // integer in [1, LOG_TAIL_MAX], default LOG_TAIL_DEFAULT) and owns the
    // response — matching the common.ts guidance for routes with bespoke
    // error handling.
    const tailResult = z
      .object({
        tail: z.coerce
          .number()
          .int()
          .min(1)
          .max(LOG_TAIL_MAX)
          .default(LOG_TAIL_DEFAULT),
      })
      .safeParse(req.query);
    if (!tailResult.success) {
      return res.status(400).json({
        error: `invalid tail: must be integer in [1, ${LOG_TAIL_MAX}]`,
      });
    }
    const tailParsed = tailResult.data.tail;

    try {
      const logResult = await readLogTail({ runId, row: runRowResult.row, tail: tailParsed });
      if (!logResult.ok) {
        return res.status(404).json({ error: "log no longer available — rotated" });
      }
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-autopilot-log-source", logResult.source);
      return res.status(200).send(logResult.text);
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId/log failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /autopilot/runs/:runId/journal — systemd journal slice.
  // -------------------------------------------------------------------------
  router.get("/autopilot/runs/:runId/journal", async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      return res.status(400).json({ error: "Missing runId" });
    }
    const runRowResult = await getRunRow(runId);
    if (!runRowResult.ok) {
      const status = runRowResult.code === "not-found" ? 404 : 500;
      return res.status(status).json({ error: runRowResult.detail || runRowResult.code });
    }

    try {
      const journalResult = await readJournalSlice({ row: runRowResult.row });
      if (isJournalSliceFailure(journalResult)) {
        const detail =
          journalResult.code === "invalid-row"
            ? "run hash missing valid started timestamp"
            : `journalctl read failed: ${journalResult.code}`;
        return res.status(500).json({ error: detail });
      }
      const slice = journalResult.data;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-autopilot-journal-unit", slice.unit);
      if (slice.truncated) res.setHeader("x-autopilot-journal-truncated", "true");
      if (slice.timedOut) res.setHeader("x-autopilot-journal-timed-out", "true");
      return res.status(200).send(slice.text);
    } catch (err: any) {
      console.error(`[autopilot] runs/:runId/journal failed: ${err?.message || err}`);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
