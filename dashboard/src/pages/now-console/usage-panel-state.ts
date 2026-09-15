/**
 * usage-panel-state.ts — the UsagePanel's two data derivations (issue #891,
 * now-console-4, parent #887; extracted from console-state.ts by #4382).
 *
 * Owns the quota/pacing concern and nothing else: the weekly-pace
 * classification shown on the pace gauge, and the flattener that turns the
 * eligibility endpoint's nested `bySkillByModel` usage tree into ranked rows
 * for the attribution table. Both are UsagePanel-only; the small display
 * formatters the panel shares with other widgets live in console-format.ts.
 * Pure and DOM-free so both are unit-tested in the orchestrator suite
 * (`test/now-console-usage-panel-state.test.mts`) — the dashboard ships no
 * JSX test runner (issue #3706).
 *
 * Consumers reach this through the `console-state.ts` barrel; import the leaf
 * directly when only pace/attribution is needed.
 */

export type PaceVerdict = "ahead" | "on" | "behind";

/**
 * Classify weekly pace from sinceReset% vs target%. "on" within a tolerance
 * band (default ±2 absolute percentage points) so the gauge does not flicker
 * ahead/behind on noise. Below target − tol → behind (burning slower than the
 * even-pace line, i.e. headroom to spare); above target + tol → ahead.
 */
export function classifyPace(
  sinceResetPercent: number | null | undefined,
  targetPercent: number | null | undefined,
  tolerance = 2,
): PaceVerdict {
  if (sinceResetPercent == null || targetPercent == null) return "on";
  const s = Number(sinceResetPercent);
  const t = Number(targetPercent);
  if (!Number.isFinite(s) || !Number.isFinite(t)) return "on";
  if (s > t + tolerance) return "ahead";
  if (s < t - tolerance) return "behind";
  return "on";
}

/**
 * Flatten the `bySkillByModel` usage tree into ranked rows for the
 * attribution table: one row per (skill, model) with a non-zero total,
 * sorted by total descending. The eligibility endpoint nests
 * `{ skill: { model: { total, ... } } }`.
 */
export interface AttributionRow {
  skill: string;
  model: string;
  total: number;
}

export function flattenAttribution(
  bySkillByModel:
    | Record<string, Record<string, { total?: number } | null | undefined>>
    | null
    | undefined,
): AttributionRow[] {
  if (!bySkillByModel || typeof bySkillByModel !== "object") return [];
  const rows: AttributionRow[] = [];
  for (const [skill, byModel] of Object.entries(bySkillByModel)) {
    if (!byModel || typeof byModel !== "object") continue;
    for (const [model, usage] of Object.entries(byModel)) {
      const total = Number(usage?.total ?? 0);
      if (Number.isFinite(total) && total > 0) {
        rows.push({ skill, model, total });
      }
    }
  }
  return rows.sort((a, b) => b.total - a.total);
}
