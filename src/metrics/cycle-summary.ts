/**
 * Joins between the metrics trend and per-cycle Redis lists (agent runs,
 * cost hash). Extracted from api/metrics.ts so the trend → CycleSummary
 * shape lives next to the trend definition, not at each HTTP route.
 *
 * Before this module, `/metrics/cost-attribution` and `/spending` each
 * hand-rolled the same `for (const m of trend) await getCycleAgentRuns(...)`
 * loop. A new endpoint wanting the same view would have copied it; now they
 * import a function.
 */

import {
  getCycleAgentRuns,
  getCycleCosts,
} from "../redis/cycle-metrics.ts";
import { getMetricsTrend } from "./trend.ts";
import type { AgentRun, CycleSummary } from "../cost/index.ts";

/**
 * Load the last N cycles as `CycleSummary[]`, joining the metrics trend with
 * per-cycle agent-run lists. Consumed by /metrics/cost-attribution.
 */
export async function loadCycleSummaries(count = 50): Promise<CycleSummary[]> {
  const trend = await getMetricsTrend(count);
  const cycles: CycleSummary[] = [];
  for (const m of trend) {
    const rawRuns = await getCycleAgentRuns(m.cycleId);
    const agentRuns: AgentRun[] = [];
    for (const raw of rawRuns) {
      try {
        agentRuns.push(JSON.parse(raw));
      } catch { /* intentional: skip corrupt agent-run entries */ }
    }
    cycles.push({
      cycleId: m.cycleId,
      taskTitle: m.taskTitle,
      anchorType: m.anchorType,
      complexity: m.complexity,
      tasksMerged: m.tasksMerged,
      tasksFailed: m.tasksFailed,
      tasksAbandoned: m.tasksAbandoned,
      plannerModel: m.plannerModel,
      executorModel: m.executorModel,
      agentRuns,
    });
  }
  return cycles;
}

export interface CycleSpendingEntry {
  cycleId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  task: string | undefined;
}

export interface CycleSpendingReport {
  recentCycles: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalAgentTimeMs: number;
  totalAgentTimeHuman: string;
  avgCostPerCycle: number;
  perCycle: CycleSpendingEntry[];
}

/**
 * Load per-cycle spending across the last N cycles, joining the trend with
 * the per-cycle costs hash. Consumed by /spending.
 */
export async function loadCycleSpending(count = 20): Promise<CycleSpendingReport> {
  const trend = await getMetricsTrend(count);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalAgentTimeMs = 0;
  const perCycle: CycleSpendingEntry[] = [];

  for (const m of trend) {
    const costs = await getCycleCosts(m.cycleId);
    const input = parseInt(costs.inputTokens) || 0;
    const output = parseInt(costs.outputTokens) || 0;
    const costMicro = parseInt(costs.costMicrodollars) || 0;
    const costUsd = costMicro / 1_000_000;

    totalInputTokens += input;
    totalOutputTokens += output;
    totalCostUsd += costUsd;
    totalAgentTimeMs += m.totalDurationMs || 0;

    perCycle.push({
      cycleId: m.cycleId,
      inputTokens: input,
      outputTokens: output,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      durationMs: m.totalDurationMs || 0,
      task: m.taskTitle,
    });
  }

  return {
    recentCycles: trend.length,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd: Math.round(totalCostUsd * 100) / 100,
    totalAgentTimeMs,
    totalAgentTimeHuman: `${Math.round(totalAgentTimeMs / 1000)}s`,
    avgCostPerCycle: trend.length > 0
      ? Math.round((totalCostUsd / trend.length) * 100) / 100
      : 0,
    perCycle,
  };
}
