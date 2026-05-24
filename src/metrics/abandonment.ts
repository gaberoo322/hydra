/**
 * Abandonment-reason categorization + rollup (issue #195).
 *
 * The categorizer is the pure half (testable on fixture strings) and
 * `getAbandonmentBreakdown` is the composition over the trend.
 */

import { getMetricsTrend } from "./trend.ts";

/**
 * Categorize an `abandonReason` string into a stable bucket.
 *
 * Strategy: split on first `:` if present (e.g., "Planner noWork: codebase-clean" → "Planner noWork").
 * Otherwise take the first 4 words. Trim and collapse whitespace. Return "Unknown" for empty input.
 *
 * Pure function — deterministic, no side effects.
 */
export function categorizeAbandonReason(reason: string | undefined | null): string {
  if (!reason || typeof reason !== "string") return "Unknown";
  const trimmed = reason.trim();
  if (!trimmed) return "Unknown";

  const colonIdx = trimmed.indexOf(":");
  const head = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Unknown";
  return words.slice(0, 4).join(" ");
}

/**
 * Aggregate abandonment causes from the last N cycles.
 *
 * Returns:
 *   - totalCycles: number of cycles considered
 *   - totalAbandoned: cycles with a non-empty `abandonReason`
 *   - abandonRate: percent (0-100, integer)
 *   - byCategory: descending array of { category, count, pct, sampleReasons[] }
 *
 * Categories are derived via `categorizeAbandonReason`. Sample reasons preserve
 * up to 3 distinct raw reasons per category for operator context.
 */
export async function getAbandonmentBreakdown(count = 50) {
  const trend = await getMetricsTrend(count);
  const totalCycles = trend.length;

  type Bucket = { category: string; count: number; sampleReasons: string[] };
  const buckets = new Map<string, Bucket>();
  let totalAbandoned = 0;

  for (const m of trend) {
    const reason = typeof m.abandonReason === "string" ? m.abandonReason.trim() : "";
    if (!reason) continue;
    totalAbandoned++;
    const category = categorizeAbandonReason(reason);
    let b = buckets.get(category);
    if (!b) {
      b = { category, count: 0, sampleReasons: [] };
      buckets.set(category, b);
    }
    b.count++;
    if (b.sampleReasons.length < 3 && !b.sampleReasons.includes(reason)) {
      b.sampleReasons.push(reason);
    }
  }

  const byCategory = Array.from(buckets.values())
    .map((b) => ({
      category: b.category,
      count: b.count,
      pct: totalAbandoned > 0 ? Math.round((b.count / totalAbandoned) * 100) : 0,
      sampleReasons: b.sampleReasons,
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    totalCycles,
    totalAbandoned,
    abandonRate: totalCycles > 0 ? Math.round((totalAbandoned / totalCycles) * 100) : 0,
    byCategory,
  };
}
