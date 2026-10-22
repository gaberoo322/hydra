/**
 * The parity contract's pins (ADR-0034 §9, issue #4638 — guidance-epic 19/19).
 *
 * The dashboard must reflect the Orchestrator's operator-facing surface. §9
 * defines parity as four rungs, each pinned by a test in the required `test`
 * job (`test/operator-actions-parity.test.mts`) so that a new route or class
 * reddens CI until someone classifies it here:
 *
 *   - Rung 1 (§9.1): every WRITE route is in exactly one of — the registry's
 *     `in-dashboard` routes (derived from `REGISTRY`, never listed here),
 *     {@link MACHINE_WRITES}, {@link RETIRED_WRITES} — plus the small,
 *     shrink-only {@link PENDING_CONTROL_WRITES} allowance.
 *   - Rung 2 (§9.2) is pinned by `classEntryCoverage` in `registry.ts`.
 *   - Rung 3 (§9.3): every playbook is a `class:` entry, is referenced by a
 *     registry action, or is in {@link DOCS_ONLY} with a reason.
 *   - Rung 4 (§9.4): every GET is in exactly one of {@link HOMED_READS}
 *     (route → owning dashboard file, which must contain the path literal),
 *     {@link MACHINE_READS}, {@link RETIRED_READS}.
 *
 * # One enumeration, two annotators
 *
 * The route list is `docs/generated/routes.json` (ADR-0034 §10, issue #4589),
 * read by {@link loadRouteInventory}. This module NEVER re-enumerates routes
 * with its own regex: every key below is a `"<METHOD> <path>"` string in the
 * inventory's own form (`/api` prefix, `:param` segments), and the helpers only
 * compare those keys against the inventory rows. The one regex here,
 * {@link routeLiteralPattern}, matches a KNOWN route's call literal inside a
 * dashboard file for the HOMED_READS check — it discovers no routes.
 *
 * # Classification rule (§9.4, applied to writes too)
 *
 *   - A route with a dashboard consumer is homed (GET) or has a registry
 *     control (write).
 *   - A route with any non-dashboard caller (a script, skill, playbook, the
 *     `bin/hydra` CLI, a workflow, an external webhook) is machine-facing; the
 *     reason names that caller.
 *   - A route with zero callers is retired: deleted from `src/api/` under
 *     ADR-0024 §3, and kept in RETIRED_* so it can never quietly return.
 *
 * A handful of machine entries carry "no in-repo caller found" in their reason:
 * they had zero callers at classification time but sit outside the eleven
 * reads / five writes §9 ratified for retirement, so #4638 records them rather
 * than widening the deletion. Each is a retirement candidate for a follow-up.
 *
 * Pure data + pure helpers: no Express, no Redis. The only I/O is
 * {@link loadRouteInventory}'s read of the committed inventory file.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InvariantViolationError } from "../errors.ts";
import type { OperatorActionEntry } from "../schemas/operator-actions.ts";

// ---------------------------------------------------------------------------
// The route inventory (docs/generated/routes.json)
// ---------------------------------------------------------------------------

/** The fields of a `docs/generated/routes.json` row this module reads. */
export interface RouteInventoryRow {
  method: string;
  /** Full path including the `/api` prefix, `:param` segments. */
  path: string;
  /** Repo-relative dashboard/src files whose call literal matches this path. */
  consumers: string[];
}

/** The committed inventory, relative to this module (src/operator-actions/). */
export const ROUTES_INVENTORY_PATH = resolve(
  import.meta.dirname,
  "../../docs/generated/routes.json",
);

/**
 * Read and shape-check the committed route inventory. Throws
 * `InvariantViolationError` on a malformed file — the parity pins must never
 * run against a silently-empty route list.
 */
export function loadRouteInventory(path: string = ROUTES_INVENTORY_PATH): RouteInventoryRow[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (parsed?.family !== "routes" || !Array.isArray(parsed?.rows) || parsed.rows.length === 0) {
    throw new InvariantViolationError(
      `route inventory ${path} is not a non-empty {family:"routes", rows:[...]} envelope (issue #4638)`,
    );
  }
  for (const row of parsed.rows) {
    if (typeof row?.method !== "string" || typeof row?.path !== "string" || !Array.isArray(row?.consumers)) {
      throw new InvariantViolationError(
        `route inventory ${path} has a row without method/path/consumers: ${JSON.stringify(row)} (issue #4638)`,
      );
    }
  }
  return parsed.rows.map((row: RouteInventoryRow) => ({
    method: row.method,
    path: row.path,
    consumers: row.consumers,
  }));
}

