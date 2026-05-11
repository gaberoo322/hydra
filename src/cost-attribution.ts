/**
 * cost-attribution.ts — Pure aggregation logic for /api/metrics/cost-attribution
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
 * Map model string -> tier label. Matches the CLAUDE.md "Model Tiers" table:
 *   - frontier: gpt-5.4
 *   - codex:    gpt-5.3-codex
 *   - mini:     gpt-5.4-mini
 *
 * Inputs may be raw model names ("gpt-5.4") or tier aliases ("frontier",
 * "codex", "mini", "local"). Unknown values fall back to "unknown".
 */
export function modelToTier(model: string | undefined | null): string {
  if (!model) return "unknown";
  const m = model.toLowerCase();
  if (m === "frontier" || m.includes("5.4") && !m.includes("mini")) return "frontier";
  if (m === "codex" || m.includes("codex") || m.includes("5.3")) return "codex";
  if (m === "mini" || m.includes("mini") || m.includes("nano") || m === "local") return "mini";
  return "unknown";
}

/**
 * Static fallback when an agent-run entry has no `model` field (older Redis
 * data predates the cost-attribution work). Picks the typical tier for each
 * agent role per CLAUDE.md.
 */
export function agentRoleToTier(role: string): string {
  switch (role) {
    case "planner":   return "frontier";   // default — quick-fix overrides via run.model
    case "executor":  return "codex";
    case "fixer":     return "codex";
    case "jit-tester":return "codex";
    case "skeptic":   return "mini";       // high-risk-review uses mini; preflight is deterministic
    case "meta":      return "mini";
    case "adversarial": return "mini";
    case "high-risk-reviewer": return "mini";
    case "code-reviewer": return "codex";
    default: return "unknown";
  }
}

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
