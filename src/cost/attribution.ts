/**
 * attribution.ts — Pure aggregation logic for /api/metrics/cost-attribution
 *
 * Issue #271: cost-per-merge regressed from $2.21 to $11.68 (5.3x). We need
 * to attribute spend to agent role, model tier, anchor type, and complexity
 * so operators can identify which gate or agent is driving the regression.
 *
 * This module is intentionally a pure-functional layer over already-stored
 * Redis data:
 *   - cycle agent-run entries  (hydra:cycle:<id>:agents — RPUSH of JSON)
 *   - cycle metrics hash       (hydra:metrics:<id> — anchorType, complexity,
 *                               taskTitle, plannerModel, executorModel, …)
 *
 * No Redis access here — callers pass in the parsed entries. This keeps the
 * aggregation logic testable without mocking ioredis (see test/cost-attribution.test.mts).
 */

// ---------------------------------------------------------------------------
// Types — kept loose since cycle metrics is a free-form key/value bag
// ---------------------------------------------------------------------------

export interface AgentRun {
  agent: string;        // "planner" | "executor" | "fixer" | "skeptic" | "jit-tester"
  task?: string;
  duration?: number;
  verdict?: string;
  costUsd?: number;
  model?: string;       // optional — added by issue #271; back-compat fallback uses agentRoleToTier()
  timestamp?: string;
}

export interface CycleSummary {
  cycleId: string;
  taskTitle?: string;
  anchorType?: string;
  complexity?: string;
  tasksMerged?: number;
  tasksFailed?: number;
  tasksAbandoned?: number;
  plannerModel?: string;
  executorModel?: string;
  agentRuns: AgentRun[];
}