/** The `"<METHOD> <path>"` key every set below uses (the inventory's own listing form). */
export function routeKey(row: { method: string; path: string }): string {
  return `${row.method} ${row.path}`;
}

export function isWriteMethod(method: string): boolean {
  return method !== "GET";
}

// ---------------------------------------------------------------------------
// Rung 1 — write routes (ADR-0034 §9.1)
// ---------------------------------------------------------------------------

/**
 * Write routes with no dashboard control by design: lifecycle records, metric
 * ingestion, webhooks, CI gates, the 60 s merge lock, and `PUT config` (a
 * browser edit would dirty the prod checkout and trip the deploy guard —
 * §9.1). Value = why, naming the caller.
 */
export const MACHINE_WRITES: Readonly<Record<string, string>> = Object.freeze({
  "POST /api/webhooks/sentry": "Sentry's outbound webhook (external) — alert ingestion",
  "POST /api/autopilot/cycle-record": "scripts/autopilot/dispatch.sh + hydra-target-build merge flow — cycle lifecycle record",
  "POST /api/metrics/record": "scripts/autopilot/reap.py + bin/hydra — cycle-metrics ingestion",
  "POST /api/autopilot/reflection-record": "scripts/autopilot/reap.py — reflection lifecycle record",
  "POST /api/autopilot/run-start": "scripts/autopilot/bootstrap.sh — run lifecycle record",
  "POST /api/autopilot/run-end": "scripts/autopilot/decide.py + hydra-autopilot playbook — run lifecycle record",
  "POST /api/autopilot/run-tally": "scripts/autopilot/reap.py + drain.sh — run lifecycle record",
  "POST /api/autopilot/turn": "scripts/autopilot/heartbeat.py + turn.sh — turn lifecycle record",
  "POST /api/builder-health/scope-violation": "scripts/ci/scope-check.ts — CI gate record",
  "POST /api/builder-health/dispatch-pr": "holdback-merge-watch chore — dispatch→PR link record",
  "POST /api/capacity/orchestrator-merge": "scripts/autopilot/dispatch.sh — capacity-floor merge record",
  "PUT /api/config/:section/:name":
    "agent skills (hydra-architect, hydra-discover, hydra-research) — never a browser control: an edit dirties the prod checkout and trips the deploy guard (ADR-0034 §9.1, ADR-0012)",
  "POST /api/cycle/register": "hydra-target-build playbook — cycle lifecycle record",
  "POST /api/cycle/complete": "hydra-target-build merge flow — cycle lifecycle record",
  "POST /api/design-concepts/exempt-log": ".github/workflows/design-concept-comment.yml — CI gate record",
  "POST /api/design-concepts": "hydra-grill via scripts/autopilot/grill-artifact.sh — artifact write",
  "POST /api/dispatches/subagent": "SessionStart / SubagentTool hooks + decide.py — dispatch registration",
  "PATCH /api/dispatches/subagent/:sessionId/current-step":
    "dispatch-registry step stamp; no in-repo caller found at #4638 classification — retirement candidate (outside the five writes §9.1 retires)",
  "POST /api/events/publish": "hydra-digest + hydra-target-build playbooks — event-bus publish",
  "POST /api/holdback/check": "hydra-qa playbook — Outcome Holdback check",
  "POST /api/holdback/revert-failed": "hydra-qa playbook — Outcome Holdback revert",
  "POST /api/holdback/pending": "hydra-autopilot phase-6 ops + hydra-doctor — holdback registry",
  "POST /api/merge/lock": "hydra-incident + hydra-target-incident — the 60 s cycle merge lock (ADR-0034 §9.1)",
  "POST /api/merge/unlock": "hydra-incident + hydra-target-incident + bin/hydra — the 60 s cycle merge lock (ADR-0034 §9.1)",
  "POST /api/metrics/tokens": "scripts/autopilot/reap.py — token-metric ingestion",
  "POST /api/memory/:agent/pattern": "hydra-incident playbook — pattern-memory write",
  "POST /api/memory/subagent-lesson": "hydra-dev / hydra-qa / hydra-target-build — pattern-memory write",
  "POST /api/memory/subagent-friction": "hydra-dev / hydra-target-build — pattern-memory write",
  "POST /api/usage/session-block": "scripts/autopilot/bootstrap.sh + hydra-autopilot dispatch reference — usage gate",
  "POST /api/usage/dispatch-cost": "scripts/autopilot/reap.py — cost ingestion",
  "POST /api/operator-channel/brief/send":
    "send-the-Morning-Brief-now; the brief scheduler (src/operator-channel/brief-scheduler.ts) owns sends. #5047 replaced §9.1's digest send + heartbeat rows with this single route, which has no dashboard control and none is planned (issue #4638 decision)",
});

