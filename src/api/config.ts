import { Router } from "express";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getTargetName, getTargetWorkspace } from "../target-config.ts";
import { booleanFlag } from "../schemas/common.ts";
import { z } from "zod";
import { parseEnvFile, maskValue, makeEnvAuthGuard } from "./config-io.ts";

/**
 * Config + env-var routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Config endpoints read/write
 * git-tracked markdown files under config/{agents,feedback,direction,research}.
 * Env-var endpoints read/write .env files for hydra and the target project, and
 * require Bearer auth via CRON_SECRET.
 */
export function createConfigRouter() {
  const router = Router();

  const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
  const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

  // -----------------------------------------------------------------------
  // Config endpoints — read/write git-tracked config files
  // -----------------------------------------------------------------------

  const CONFIG_SECTIONS = {
    agents: { dir: "agents", ext: ".md" },
    feedback: { dir: "feedback", ext: ".md" },
    direction: { dir: "direction", ext: ".md" },
    research: { dir: "research", ext: ".md" },
  };

  // GET /config/:section — List files in a config section
  router.get("/config/:section", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    try {
      const dir = join(CONFIG_PATH, section.dir);
      const files = (await readdir(dir)).filter(f => f.endsWith(section.ext));
      res.json(files.map(f => f.replace(section.ext, "")));
    } catch (err: any) {
      if (err.code === "ENOENT") return res.json([]);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /config/:section/:name — Read a config file
  router.get("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    const filePath = join(CONFIG_PATH, section.dir, `${req.params.name}${section.ext}`);
    try {
      const content = await readFile(filePath, "utf-8");
      res.type("text/plain").send(content);
    } catch (err: any) {
      if (err.code === "ENOENT") return res.status(404).json({ error: `Not found: ${req.params.name}` });
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /config/:section/:name — Update a config file
  router.put("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "Body must include 'content' string" });
    const filePath = join(CONFIG_PATH, section.dir, `${req.params.name}${section.ext}`);
    try {
      await writeFile(filePath, content);
      res.json({ ok: true, path: filePath });
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
      const raw = await readFile(envPath, "utf-8");
      const vars = parseEnvFile(raw);
      // ADR-0022: read the `reveal` flag through the Schemas seam via the
      // common booleanFlag helper. Absent/unset => false (mask values).
      const reveal = z.object({ reveal: booleanFlag() }).parse(req.query).reveal;
      res.json(vars.map(v => ({
        key: v.key,
        value: reveal ? v.value : maskValue(v.value),
      })));
    } catch (err: any) {
      if (err.code === "ENOENT") return res.json([]);
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
      let raw = "";
      try { raw = await readFile(envPath, "utf-8"); } catch { /* intentional: env file doesn't exist yet — initialize as empty */ }
      const lines = raw.split("\n");
      const needle = `${key}=`;
      const idx = lines.findIndex(l => l.startsWith(needle) || l.startsWith(`${key} =`));
      const needsQuotes = value.includes(" ") || value.includes("#") || value.includes('"') || value.includes("\n");
      const formatted = needsQuotes ? `${key}="${value.replace(/"/g, '\\"')}"` : `${key}=${value}`;
      if (idx >= 0) {
        lines[idx] = formatted;
      } else {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(formatted);
      }
      await writeFile(envPath, lines.join("\n"));
      res.json({ ok: true, key, action: idx >= 0 ? "updated" : "added" });
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
      const raw = await readFile(envPath, "utf-8");
      const lines = raw.split("\n");
      const filtered = lines.filter(l => !l.startsWith(`${key}=`) && !l.startsWith(`${key} =`));
      if (filtered.length === lines.length) {
        return res.status(404).json({ error: `Key not found: ${key}` });
      }
      await writeFile(envPath, filtered.join("\n"));
      res.json({ ok: true, key, action: "deleted" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
