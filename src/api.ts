import express from "express";
import * as Sentry from "@sentry/node";
import { resolve } from "node:path";

import { createCyclesRouter } from "./api/cycles.ts";
import { createQueueRouter } from "./api/queue.ts";
import { createGroundingRouter } from "./api/grounding.ts";
import { createHealthRouter } from "./api/health.ts";
import { createRecommendationsRouter } from "./api/recommendations.ts";
import { createResearchRouter } from "./api/research.ts";
import { createBacklogRouter } from "./api/backlog.ts";
import { createDesignConceptsRouter } from "./api/design-concepts.ts";
import { createSchedulerRouter } from "./api/scheduler.ts";
import { createMaintenanceRouter } from "./api/maintenance.ts";
import { createMetricsRouter } from "./api/metrics.ts";
import { createTierRouter } from "./api/tier.ts";
import { createDigestRouter } from "./api/digest.ts";
import { createOperationalRouter } from "./api/operational.ts";
import { createArchitectureRouter } from "./api/architecture.ts";
import { createOutcomesRouter } from "./api/outcomes.ts";
import { createAttributionRouter } from "./api/attribution.ts";
import { createHoldbackRouter } from "./api/holdback.ts";
import { createOpenVikingRouter } from "./api/openviking.ts";
import { createGoalsRouter } from "./api/goals.ts";
import { createEventsRouter } from "./api/events.ts";
import { createConfigRouter } from "./api/config.ts";
import { createAlertsRouter } from "./api/alerts.ts";
import { createReflectionsRouter } from "./api/reflections.ts";
import { createMergeLockRouter } from "./api/merge-lock.ts";
import { createCapacityRouter } from "./api/capacity.ts";
import { createObservabilityRouter } from "./api/observability.ts";
import { createLearningRouter } from "./api/learning.ts";
import { createPatternMemoryRouter } from "./api/pattern-memory.ts";
import { createAnchorRouter } from "./api/anchor.ts";
import { createAutopilotLifecycleRouter } from "./api/autopilot-lifecycle.ts";
import { createAutopilotRunsRouter } from "./api/autopilot-runs.ts";
import { createAutopilotLogRouter } from "./api/autopilot-log.ts";
import { createAutopilotControlRouter } from "./api/autopilot-control.ts";
import { createAgentsRouter } from "./api/agents.ts";
import { createScoutRouter } from "./api/scout.ts";
import { createUsageRouter } from "./api/usage.ts";
import { createAutopilotIdleRouter } from "./api/autopilot-idle.ts";
import { createAutopilotBoardRouter } from "./api/autopilot-board.ts";
import { createAutopilotClassStatsRouter } from "./api/class-stats.ts";
import { createTaxonomyRouter } from "./api/taxonomy.ts";
import { createTodayPageRouter } from "./api/today-page.ts";
import { createNowPageRouter } from "./api/now-page.ts";
import { createNowRecommendationsRouter } from "./api/now-recommendations.ts";
import { createOutcomesPageRouter } from "./api/outcomes-page.ts";
import { createExplorePageRouter } from "./api/explore-page.ts";
import { createDispatchesRouter } from "./api/dispatches.ts";
import { createBuilderHealthRouter } from "./api/builder-health.ts";
import type { EventBus } from "./event-bus.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");