/**
 * Write routes deleted under ADR-0024 §3 (ADR-0034 §9.1). Each must stay
 * ABSENT from the inventory.
 */
export const RETIRED_WRITES: Readonly<Record<string, string>> = Object.freeze({
  "POST /api/kill": "wrote a `.kill` file that stopped nothing — the emergency brake is the real stop",
  "PUT /api/env/:project": "zero callers; 401 on every request on this host",
  "DELETE /api/env/:project/:key": "zero callers; 401 on every request on this host",
  "POST /api/research/start": "a disabled no-op responder since #342 — research is the /hydra-target-research skill",
  "POST /api/calibration/outcomes/sync": "zero callers — a pass-through proxy to the Target",
});

/** One human-shaped write whose dashboard control exists but is not yet registry-keyed. */
export interface PendingControlWrite {
  /** The issue/PR (or ADR clause) that owns registering it. */
  ref: string;
  /** Where the page-local control lives today, and what blocks registering it. */
  reason: string;
}

/**
 * SHRINK-ONLY allowance: human-shaped writes whose control renders today but
 * whose `control:<page>/<name>` registry entry has not landed yet. An entry
 * here counts as classified; the moment its registry entry lands the route is
 * in TWO sets and the exactly-one pin reddens, so the registering PR deletes
 * the entry here — emptied by deletion, never restructured. The parity test
 * pins these keys to a fixed ceiling, so the allowance can never grow.
 */
export const PENDING_CONTROL_WRITES: Readonly<Record<string, PendingControlWrite>> = Object.freeze({
  "POST /api/now/recommendations/:id/dismiss": {
    ref: "#5152",
    reason: "page-local control in dashboard/src/pages/now-console/RecommendationsPanel.jsx; #5152 registers control:now/rec-dismiss",
  },
  "POST /api/now/recommendations/mute-class": {
    ref: "#5152",
    reason: "page-local control in dashboard/src/pages/now-console/RecommendationsPanel.jsx; #5152 registers control:now/rec-mute-class",
  },
  "POST /api/holdback/enroll": {
    ref: "#4633 INV-10 deferral",
    reason:
      "failed-state 'Enrol now' control is page-local in dashboard/src/components/pages/work/HoldbackEnrolState.jsx; registering it needs a body-template mechanism in ActionAffordance first (also called by the hydra-qa playbook)",
  },
  "POST /api/attention/:id/dismiss": {
    ref: "ADR-0034 §8.4 (no follow-up filed)",
    reason:
      "the typed one-click dismiss on every Today feed row (dashboard/src/components/pages/today/AttentionFeed.jsx) — feed grammar, not a registry Action; no control:<page>/<name> key exists for it yet",
  },
  "POST /api/alerts/:id/dismiss": {
    ref: "#4631 (PR #5157)",
    reason: "#4631 registers control:health/alert-dismiss and wires it on /health",
  },
  "POST /api/alerts/dismiss-all": {
    ref: "#4631 (PR #5157)",
    reason: "#4631 registers control:health/alerts-dismiss-all and wires it on /health (also called by bin/hydra)",
  },
  "POST /api/scheduler/stop": {
    ref: "#4631 (PR #5157)",
    reason: "#4631 registers control:health/scheduler-stop and wires it on /health (also called by bin/hydra + the watchdog)",
  },
  "POST /api/maintenance/housekeeping": {
    ref: "#4631 (PR #5157)",
    reason: "#4631 registers control:health/housekeeping and wires it on /health (also called by scripts/deploy.sh + housekeeping.sh)",
  },
});

// ---------------------------------------------------------------------------
// Rung 4 — read routes (ADR-0034 §9.4)
// ---------------------------------------------------------------------------

