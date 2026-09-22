/**
 * console-format.ts — the small display formatters the /now Console widgets
 * share (issue #891, now-console-4, parent #887; extracted from
 * console-state.ts by #4382).
 *
 * Four pure percent/tokens/duration/ratio formatters consumed by UsagePanel,
 * RunDetailDrawer, and RunHistoryStrip — kept apart from the pace/attribution
 * derivations because the drawer and history strip use them with no
 * pace-at-all concern. The epoch → "N ago" relative-time bucket is NOT here:
 * it is the dashboard-wide `lib/relative-time-format.ts` canonical (issue
 * #4400). Pure and DOM-free so they are unit-tested in the orchestrator
 * suite (`test/now-console-format.test.mts`) — the dashboard ships no JSX
 * test runner (issue #3706).
 *
 * Consumers reach this through the `console-state.ts` barrel; import the leaf
 * directly when only formatting is needed.
 */

import { formatDuration as canonicalFormatDuration } from "../../lib/display-format.ts";

/** Compact percent (one decimal, clamped to [0,∞) display). */
export function formatPercent(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

/**
 * Human token count: 1.5M / 815K / 512. Re-exported BY IDENTITY from the
 * dashboard-wide canonical in lib/display-format.ts (issue #4564).
 */
export { formatTokens } from "../../lib/display-format.ts";

/**
 * Human duration — a thin wrapper over the canonical lib/display-format.ts
 * formatDuration (issue #4564) that keeps only this widget family's null
 * policy: "—" for non-finite/<=0; seconds precision under a minute ("45s");
 * minutes precision otherwise ("1m", "59m", "1h 30m").
 */
export function formatDuration(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  return canonicalFormatDuration(v, { precision: v < 60 ? "seconds" : "minutes" });
}

/** Cache-hit ratio (0..1) → percent string. */
export function formatRatio(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
