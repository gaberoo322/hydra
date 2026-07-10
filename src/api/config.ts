import { Router } from "express";
import { resolve } from "node:path";
import { getTargetName, getTargetWorkspace } from "../target-config.ts";
import { booleanFlag } from "../schemas/common.ts";
import { z } from "zod";
import {
  parseEnvFile,
  maskValue,
  makeEnvAuthGuard,
  CONFIG_SECTIONS,
  listConfigSection,
  readConfigFile,
  writeConfigFile,
  readEnvFile,
  upsertEnvVar,
  deleteEnvVar,
} from "./config-io.ts";

/**
 * Config + env-var routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Config endpoints read/write
 * git-tracked markdown files under config/{agents,feedback,direction,research}.
 * Env-var endpoints read/write .env files for hydra and the target project, and
 * require Bearer auth via CRON_SECRET.
 *
 * Filesystem policy — the config-section registry, path construction, and the
 * `.env` read/write+edit operations — lives in the `config-io.ts` leaf (issues
 * #3056, #3104). This factory is a thin adapter: parse the request → call a leaf
 * primitive → shape the response. It resolves the env-project and config-root
 * paths (the only config the leaf refuses to read from `process.env`) and holds
 * no `readFile`/`writeFile`/`readdir` of its own.
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
    try {
      res.json(await listConfigSection(CONFIG_PATH, section));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /config/:section/:name — Read a config file
  router.get("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    try {
      const content = await readConfigFile(CONFIG_PATH, section, req.params.name);
      if (content === null) return res.status(404).json({ error: `Not found: ${req.params.name}` });
      res.type("text/plain").send(content);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /config/:section/:name — Update a config file
  router.put("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "Body must include 'content' string" });
    try {
      const path = await writeConfigFile(CONFIG_PATH, section, req.params.name, content);
      res.json({ ok: true, path });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Environment variables
  // -----------------------------------------------------------------------

  const ENV_PROJECTS: Record<string, string> = {
    hydra: resolve(process.env.HOME || "", "hydra", ".env"),
    [getTargetName()]: resolve(getTargetWorkspace(), ".env.local"),
  };

  const CRON_SECRET = process.env.CRON_SECRET || "";

  // Pure `.env` parse/mask primitives + the Bearer-auth guard live in the
  // `config-io.ts` leaf (issue #3056). The guard captures CRON_SECRET here.
  const requireEnvAuth = makeEnvAuthGuard(CRON_SECRET);

  // GET /env/:project — List env vars
  router.get<{ project: string }>("/env/:project", requireEnvAuth, async (req, res) => {
    const envPath = ENV_PROJECTS[req.params.project];
    if (!envPath) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
    try {
      const vars = parseEnvFile(await readEnvFile(envPath));
      // ADR-0022: read the `reveal` flag through the Schemas seam via the
      // common booleanFlag helper. Absent/unset => false (mask values).
      const reveal = z.object({ reveal: booleanFlag() }).parse(req.query).reveal;
      res.json(vars.map(v => ({
        key: v.key,
        value: reveal ? v.value : maskValue(v.value),
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /env/:project — Set/update a variable
  router.put<{ project: string }>("/env/:project", requireEnvAuth, async (req, res) => {
    const envPath = ENV_PROJECTS[req.params.project];
    if (!envPath) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
    const { key, value } = req.body || {};
    if (!key || typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return res.status(400).json({ error: "Invalid key — must be a valid env var name" });
    }
    if (typeof value !== "string") {
      return res.status(400).json({ error: "Value must be a string" });
    }
    try {
      const action = await upsertEnvVar(envPath, key, value);
      res.json({ ok: true, key, action });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /env/:project/:key — Remove a variable
  router.delete<{ project: string; key: string }>("/env/:project/:key", requireEnvAuth, async (req, res) => {
    const envPath = ENV_PROJECTS[req.params.project];
    if (!envPath) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
    const key = req.params.key;
    try {
      const removed = await deleteEnvVar(envPath, key);
      if (!removed) return res.status(404).json({ error: `Key not found: ${key}` });
      res.json({ ok: true, key, action: "deleted" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