/**
 * GET → the dashboard file that reads it (a page shell or a component — the
 * #4630/#4634 pattern). The parity test asserts the file contains the path
 * literal ({@link routeLiteralPattern}).
 */
export const HOMED_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /api/alerts": "dashboard/src/components/pages/health/AlertsPanel.jsx",
  "GET /api/architecture": "dashboard/src/components/pages/builder/TangledModules.jsx",
  "GET /api/attention/feed": "dashboard/src/components/pages/today/AttentionFeed.jsx",
  "GET /api/attention/counts": "dashboard/src/components/pages/builder/FeedCalibration.jsx",
  "GET /api/attribution": "dashboard/src/pages/Runs.jsx",
  "GET /api/attribution/impact": "dashboard/src/components/pages/builder/ImpactRanking.jsx",
  "GET /api/autopilot/board-state": "dashboard/src/components/pages/work/BoardState.jsx",
  "GET /api/autopilot/work-queue": "dashboard/src/components/pages/work/BoardState.jsx",
  "GET /api/autopilot/hitl-grill": "dashboard/src/components/pages/work/HitlGrillLane.jsx",
  "GET /api/autopilot/paused": "dashboard/src/pages/now-console/NowConsole.jsx",
  "GET /api/autopilot/idle-diagnostics": "dashboard/src/pages/now-console/StatusStrip.jsx",
  "GET /api/autopilot/runs/:runId/log": "dashboard/src/components/LogsSection.jsx",
  "GET /api/autopilot/runs/:runId/journal": "dashboard/src/components/LogsSection.jsx",
  "GET /api/autopilot/runs": "dashboard/src/components/pages/runs/RunsList.jsx",
  "GET /api/autopilot/inflight-slots": "dashboard/src/pages/now-console/StatusStrip.jsx",
  "GET /api/autopilot/runs/current": "dashboard/src/pages/now-console/NowConsole.jsx",
  "GET /api/autopilot/runs/:runId/retro": "dashboard/src/components/pages/runs/RunRetroBundle.jsx",
  "GET /api/autopilot/retros": "dashboard/src/pages/now-console/RetroPanel.jsx",
  "GET /api/autopilot/runs/:runId": "dashboard/src/pages/now-console/RunDetailDrawer.jsx",
  "GET /api/builder-health": "dashboard/src/components/pages/outcomes/BuilderHealth.jsx",
  "GET /api/capacity": "dashboard/src/pages/Health.jsx",
  "GET /api/autopilot/class-state": "dashboard/src/components/pages/work/ClassStatePanel.jsx",
  "GET /api/autopilot/class-stats": "dashboard/src/components/pages/builder/ClassYield.jsx",
  "GET /api/design-concepts/snapshots": "dashboard/src/components/pages/builder/DesignConceptGreenLight.jsx",
  "GET /api/dispatches/:dispatchId/transcript": "dashboard/src/pages/DispatchTranscript.jsx",
  "GET /api/explore/friction": "dashboard/src/components/pages/runs/FrictionPanel.jsx",
  "GET /api/explore/behavior": "dashboard/src/components/pages/runs/BehaviorGallery.jsx",
  // The inventory records no consumer for this one: LessonsTab builds the
  // path in a helper rather than as a call's literal first argument. The
  // literal is still in the file, which is what this pin checks.
  "GET /api/explore/lessons": "dashboard/src/components/pages/explore/LessonsTab.jsx",
  "GET /api/health": "dashboard/src/pages/Health.jsx",
  "GET /api/health/deep": "dashboard/src/pages/Health.jsx",
  "GET /api/metrics/cost": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/metrics/cost-by-class": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/metrics/cost-per-merged-pr": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/metrics/cost-efficiency": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/metrics/cost-by-outcome": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/metrics/quality-gates": "dashboard/src/components/pages/builder/QualityGates.jsx",
  "GET /api/metrics/anchor-distribution": "dashboard/src/components/pages/work/AnchorRationale.jsx",
  "GET /api/metrics/unclassified": "dashboard/src/components/pages/builder/UnclassifiedResidue.jsx",
  "GET /api/now/service-strip": "dashboard/src/components/pages/health/ServiceStrip.jsx",
  "GET /api/now/autopilot-tick": "dashboard/src/pages/now-console/NowConsole.jsx",
  "GET /api/now/active-dispatches": "dashboard/src/pages/Runs.jsx",
  "GET /api/now/cost-burn": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/now/autopilot-health": "dashboard/src/pages/now-console/StuckSignals.jsx",
  "GET /api/now/recommendations": "dashboard/src/pages/now-console/RecommendationsPanel.jsx",
  "GET /api/operator-actions": "dashboard/src/components/pages/work/ClassStatePanel.jsx",
  "GET /api/operator-channel/delivery-health": "dashboard/src/pages/Health.jsx",
  "GET /api/outcomes/trends": "dashboard/src/components/pages/outcomes/OutcomeCards.jsx",
  "GET /api/outcomes/lessons": "dashboard/src/components/pages/outcomes/LessonsTrend.jsx",
  "GET /api/outcomes/quota": "dashboard/src/components/pages/health/CostPanel.jsx",
  "GET /api/outcomes": "dashboard/src/components/pages/builder/DeclaredOutcomes.jsx",
  "GET /api/learning/friction-patterns": "dashboard/src/components/pages/runs/FrictionPanel.jsx",
  "GET /api/scheduler/status": "dashboard/src/components/pages/health/ServiceStrip.jsx",
  "GET /api/taxonomy/classes": "dashboard/src/hooks/useTaxonomy.js",
  "GET /api/today/summary": "dashboard/src/pages/Today.jsx",
  "GET /api/today/stuck": "dashboard/src/components/pages/today/StuckItems.jsx",
  "GET /api/today/merges": "dashboard/src/components/pages/today/RecentMerges.jsx",
  "GET /api/today/findings": "dashboard/src/components/pages/today/NewTargetFindings.jsx",
  "GET /api/today/lessons-overnight": "dashboard/src/components/pages/today/LessonsOvernight.jsx",
  "GET /api/usage": "dashboard/src/pages/Today.jsx",
  "GET /api/usage/eligibility": "dashboard/src/pages/now-console/UsagePanel.jsx",
  "GET /api/versions": "dashboard/src/components/Versions.jsx",
});

