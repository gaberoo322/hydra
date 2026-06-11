import { Router } from "express";
import {
  loadAnchorReflections,
  loadAnchorReflectionsByFile,
  extractFilesFromAnchor,
} from "../reflections/reflections.ts";
import { getTargetName } from "../target-config.ts";
import { ReflectionsQuerySchema } from "../schemas/reflections.ts";

/**
 * Reflections + calibration proxy routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Calibration outcomes are
 * proxied from the configured target project; reflections are the
 * episodic learning surface (`hydra:reflections:{anchor}`).
 */
export function createReflectionsRouter() {
  const router = Router();

  const HYDRA_BETTING_URL = process.env.HYDRA_BETTING_URL || "http://localhost:3333";

  // GET /reflections?anchor=&files= — per-anchor episodic reflections.
  //
  // Composes the SAME per-anchor + by-file reflection narrative that
  // `getContext()` assembles for a planner/dispatch prompt, by calling the
  // existing reflections-module reads (`loadAnchorReflections` +
  // `loadAnchorReflectionsByFile`). This is the LIVE injection path (issue
  // #841): the dispatch skills (`hydra-dev`, `hydra-target-build`) fetch this
  // at planning time — where they already call `GET /api/tier` — and weave
  // `formatted` into the implementation prompt, so a RETRY of a prior-failure
  // anchor demonstrably receives its own reflection narrative (the #193
  // retry-correctness invariant, now on a live path instead of the in-process
  // assembly path that used to carry it — retired with the codex control loop,
  // issue #1128).
  //
  // The narrative travels skill -> API at planning time and never through
  // `decide.py` (whose dispatch JSON stays `{anchor, score}`), keeping the L2
  // decision JSON lean.
  //
  // Optional `?files=<csv>` supplies scope files for the by-file fan-out
  // (issue #326) — anchors that touched the same file(s). When omitted, file
  // paths are extracted from the anchor reference.
  //
  // Issue #1454: `anchor` is now REQUIRED. The legacy no-anchor "mode 1"
  // returned the dead global reflection buffer (`getAllReflections`), which
  // was deleted with the buffer subsystem. An absent/blank `anchor` is a 400
  // schema-validation failure, not a fallback to the buffer.
  //
  // Response: { anchor, formatted, count, blocks: [{source, count}, ...] }
  // A miss (no prior reflections) returns `formatted: ""`, `count: 0` so the
  // skill can graceful-degrade to a no-op injection.
  router.get("/reflections", async (req, res) => {
    // ADR-0022: read `anchor`/`files` through the Schemas seam. `anchor` is
    // required (#1454) — a missing/blank value rejects with 400.
    const parsed = ReflectionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: "schema-validation-failed", issues: parsed.error.issues });
      return;
    }
    const anchor = parsed.data.anchor;

    try {
      const filesParam = parsed.data.files ?? "";
      const scopeFiles = filesParam
        ? filesParam.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

      const perAnchor = await loadAnchorReflections(anchor);

      const files = extractFilesFromAnchor(anchor, scopeFiles);
      const byFile = files.length > 0
        ? await loadAnchorReflectionsByFile(files, anchor)
        : { content: "", count: 0 };

      const sections = [perAnchor.content, byFile.content].filter(Boolean);
      const formatted = sections.join("\n\n");
      const count = perAnchor.count + byFile.count;

      res.json({
        anchor,
        formatted,
        count,
        blocks: [
          { source: "per-anchor-reflections", count: perAnchor.count },
          { source: "by-file-reflections", count: byFile.count },
        ],
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /calibration/outcomes — Proxy to target project's calibration API
  router.get("/calibration/outcomes", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const url = `${HYDRA_BETTING_URL}/api/calibration/outcomes${qs ? `?${qs}` : ""}`;
      const response = await fetch(url);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `${getTargetName()} unavailable: ${err.message}` });
    }
  });

  router.post("/calibration/outcomes/sync", async (req, res) => {
    try {
      const response = await fetch(`${HYDRA_BETTING_URL}/api/calibration/outcomes/sync`, { method: "POST" });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `${getTargetName()} unavailable: ${err.message}` });
    }
  });

  return router;
}