export interface CostAttributionResult {
  windowCycles: number;
  totalCostUsd: number;
  mergedCycles: number;
  failedCycles: number;
  abandonedCycles: number;
  noWorkCycles: number;
  costPerMerge: number | null;
  byRole: Array<{ role: string; costUsd: number; pct: number; runs: number }>;
  byTier: Array<{ tier: string; costUsd: number; pct: number; runs: number }>;
  byAnchorType: Array<{ anchorType: string; costUsd: number; pct: number; cycles: number }>;
  byComplexity: Array<{ complexity: string; costUsd: number; pct: number; cycles: number; mergedCycles: number; costPerMerge: number | null }>;
  byOutcome: Array<{ outcome: string; costUsd: number; pct: number; cycles: number }>;
  top5ExpensiveCycles: Array<{
    cycleId: string;
    taskTitle: string;
    totalCostUsd: number;
    outcome: string;
    roleBreakdown: Array<{ role: string; costUsd: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// Role/model -> tier mapping
// ---------------------------------------------------------------------------

/**
 * Authoritative model-name -> tier table. Mirrors `MODEL_PRICING` in
 * `src/llm/pricing.ts`. Keep in sync when adding a new model id to the
 * routing table — otherwise its spend lands in `byTier` as "unknown"
 * and the cost-attribution dashboard becomes unreliable (issue #303:
 * 38-48% of runs were classified "unknown" because the planner was
 * bumped to `gpt-5.5` but `modelToTier` only matched 5.4).
 */
const MODEL_NAME_TO_TIER: Record<string, string> = {
  // Frontier — planner default
  "gpt-5.5":             "frontier",
  "gpt-5.4":             "frontier",
  // Codex — executor / fixer / JIT tester / quick-fix planner
  "gpt-5.3-codex":       "codex",
  "gpt-5.3-codex-spark": "codex",   // "rapid" tier + cost-cap fallback for frontier
  // Mini — meta / classification / adversarial / high-risk review
  "gpt-5.4-mini":        "mini",
  // Local — Ollama fallback (tracked as mini for cost-tier purposes since spend = 0)
  "gemma-4-26b":         "mini",
};

/** Tier aliases the runner accepts (`"frontier"`, `"codex"`, etc.) plus a
 * couple of book-keeping values that `logAgentRun` can emit. */
const TIER_ALIAS_TO_TIER: Record<string, string> = {
  frontier: "frontier",
  codex: "codex",
  rapid: "codex",         // "rapid" -> gpt-5.3-codex-spark -> codex tier
  mini: "mini",
  local: "mini",          // free Ollama path
  nano: "mini",           // legacy alias from an earlier draft
  cache: "frontier",      // cache hit on a planner call (model unknown but tier is the planner's)
};

/**
 * Map model string -> tier label. Accepts either a raw model name
 * (`"gpt-5.5"`, `"gpt-5.3-codex-spark"`) or a tier alias (`"frontier"`,
 * `"codex"`, `"mini"`). Unknown / missing values fall back to `"unknown"`
 * — but every model id used by the autopilot subagents should be
 * enumerated above (see `src/llm/pricing.ts` for the authoritative
 * pricing table), so seeing "unknown" in production is a regression
 * worth fixing.
 */
export function modelToTier(model: string | undefined | null): string {
  if (!model) return "unknown";
  const raw = String(model);
  const lower = raw.toLowerCase();

  // Exact match against the authoritative tables first
  if (MODEL_NAME_TO_TIER[raw]) return MODEL_NAME_TO_TIER[raw];
  if (MODEL_NAME_TO_TIER[lower]) return MODEL_NAME_TO_TIER[lower];
  if (TIER_ALIAS_TO_TIER[lower]) return TIER_ALIAS_TO_TIER[lower];

  // Substring fallbacks — kept narrow so a future "gpt-6" doesn't silently
  // get bucketed; loud "unknown" forces an explicit table update.
  if (lower.includes("mini") || lower.includes("nano")) return "mini";
  if (lower.includes("codex")) return "codex";

  return "unknown";
}

/**
 * Static fallback when an agent-run entry has no `model` field (older
 * Redis data predates the per-run model field added in #271). Picks the
 * typical tier for each agent role per CLAUDE.md "Model Tiers".
 *
 * Issue #303: research roles ("director", "domain-researcher", …) were
 * absent and any non-standard role string fell through to "unknown".
 * Research agents run on `model: "frontier"` (see `src/research-loop.ts`)
 * so they map to frontier here too.
 */
const AGENT_ROLE_TO_TIER: Record<string, string> = {
  // Planner — quick-fix overrides via run.model -> codex
  planner: "frontier",

  // Legacy roles: the in-process codex executor / fixer / JIT tester
  // were deleted in PR-3 (issue #383), but agent-run records from before
  // the cut still live in Redis and must continue to attribute against
  // the right tier so the cost-attribution dashboard stays accurate for
  // historical windows. Remove these entries once the retention window
  // for agent runs has rolled past the cut-over date.
  executor: "codex",
  fixer: "codex",
  "jit-tester": "codex",

  // Skeptic / high-risk-review / adversarial / meta — mini-model
  skeptic: "mini",
  meta: "mini",
  adversarial: "mini",
  "high-risk-reviewer": "mini",

  // Research loop (see src/research-loop.ts — all spawn with model: "frontier")
  director: "frontier",
  "research-director": "frontier",
  "domain-researcher": "frontier",
  "technical-researcher": "frontier",
  "market-researcher": "frontier",
  "research-strategist": "frontier",
  strategist: "frontier",
};

export function agentRoleToTier(role: string): string {
  const hit = AGENT_ROLE_TO_TIER[role];
  if (hit) return hit;

  // Soft fallback for unanticipated role strings: research-* / *-researcher
  // are always frontier (see research-loop.ts). Keeping this as a regex
  // fallback means a new researcher variant in config/research/ doesn't
  // immediately drop into "unknown".
  if (/^research-/.test(role) || /-researcher$/.test(role)) return "frontier";
  if (/-reviewer$/.test(role)) return "codex";

  return "unknown";
}

/**
 * Exported for regression-test enumeration — every role string emitted by
 * `logAgentRun` call sites in `src/` should appear here and map to a
 * non-`"unknown"` tier. See `test/cost-attribution.test.mts`.
 */
export const KNOWN_AGENT_ROLES = Object.freeze(Object.keys(AGENT_ROLE_TO_TIER));

// ---------------------------------------------------------------------------
// Outcome derivation
// ---------------------------------------------------------------------------

/**
 * Derive a single-word outcome label from cycle metrics. Mirrors the
 * categories the dashboard already exposes: merge / failure / abandoned /
 * noWork.
 */
export function deriveOutcome(c: CycleSummary): "merge" | "failure" | "abandoned" | "noWork" {
  if ((c.tasksMerged ?? 0) > 0) return "merge";
  if ((c.tasksFailed ?? 0) > 0) return "failure";
  if ((c.tasksAbandoned ?? 0) > 0) return "abandoned";
  return "noWork";
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate cost across a window of cycle summaries.
 *
 * Pure function — no Redis, no I/O. Callers fetch raw data and feed it in,
 * which is what makes this trivially testable on fixture data.
 */
export function aggregateCostAttribution(cycles: CycleSummary[]): CostAttributionResult {
  const roleTotals = new Map<string, { costUsd: number; runs: number }>();
  const tierTotals = new Map<string, { costUsd: number; runs: number }>();
  const anchorTotals = new Map<string, { costUsd: number; cycles: number }>();
  const complexityTotals = new Map<string, { costUsd: number; cycles: number; mergedCycles: number }>();
  const outcomeTotals = new Map<string, { costUsd: number; cycles: number }>();

  let totalCostUsd = 0;
  let mergedCycles = 0;
  let failedCycles = 0;
  let abandonedCycles = 0;
  let noWorkCycles = 0;

  const cyclesWithCost: Array<{
    cycleId: string;
    taskTitle: string;
    totalCostUsd: number;
    outcome: string;
    roleBreakdown: Map<string, number>;
  }> = [];

  for (const c of cycles) {
    let cycleCost = 0;
    const cycleRoleBreakdown = new Map<string, number>();
    const outcome = deriveOutcome(c);

    if (outcome === "merge") mergedCycles++;
    else if (outcome === "failure") failedCycles++;
    else if (outcome === "abandoned") abandonedCycles++;
    else noWorkCycles++;

    for (const run of c.agentRuns || []) {
      const cost = Number(run.costUsd) || 0;
      if (cost === 0) continue;

      cycleCost += cost;
      totalCostUsd += cost;

      // Role aggregation
      const role = run.agent || "unknown";
      const roleEntry = roleTotals.get(role) || { costUsd: 0, runs: 0 };
      roleEntry.costUsd += cost;
      roleEntry.runs += 1;
      roleTotals.set(role, roleEntry);
      cycleRoleBreakdown.set(role, (cycleRoleBreakdown.get(role) || 0) + cost);

      // Tier aggregation — prefer per-run model, fall back to role mapping
      const tier = run.model ? modelToTier(run.model) : agentRoleToTier(role);
      const tierEntry = tierTotals.get(tier) || { costUsd: 0, runs: 0 };
      tierEntry.costUsd += cost;
      tierEntry.runs += 1;
      tierTotals.set(tier, tierEntry);
    }

    const anchor = c.anchorType || "unknown";
    const anchorEntry = anchorTotals.get(anchor) || { costUsd: 0, cycles: 0 };
    anchorEntry.costUsd += cycleCost;
    anchorEntry.cycles += 1;
    anchorTotals.set(anchor, anchorEntry);

    const complexity = c.complexity || "unknown";
    const cEntry = complexityTotals.get(complexity) || { costUsd: 0, cycles: 0, mergedCycles: 0 };
    cEntry.costUsd += cycleCost;
    cEntry.cycles += 1;
    if (outcome === "merge") cEntry.mergedCycles += 1;
    complexityTotals.set(complexity, cEntry);

    const oEntry = outcomeTotals.get(outcome) || { costUsd: 0, cycles: 0 };
    oEntry.costUsd += cycleCost;
    oEntry.cycles += 1;
    outcomeTotals.set(outcome, oEntry);

    cyclesWithCost.push({
      cycleId: c.cycleId,
      taskTitle: c.taskTitle || "(untitled)",
      totalCostUsd: cycleCost,
      outcome,
      roleBreakdown: cycleRoleBreakdown,
    });
  }

  const pct = (n: number) => totalCostUsd > 0 ? Math.round((n / totalCostUsd) * 10000) / 100 : 0;
  const round4 = (n: number) => Math.round(n * 10000) / 10000;

  const byRole = [...roleTotals.entries()]
    .map(([role, v]) => ({ role, costUsd: round4(v.costUsd), pct: pct(v.costUsd), runs: v.runs }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byTier = [...tierTotals.entries()]
    .map(([tier, v]) => ({ tier, costUsd: round4(v.costUsd), pct: pct(v.costUsd), runs: v.runs }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byAnchorType = [...anchorTotals.entries()]
    .map(([anchorType, v]) => ({ anchorType, costUsd: round4(v.costUsd), pct: pct(v.costUsd), cycles: v.cycles }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byComplexity = [...complexityTotals.entries()]
    .map(([complexity, v]) => ({
      complexity,
      costUsd: round4(v.costUsd),
      pct: pct(v.costUsd),
      cycles: v.cycles,
      mergedCycles: v.mergedCycles,
      costPerMerge: v.mergedCycles > 0 ? round4(v.costUsd / v.mergedCycles) : null,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byOutcome = [...outcomeTotals.entries()]
    .map(([outcome, v]) => ({ outcome, costUsd: round4(v.costUsd), pct: pct(v.costUsd), cycles: v.cycles }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const top5ExpensiveCycles = cyclesWithCost
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 5)
    .map((c) => ({
      cycleId: c.cycleId,
      taskTitle: c.taskTitle,
      totalCostUsd: round4(c.totalCostUsd),
      outcome: c.outcome,
      roleBreakdown: [...c.roleBreakdown.entries()]
        .map(([role, cost]) => ({ role, costUsd: round4(cost) }))
        .sort((a, b) => b.costUsd - a.costUsd),
    }));

  return {
    windowCycles: cycles.length,
    totalCostUsd: round4(totalCostUsd),
    mergedCycles,
    failedCycles,
    abandonedCycles,
    noWorkCycles,
    costPerMerge: mergedCycles > 0 ? round4(totalCostUsd / mergedCycles) : null,
    byRole,
    byTier,
    byAnchorType,
    byComplexity,
    byOutcome,
    top5ExpensiveCycles,
  };
}