/** GETs with no dashboard consumer but a live non-dashboard caller. Value = the caller. */
export const MACHINE_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /api/agents/stream":
    "no in-repo caller found at #4638 classification (decide.py only stamps the branch a stream view would scope by) — retirement candidate (outside the eleven reads §9.4 retires)",
  "GET /api/autopilot/emergency-brake": "scripts/autopilot/decide.py + bin/hydra — brake gate read",
  "GET /api/autopilot/slot-events": "hydra-autopilot ops reference — slot-event diagnostics",
  "GET /api/config/:section":
    "no in-repo caller found at #4638 classification (skills read single files via /config/:section/:name) — retirement candidate (outside the eleven reads §9.4 retires)",
  "GET /api/config/:section/:name": "agent skills (hydra-architect, hydra-discover, hydra-research, hydra-target-build)",
  "GET /api/cycle/status": "bin/hydra + scripts/hydra-watchdog.sh",
  "GET /api/cycle/history": "scripts/autopilot/dispatch.sh + reap.py + bin/hydra",
  "GET /api/cycle/report/:cycleId":
    "no in-repo caller found at #4638 classification — retirement candidate (outside the eleven reads §9.4 retires)",
  "GET /api/design-concepts/exempt-log": ".github/workflows/design-concept-comment.yml",
  "GET /api/design-concepts": "hydra-grill via scripts/autopilot/grill-artifact.sh",
  "GET /api/design-concepts/:anchorRef/resolve": "hydra-qa playbook",
  "GET /api/design-concepts/:anchorRef":
    "hydra-dev / hydra-grill / hydra-qa playbooks + .github/workflows/design-concept-comment.yml",
  "GET /api/events/:stream": "hydra-digest + hydra-target-build playbooks",
  "GET /api/goals": "hydra-architect + hydra-target-research playbooks",
  "GET /api/holdback/enrolments": "holdback-merge-watch tooling (src/redis/holdback-merge-watch.ts documents the read)",
  "GET /api/learning/context-trace": "hydra-dev child flow + hydra-target-build playbooks",
  "GET /api/metrics": "hydra-discover + hydra-autopilot phase-6 ops + hydra-target-build merge flow",
  "GET /api/metrics/cascade-routing": "scripts/autopilot/dispatch.sh + reap.py + reflection-deposit.sh",
  "GET /api/metrics/instrumentation":
    "no in-repo caller found at #4638 classification — retirement candidate (outside the eleven reads §9.4 retires)",
  "GET /api/metrics/session-tokens": "scripts/autopilot/reap.py",
  "GET /api/observability/config":
    "no in-repo caller found at #4638 classification — retirement candidate (outside the eleven reads §9.4 retires)",
  "GET /api/memory/:agent": "hydra-dev / hydra-qa / hydra-target-build playbooks",
  "GET /api/learning/ineffective-rules": "the architecture-review direction doc names it as the operator read for promoted-rule effectiveness",
  "GET /api/recommendations": "bin/hydra (documented public endpoint)",
  "GET /api/reflections": "hydra-dev child flow + hydra-target-build playbooks (the live reflection injection path)",
  "GET /api/scout/stats": "hydra-tool-scout playbook + hydra-autopilot class wiring",
  "GET /api/scout/dispatches": "hydra-tool-scout playbook",
  "GET /api/scout/alert-plan": "hydra-tool-scout playbook + decide_selectors/scout.py",
  "GET /api/tier": "hydra-dev / hydra-epic-sprint / hydra-architecture-scan playbooks",
  "GET /api/today/decision-queue":
    "no in-repo caller found at #4638 classification (the overnight decision queue was retired by #4445) — retirement candidate (outside the eleven reads §9.4 retires)",
  "GET /api/usage/by-issue": "scripts/autopilot/reap.py + scripts/glm-beachhead-report.sh",
});

