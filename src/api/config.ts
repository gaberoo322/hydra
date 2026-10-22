import { Router } from "express";
import { resolve } from "node:path";
import {
  CONFIG_SECTIONS,
  listConfigSection,
  readConfigFile,
  writeConfigFile,
} from "./config-io.ts";
import { isolateAggregator } from "./route-helpers.ts";
import { logger } from "../logger.ts";

/**
 * Config routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Config endpoints read/write
 * git-tracked markdown files under config/{agents,feedback,direction,research}.
 * The `/env/:project` GET/PUT/DELETE routes were retired under ADR-0024 §3
 * (issue #4638, ADR-0034 §9.1/§9.4): zero callers, and a 401 on every request
 * on this host.
 *
 * Filesystem policy — the config-section registry, path construction and the
 * read/write operations — lives in the `config-io.ts` leaf (issues #3056,
 * #3104). This factory is a thin adapter: parse the request → call a leaf
 * primitive → shape the response. It resolves the config-root path (the only
 * config the leaf refuses to read from `process.env`) and holds no
 * `readFile`/`writeFile`/`readdir` of its own.
 */
export function createConfigRouter() {
  const router = Router();

  const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
  const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

  // -----------------------------------------------------------------------
  // Config endpoints — read/write git-tracked config files
  // -----------------------------------------------------------------------

  // GET /config/:section — List files in a config section
  router.get("/config/:section", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    return isolateAggregator(res, "api/config/section", () =>
      listConfigSection(CONFIG_PATH, section),
    );
  });

  // GET /config/:section/:name — Read a config file
  //
  // Not an isolateAggregator route: the success path responds with
  // `text/plain`, not a JSON body the seam's `res.json(produce())` can express.
  router.get("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    try {
      const content = await readConfigFile(CONFIG_PATH, section, req.params.name);
      if (content === null) return res.status(404).json({ error: `Not found: ${req.params.name}` });
      res.type("text/plain").send(content);
    } catch (err: any) {
      logger.error(
        { routeLabel: "api/config/section/name", section: req.params.section, name: req.params.name, err },
        "[api/config] read failed",
      );
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /config/:section/:name — Update a config file
  router.put("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "Body must include 'content' string" });
    return isolateAggregator(res, "api/config/section/name/put", async () => {
      const path = await writeConfigFile(CONFIG_PATH, section, req.params.name, content);
      return { ok: true, path };
    });
  });

  return router;
}
