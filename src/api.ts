import express from "express";
import * as Sentry from "@sentry/node";
import { resolve } from "node:path";

import { createCyclesRouter } from "./api/cycles.ts";
import { createQueueRouter } from "./api/queue.ts";
import { createTasksRouter } from "./api/tasks.ts";
import { createHealthRouter } from "./api/health.ts";
import { createResearchRouter } from "./api/research.ts";
import { createBacklogRouter } from "./api/backlog.ts";
import { createSpecsRouter } from "./api/specs.ts";
import { createSchedulerRouter } from "./api/scheduler.ts";
import { createProposalsRouter } from "./api/proposals.ts";
import { createMetricsRouter } from "./api/metrics.ts";
import { createMiscRouter } from "./api/misc.ts";
import { createArchitectureRouter } from "./api/architecture.ts";
import { createChecklistRouter } from "./api/checklist.ts";
import { createOutcomesRouter } from "./api/outcomes.ts";
import { createOpenVikingRouter } from "./api/openviking.ts";
import { createGoalsRouter } from "./api/goals.ts";
import { createEventsRouter } from "./api/events.ts";
import { createConfigRouter } from "./api/config.ts";
import { createAlertsRouter } from "./api/alerts.ts";
import { createPlanCacheRouter } from "./api/plan-cache.ts";
import { createReflectionsRouter } from "./api/reflections.ts";
import { createMergeLockRouter } from "./api/merge-lock.ts";
import { createCapacityRouter } from "./api/capacity.ts";
import { createObservabilityRouter } from "./api/observability.ts";
import { createHoldbackRouter } from "./api/holdback.ts";
import { createLearningRouter } from "./api/learning.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");

function createApi(eventBus) {
  const app = express();
  app.use(express.json());

  // CORS — allow dashboard from any origin (Vercel, local dev, etc.)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // All API routes go on a Router, mounted at "/api".
  const api = express.Router();
  app.use("/api", api);

  // Mount domain sub-routers
  api.use(createCyclesRouter(eventBus));
  api.use(createQueueRouter());
  api.use(createTasksRouter());
  api.use(createHealthRouter(eventBus));
  api.use(createResearchRouter(eventBus));
  api.use(createBacklogRouter());
  api.use(createSpecsRouter());
  api.use(createSchedulerRouter(eventBus));
  api.use(createProposalsRouter(eventBus));
  api.use(createMetricsRouter());
  api.use(createArchitectureRouter(eventBus));
  // Routes split out of misc.ts per issue #268 — each owns one domain.
  api.use(createOpenVikingRouter());
  api.use(createGoalsRouter());
  api.use(createEventsRouter(eventBus));
  api.use(createConfigRouter());
  api.use(createAlertsRouter(eventBus));
  api.use(createPlanCacheRouter());
  api.use(createReflectionsRouter());
  api.use(createMergeLockRouter());
  api.use(createCapacityRouter());
  api.use(createObservabilityRouter());
  api.use(createHoldbackRouter());
  api.use(createLearningRouter());
  api.use(createMiscRouter(eventBus));
  api.use(createChecklistRouter());
  api.use(createOutcomesRouter());

  // Sentry error handler — must be after all routes, before other error handlers
  Sentry.setupExpressErrorHandler(app);

  // Serve dashboard — static files first, then SPA fallback for client routes
  const DASHBOARD_DIR = resolve(HYDRA_ROOT, "dashboard", "dist");
  const DASHBOARD_INDEX = resolve(DASHBOARD_DIR, "index.html");
  app.use(express.static(DASHBOARD_DIR));

  // SPA fallback — only for browser navigation (Accept: text/html), not API calls.
  app.use((req, res, next) => {
    const accept = req.headers.accept || "";
    if (req.method === "GET" && accept.includes("text/html")) {
      res.sendFile(DASHBOARD_INDEX, (err) => {
        if (err) res.status(404).send("Dashboard not built. Run: cd dashboard && npm run build");
      });
    } else {
      next();
    }
  });

  return app;
}

export { createApi };