/**
 * GETs deleted under ADR-0024 §3 (ADR-0034 §9.4 — the eleven). Each must stay
 * ABSENT from the inventory.
 */
export const RETIRED_READS: Readonly<Record<string, string>> = Object.freeze({
  "GET /api/env/:project": "zero callers; 401 on every request on this host",
  "GET /api/calibration/outcomes": "zero callers — a pass-through proxy to the Target",
  "GET /api/summary": "zero callers — a text/plain summary superseded by the dashboard",
  "GET /api/goals/summary": "zero callers — the prompt-format goals summary",
  "GET /api/grounding/latest": "zero callers",
  "GET /api/observability/trace-url": "zero callers",
  "GET /api/metrics/grounding-duration": "zero callers",
  "GET /api/learning/rule-action-log": "zero callers",
  "GET /api/learning/reflection-health":
    "zero callers — route only; projectReflectionHealth stays for GET /api/health/deep",
  "GET /api/now/alerts": "zero callers — /health reads GET /api/alerts",
  "GET /api/metrics/abandonment": "zero callers",
});

// ---------------------------------------------------------------------------
// Rung 3 — playbooks (ADR-0034 §9.3)
// ---------------------------------------------------------------------------

/**
 * Playbooks (docs/operator-playbooks/<name>.md) that are neither a `class:`
 * entry nor referenced by a registry action. They are reached through `/docs`
 * (§10). Value = why no registry action fits.
 */
export const DOCS_ONLY: Readonly<Record<string, string>> = Object.freeze({
  "hydra-architect": "operator-invoked strategic review; not a dispatch class, no feed line recommends it",
  "hydra-auto-merge-window": "dormant campaign tool the operator opens for a labelled batch; no live state to act on",
  "hydra-autopilot": "the decision loop itself — every class: entry is one of its dispatches",
  "hydra-branch-prune": "periodic local hygiene (stale branches/worktrees); nothing on a page triggers it",
  "hydra-digest": "on-demand activity summary; the dashboard pages are the live view",
  "hydra-epic-close": "post-merge-wave epic sweep; no admission line names it",
  "hydra-epic-sprint": "operator-attended in-session epic driver (ADR-0044); started by hand, never recommended",
  "hydra-incident": "triggered by a regression/crash, not by a feed row; the brake and pause controls cover the stop",
  "hydra-pr-rebase": "merge-queue hygiene the operator runs after a master move; no admission line names it",
  "hydra-prd": "demoted renderer library called by hydra-tickets (ADR-0030); never run by hand",
  "hydra-research": "orchestrator-self research the operator starts by hand; not a dispatch class",
  "hydra-target-incident": "Target sibling of hydra-incident — triggered by a Target regression, not a feed row",
  "hydra-target-retro": "Target retrospective the operator or a cadence starts; no admission line names it",
  "hydra-wayfinder": "interactive planning for a large initiative; operator-driven, not an autopilot class",
  "thermo-nuclear-code-quality-review": "operator-invoked full-repo review for ideation; never recommended by a row",
  "zoom-out": "a conversational prompt for broader context; carries no action",
});

