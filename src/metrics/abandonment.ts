/**
 * Abandonment-reason categorization + rollup (issue #195) — metrics domain.
 *
 * PURE-or-near-pure domain logic over the cycle-metrics trend:
 *   - `categorizeAbandonReason(reason)` is the pure half (deterministic,
 *     testable on fixture strings; no route, no request, no response).
 *   - `getAbandonmentBreakdown(count)` composes the categorizer over
 *     `getMetricsTrend(count)` (its data source in `trend.ts`) into an
 *     abandonment-bucket summary. It is `async` but imports no Express types
 *     and touches no `req`/`res`.
 *
 * Issue #2589: relocated here OUT of the HTTP route module `src/api/metrics.ts`,
 * restoring the domain home the header of that file records — these functions
 * were previously in a `src/metrics/abandonment.ts` module, then folded INTO the
 * route file by issue #2382. This reverses that collapse (mirrors the #2497
 * learning-composition extraction). This module is domain-only: it imports its
 * data source from `src/metrics/trend.ts` and has ZERO imports from `src/api/`.
 * The route re-exports these symbols for back-compat so the route body and any
 * existing import sites do not change. A future aggregator or dashboard panel
 * wanting abandonment stats imports from HERE, not from a route file.
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
