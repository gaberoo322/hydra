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

/** Compact percent (one decimal, clamped to [0,∞) display). */
export function formatPercent(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

/** Human token count: 1.2M / 814K / 512. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}

/** Human duration: "—" for non-finite/<=0, else "Xh" / "Xm" / "Xs". */
export function formatDuration(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 3600) return `${(v / 3600).toFixed(1)}h`;
  if (v >= 60) return `${Math.round(v / 60)}m`;
  return `${Math.round(v)}s`;
}

/** Cache-hit ratio (0..1) → percent string. */
export function formatRatio(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