// ---------------------------------------------------------------------------
// Pure helpers the parity test drives
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Resolve a registry `in-dashboard` route (`/alerts/{id}/dismiss`,
 * `/design-concepts/issue-{number}/approve`) to the inventory row it fires.
 * A registry segment carrying a `{placeholder}` matches a `:param` inventory
 * segment; every other segment must be equal. Returns the row key, or null
 * when no inventory row matches (a dangling registry route).
 */
export function resolveRegistryRoute(
  method: string,
  route: string,
  rows: readonly RouteInventoryRow[],
): string | null {
  const want = segments(`/api${route}`);
  for (const row of rows) {
    if (row.method !== method) continue;
    const have = segments(row.path);
    if (have.length !== want.length) continue;
    const ok = have.every((seg, i) =>
      seg.startsWith(":") ? /\{[A-Za-z0-9_]+\}/.test(want[i]) || want[i].startsWith(":") : seg === want[i],
    );
    if (ok) return routeKey(row);
  }
  return null;
}

/**
 * Every `in-dashboard` action in the registry (recommended or alternative),
 * resolved to an inventory key. `dangling` lists registry routes no inventory
 * row matches.
 */
export function registryWriteRoutes(
  registry: readonly OperatorActionEntry[],
  rows: readonly RouteInventoryRow[],
): { keys: Set<string>; dangling: string[] } {
  const keys = new Set<string>();
  const dangling: string[] = [];
  for (const entry of registry) {
    for (const action of [entry.recommended, ...entry.alternatives]) {
      if (action.kind !== "in-dashboard") continue;
      const key = resolveRegistryRoute(action.method, action.route, rows);
      if (key === null) dangling.push(`${entry.key}: ${action.method} ${action.route}`);
      else keys.add(key);
    }
  }
  return { keys, dangling: [...new Set(dangling)].sort() };
}

/** One partition's verdict: a route in none of the sets, in several, or a set entry the inventory lacks. */
export interface PartitionReport {
  unclassified: string[];
  multiplyClassified: { key: string; sets: string[] }[];
  /** A live-set entry (machine/homed/pending) whose route is absent from the inventory. */
  stale: { set: string; key: string }[];
  /** A RETIRED entry whose route is back in the inventory. */
  retiredPresent: string[];
}

/**
 * Pure partition check. `live` sets must each name only inventory routes;
 * `retired` must name none. Every inventory route selected by `select` must
 * land in exactly one live set.
 */
export function partitionRoutes(
  rows: readonly RouteInventoryRow[],
  select: (row: RouteInventoryRow) => boolean,
  live: Record<string, ReadonlySet<string>>,
  retired: ReadonlySet<string>,
): PartitionReport {
  const inventory = new Set(rows.filter(select).map(routeKey));
  const report: PartitionReport = { unclassified: [], multiplyClassified: [], stale: [], retiredPresent: [] };
  for (const key of [...inventory].sort()) {
    const sets = Object.entries(live)
      .filter(([, members]) => members.has(key))
      .map(([name]) => name);
    if (sets.length === 0 && !retired.has(key)) report.unclassified.push(key); // a returning retired route reports as retiredPresent
    else if (sets.length > 1) report.multiplyClassified.push({ key, sets });
  }
  for (const [name, members] of Object.entries(live)) {
    for (const key of [...members].sort()) {
      if (!inventory.has(key)) report.stale.push({ set: name, key });
    }
  }
  const everyRoute = new Set(rows.map(routeKey));
  report.retiredPresent = [...retired].filter((key) => everyRoute.has(key)).sort();
  return report;
}

/** Rung 1 over the shipped sets. */
export function writeParity(
  rows: readonly RouteInventoryRow[],
  registry: readonly OperatorActionEntry[],
  sets: {
    machine?: Readonly<Record<string, unknown>>;
    pending?: Readonly<Record<string, unknown>>;
    retired?: Readonly<Record<string, unknown>>;
  } = {},
): PartitionReport & { dangling: string[] } {
  const { keys, dangling } = registryWriteRoutes(registry, rows);
  const report = partitionRoutes(
    rows,
    (row) => isWriteMethod(row.method),
    {
      registry: keys,
      MACHINE_WRITES: new Set(Object.keys(sets.machine ?? MACHINE_WRITES)),
      PENDING_CONTROL_WRITES: new Set(Object.keys(sets.pending ?? PENDING_CONTROL_WRITES)),
    },
    new Set(Object.keys(sets.retired ?? RETIRED_WRITES)),
  );
  return { ...report, dangling };
}

