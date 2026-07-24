import { Router } from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import { logger } from "../logger.ts";

// Issue #1322: the operator-action-items surface — extracted out of
// createHealthRouter (src/api/health.ts) into its own deep, named home. This
// router owns the operator-action-items *policy*: which categories exist, their
// priority ordering, and the trigger thresholds. Adding a category or moving a
// threshold now touches exactly this one file.
//
// The public HTTP path stays byte-identical: this router mounts PREFIX-LESS in
// src/api.ts (like createHealthRouter), so Express still registers the literal
// `/recommendations` path → `/api/recommendations`. README documents it as a
// public endpoint; no in-repo or dashboard caller exists (the dashboard moved
// to /api/now/recommendations, #674), but external HTTP clients still rely on
// it, so it is PRESERVED not deleted.
//
// CONTEXT.md L34: this `/recommendations` operator-action-item surface is
// DISTINCT from a Health Diagnostic (the /health/deep ruleset) — they are
// different surfaces, which is why this lives in its own router and NOT in
// health-diagnostics.ts.

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

/**
 * The four narrow I/O readers the handler depends on. Each defaults to the real
 * impl; tests inject in-memory stubs to drive each action-item category with no
 * Redis and no live Express — mirroring the #674 RecommendationsReaderDeps
 * injection pattern.
 */
export interface RecommendationsReaderDeps {
  getSchedulerStatus?: typeof getSchedulerStatus;
  /** Read+return the raw priorities.md text; rejects/throws if the file is absent. */
  readPriorities?: () => Promise<string>;
  /** Whether the kill file is present. */
  killFileExists?: () => boolean;
}

async function defaultReadPriorities(): Promise<string> {
  return readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
}

function defaultKillFileExists(): boolean {
  return existsSync(KILL_FILE);
}

export function createRecommendationsRouter(deps: RecommendationsReaderDeps = {}) {
  const router = Router();

  const readSchedulerStatus = deps.getSchedulerStatus ?? getSchedulerStatus;
  const readPriorities = deps.readPriorities ?? defaultReadPriorities;
  const killFileExists = deps.killFileExists ?? defaultKillFileExists;

  // GET /recommendations — Operator action items computed from system state.
  //
  // Contract is 200-with-partial-array: the bespoke inner try/catch logs and
  // returns whatever `recs` accumulated (possibly []), status 200. It MUST NOT
  // be wrapped in aggregatorRouteNoQuery, which would convert a throw into a 500
  // and break the wire contract.
  router.get("/recommendations", async (req, res) => {
    const recs = [];
    try {
      // 1. Scheduler not running
      const sched = await readSchedulerStatus();
      if (!sched.running) {
        recs.push({
          type: "action",
          priority: 1,
          title: "Scheduler is stopped",
          description: "Hydra won't run autonomous cycles until the scheduler is started",
          action: "Start from the Overview page",
          link: "/",
        });
      }

      // 2. Check priorities.md for BLOCKED items
      try {
        const prioritiesContent = await readPriorities();
        const blockedHeaders = prioritiesContent.match(/^##.*\[BLOCKED\].*$/gim) || [];
        const blockedReasons = prioritiesContent.match(/^\s*-\s*Blocked on.*$/gim) || [];
        if (blockedHeaders.length > 0) {
          const items = blockedHeaders.map((h: string) => h.replace(/^##\s*\d+\)\s*\[BLOCKED\]\s*/i, "").trim());
          const reasons = blockedReasons.map((r: string) => r.replace(/^\s*-\s*Blocked on operator:\s*/i, "").trim());
          recs.push({
            type: "action",
            priority: 1,
            title: `${blockedHeaders.length} priorit${blockedHeaders.length > 1 ? "ies" : "y"} blocked on operator action`,
            description: items.map((item: string, i: number) => `${item}${reasons[i] ? ` — needs: ${reasons[i]}` : ""}`).join("\n"),
            action: "Provide required credentials/approvals to unblock",
            link: "/vision",
          });
        }
      } catch { /* intentional: no priorities file present yet — degrade silently */ }

      // 3. Kill file present
      if (killFileExists()) {
        recs.push({
          type: "action",
          priority: 1,
          title: "Kill switch is active",
          description: "All cycles are blocked. Remove the kill file to resume.",
          action: "Investigate and remove ~/.hydra/.kill",
          link: "/health",
        });
      }

      // Sort by priority (1=urgent first)
      recs.sort((a, b) => a.priority - b.priority);
    } catch (err: any) {
      // Not an isolateAggregator route: the contract is 200-with-partial-array —
      // a throw logs and returns whatever `recs` accumulated (never a 500), which
      // the seam would convert to a 500. ADR-0027 eighth sweep: the catch adopts
      // the pino `err`-field seam.
      logger.error({ err }, "[API] recommendations error");
    }
    res.json(recs);
  });

  return router;
}
