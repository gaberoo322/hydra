/**
 * Grounding API (issue #3190).
 *
 * GET /api/grounding/latest — the most-recently-run grounding report.
 *
 * Re-homed here from the misnamed `api/tasks.ts` router (issue #3190). That
 * module bundled this grounding read with two always-dead `/agents/*` routes
 * and the vestigial name of the retired in-process task tracker (issue #792 /
 * ADR-0016). This route belongs to the grounding domain, so it now lives in a
 * module named for its domain; the dead agent routes were retired.
 *
 * The `../grounding/index.ts` import is static: `grounding/index.ts` imports
 * nothing api-side, so the circular-dependency hazard the old lazy
 * `await import(...)` guarded against no longer exists (post-ADR-0016 removal).
 */

import { Router } from "express";
import { groundProject } from "../grounding/index.ts";
import { getTargetWorkspace } from "../target-config.ts";

export function createGroundingRouter() {
  const router = Router();

  // GET /grounding/latest — Most recent grounding report
  //
  // Includes a `testParseStatus` field (mirrored from `report.testReport.parseStatus`)
  // so dashboard/API consumers can distinguish the silent-no-op shape
  // ("ran 0 tests" vs "couldn't read the result") without reaching into
  // nested fields. See issue #456 — the parser used to silently return
  // `{passed:0, failed:0, total:0}` on unrecognised output and downstream
  // metrics treated that as ground truth.
  router.get("/grounding/latest", async (req, res) => {
    try {
      const projectDir = getTargetWorkspace();
      const report = await groundProject(projectDir);
      const testParseStatus = report?.testReport?.parseStatus ?? null;
      res.json({ ...report, testParseStatus });
    } catch (err: any) {
      console.error(`[grounding-api] GET /grounding/latest failed: ${err?.message || err}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