/** Rung 4 over the shipped sets. */
export function readParity(
  rows: readonly RouteInventoryRow[],
  sets: {
    homed?: Readonly<Record<string, unknown>>;
    machine?: Readonly<Record<string, unknown>>;
    retired?: Readonly<Record<string, unknown>>;
  } = {},
): PartitionReport {
  return partitionRoutes(
    rows,
    (row) => !isWriteMethod(row.method),
    {
      HOMED_READS: new Set(Object.keys(sets.homed ?? HOMED_READS)),
      MACHINE_READS: new Set(Object.keys(sets.machine ?? MACHINE_READS)),
    },
    new Set(Object.keys(sets.retired ?? RETIRED_READS)),
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The call-literal pattern for a KNOWN inventory path, normalised the way the
 * inventory records consumers (scripts/docs/inventories/routes.ts): the
 * literal opens with a quote or backtick, may carry `${API_BASE}` and/or the
 * `/api` prefix, and each `:param` segment may appear as a `${…}` template
 * hole or as the `:param` text itself. It must end at a quote, backtick or
 * `?query` so `/metrics` never matches inside `/metrics/cost`.
 */
export function routeLiteralPattern(path: string): RegExp {
  const body = segments(path.replace(/^\/api(?=\/)/, ""))
    .map((seg) => (seg.startsWith(":") ? "(?:\\$\\{[^}]*\\}|:[A-Za-z0-9_]+)" : escapeRegex(seg)))
    .join("/");
  return new RegExp(`["'\`](?:\\$\\{API_BASE\\})?(?:/api)?/${body}(?=["'\`?])`);
}

/** HOMED_READS entries whose owning file is missing or lacks the path literal. */
export function homedReadMisses(
  homed: Readonly<Record<string, string>>,
  readSource: (file: string) => string | null,
): { key: string; file: string; why: "missing-file" | "no-literal" }[] {
  const out: { key: string; file: string; why: "missing-file" | "no-literal" }[] = [];
  for (const [key, file] of Object.entries(homed)) {
    const source = readSource(file);
    if (source === null) {
      out.push({ key, file, why: "missing-file" });
      continue;
    }
    const path = key.slice(key.indexOf(" ") + 1);
    if (!routeLiteralPattern(path).test(source)) out.push({ key, file, why: "no-literal" });
  }
  return out;
}

/** The skill a `class:` entry's recommended terminal command runs (`/hydra-dev …` → `hydra-dev`). */
function skillOfCommand(command: string): string | null {
  const m = command.match(/^\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

/**
 * Rung 3: playbooks neither a `class:` entry, nor referenced by a registry
 * action (a terminal-skill command naming `/<playbook>`), nor in DOCS_ONLY —
 * plus DOCS_ONLY entries that are redundant (also covered) or name no playbook.
 */
export function playbookCoverage(
  playbooks: readonly string[],
  registry: readonly OperatorActionEntry[],
  docsOnly: Readonly<Record<string, string>> = DOCS_ONLY,
): { uncovered: string[]; redundantDocsOnly: string[]; unknownDocsOnly: string[] } {
  const classSkills = new Set<string>();
  const referenced = new Set<string>();
  for (const entry of registry) {
    if (entry.key.startsWith("class:") && entry.recommended.kind === "terminal-skill") {
      const skill = skillOfCommand(entry.recommended.command);
      if (skill) classSkills.add(skill);
    }
    for (const action of [entry.recommended, ...entry.alternatives]) {
      if (action.kind !== "terminal-skill") continue;
      for (const m of action.command.matchAll(/(?:^|\s)\/([a-z0-9-]+)/g)) referenced.add(m[1]);
    }
  }
  const covered = (name: string) => classSkills.has(name) || referenced.has(name);
  const known = new Set(playbooks);
  return {
    uncovered: playbooks.filter((name) => !covered(name) && !(name in docsOnly)).sort(),
    redundantDocsOnly: Object.keys(docsOnly).filter((name) => covered(name)).sort(),
    unknownDocsOnly: Object.keys(docsOnly).filter((name) => !known.has(name)).sort(),
  };
}