// `eventBus` is the concrete in-process bus (src/event-bus.ts), constructed in
// src/index.ts. It structurally satisfies every router seam in
// src/event-bus-seams.ts (PingableBus / PublishableBus / EventReaderBus),
// so the typed mount points below need no cast. The routers that never touch
// the bus (research, cycles, alerts, tier, digest, operational, …) take no
// parameter.
function createApi(eventBus: EventBus) {
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
  api.use(createCyclesRouter());
  api.use(createQueueRouter());
  // Grounding read surface (issue #3190) — re-homed from the retired
  // `api/tasks.ts` router; mounts prefix-less so /api/grounding/latest stays
  // byte-identical. The old router's always-dead /agents/status +
  // /agents/:id/pause routes were retired (empty under the autopilot recorder,
  // ADR-0016).
  api.use(createGroundingRouter());
  api.use(createHealthRouter(eventBus));
  // Operator-action-items surface (issue #1322) — extracted out of the health
  // router; mounts prefix-less so /api/recommendations stays byte-identical.
  api.use(createRecommendationsRouter());
  api.use(createResearchRouter());
  api.use(createBacklogRouter());
  api.use(createDesignConceptsRouter());
  api.use(createSchedulerRouter(eventBus));
  // Maintenance — hourly housekeeping endpoint (issue #723, scheduler fold PR-3/4).
  api.use(createMaintenanceRouter(eventBus));
  api.use(createMetricsRouter());
  api.use(createArchitectureRouter(eventBus));
  // Routes split out of misc.ts per issue #268 — each owns one domain.
  api.use(createOpenVikingRouter());
  api.use(createGoalsRouter());
  api.use(createEventsRouter(eventBus));
  api.use(createConfigRouter());
  api.use(createAlertsRouter());
  api.use(createReflectionsRouter());
  api.use(createMergeLockRouter());
  api.use(createCapacityRouter());
  api.use(createObservabilityRouter());
  api.use(createLearningRouter());
  // Issue #3006: the plan-time knowledge fetch (GET /api/learning/knowledge)
  // moved out of the learning router into createOpenVikingRouter (its
  // Knowledge-Base domain home); the read-side pattern-memory diagnostics moved
  // into createPatternMemoryRouter. Route paths unchanged; src/api.ts stays a
  // thin mount point with the same three zero-arg factory calls.
  api.use(createPatternMemoryRouter());
  api.use(createAnchorRouter());
  // Autopilot HTTP surface — split by domain concern (#2034) into four focused
  // sub-routers, each a thin adapter over its own domain Module: lifecycle
  // WRITES (run/turn/cycle), run-projection READS, log/journal serving, and
  // operator control flags. The HTTP URL surface is unchanged.
  api.use(createAutopilotLifecycleRouter());
  api.use(createAutopilotRunsRouter());
  api.use(createAutopilotLogRouter());
  api.use(createAutopilotControlRouter(eventBus));
  api.use(createAgentsRouter());
  api.use(createScoutRouter());
  api.use(createUsageRouter());
  // Idle-diagnostics (issue #889, now-console-2) — *why* the Pace Gate isn't
  // launching a run right now: the data behind an IDLE verdict on the Console.
  api.use(createAutopilotIdleRouter());
  // Board-state projection (issue #934) — the orchestrator issue-board counts
  // + stale lists the autopilot Phase-1 collector consumes, served on top of
  // the GitHub-Read seam so collect-state.sh stops re-spelling the repo handle,
  // the --json field set, and the label vocabulary in bash.
  api.use(createAutopilotBoardRouter());
  // Per-class yield scoreboard + shadow-mode dampener (issue #2943) — the
  // class-appropriate yield metric + the cadence multiplier decide.py WOULD
  // apply in a future live mode. Read-only; collect-state.sh injects it into
  // state.class_stats and decide.py logs the shadow verdict (actuates nothing).
  api.use(createAutopilotClassStatsRouter());
  // Dispatch-class taxonomy (issue #2524) — the autopilot class alphabet
  // (pipeline slots, signal classes, per-signal cooldowns) served read-only on
  // top of the typed `src/taxonomy/classes.ts` views so the dashboard fetches
  // the alphabet instead of hard-coding three diverging copies of it.
  api.use(createTaxonomyRouter());
  // Subagent-dispatch capture (issue #692) — SessionStart hook write surface.
  api.use(createDispatchesRouter());
  // Builder-Health Scorecard (issue #732) — orchestrator self-improvement
  // made observable: the builder-side counterpart to the Outcomes surface.
  api.use(createBuilderHealthRouter());
  // Dashboard pages (PRD #615). After the slice-6 atomic swap (#621) the
  // routes are mounted at their final names; the historical `/api/v2/*`
  // incremental-delivery prefix is gone.
  api.use(createTodayPageRouter());
  // Now page — slice 3 (issue #618).
  api.use(createNowPageRouter());
  // Now page recommendation write-path — extracted from now-page (#1323).
  api.use(createNowRecommendationsRouter());
  // Slice 4 (issue #619) — Outcomes page: 4 weekly-trend endpoints.
  api.use(createOutcomesPageRouter());
  // Explore tabbed hub — slice 5 (issue #620).
  api.use(createExplorePageRouter());
  // Domain homes for the last three orphan-operational routes that lived in
  // the retired src/api/misc.ts (issue #2183). Each owns one concern: tier
  // classification next to src/tier-classifier.ts, digest triggers next to
  // src/digest.ts, and the emergency-stop kill switch in its own minimal
  // operational Module. The HTTP paths (/tier, /digest/*, /kill) are unchanged.
  api.use(createTierRouter());
  api.use(createDigestRouter());
  api.use(createOperationalRouter());
  // /api/checklist sub-router retired in slice 6 of the dashboard
  // simplification (issue #621). Only the deleted Checklist page consumed it.
  api.use(createOutcomesRouter());
  // Attribution view (issue #2631, epic #2628) — read-only GET /api/attribution
  // surfacing per-metric ranked producer-class marginal effects β_c from the
  // #2630 estimator over the #2629 ledger. No eventBus: the view emits nothing.
  api.use(createAttributionRouter());
  // Outcome Holdback producer (issue #786, ADR-0004 step 4) — the post-merge
  // regression-check write surface that finally feeds digest.ts's orphaned
  // holdback.* consumer. Needs eventBus to emit on hydra:notifications.
  api.use(createHoldbackRouter(eventBus));

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
