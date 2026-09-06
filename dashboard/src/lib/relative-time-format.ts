/**
 * relative-time-format.ts — the dashboard's ONE canonical epoch →
 * "Ns/Nm/Nh/Nd ago" relative-time bucket (issue #4400).
 *
 * The same four threshold branches (<60s seconds, <3600s minutes, <86400s
 * hours, else days) used to live in three hand-duplicated copies:
 * `formatRelativeTime` in pages/now-pixel/oak-tab-state.ts, the private
 * `formatRelativeStart` in pages/now-console/console-state.ts, and
 * `relativeTime` in lib/autopilot-format.js. They all delegate here now —
 * tightening a threshold or adding a bucket ("just now") is a one-file edit.
 *
 * Why lib/ and not console-state.ts (which owns the sibling
 * formatPercent/formatTokens/formatDuration/formatRatio family, the seam
 * #4396 chose)? One of the three consumers is itself in lib/
 * (autopilot-format.js's relativeTime wrapper), and the dashboard has ZERO
 * lib/→pages/ import edges today — housing the helper in any pages/ module
 * would introduce the first inverted layering edge. A lib/ module is
 * reachable from every layer, which is exactly the reuse leverage this
 * consolidation is buying. Same `lib/*-format.ts` naming as
 * page-item-format.ts and versions-format.ts.
 *
 * `nowSec` is injected (not Date.now()) so the orchestrator's node:test
 * suite can pin the buckets deterministically — same testing seam as the
 * other lib formatters. Invalid input (non-number / non-finite / <= 0)
 * yields "" so callers decide their own render fallback: the now-console
 * widgets omit the segment, autopilot-format.js's relativeTime maps it to
 * an em dash. Future-timestamp clamping to "0s ago" protects against
 * dashboard↔orchestrator clock skew.
 */

export function formatRelativeTime(
  epochSec: number | null | undefined,
  nowSec: number,
): string {
  if (typeof epochSec !== "number" || !Number.isFinite(epochSec) || epochSec <= 0) {
    return "";
  }
  const diff = Math.max(0, Math.floor(nowSec - epochSec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
