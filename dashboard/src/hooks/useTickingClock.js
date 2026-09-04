import { useEffect, useState } from "react";

/**
 * useTickingClock — a shared "live clock" hook (issue #4361, design-concept
 * issue-4361), extracted from four independent inline copies of the same
 * three-line idiom across dashboard/src/pages/now-console/ (NowConsole.jsx's
 * TurnJournal, StatusStrip.jsx's default export and InflightSlotsWidget, and
 * RunHistoryStrip.jsx).
 *
 * Returns the current `Date.now()` value in milliseconds and re-renders its
 * caller every `intervalMs`. Seeds lazily, starts exactly one `setInterval`
 * that RE-READS `Date.now()` on every tick (never increments the previous
 * value, so it never drifts), and clears it on cleanup / when `intervalMs`
 * changes. No default interval — every call site states its own cadence
 * explicitly, which is the reviewability this extraction is buying.
 *
 * Milliseconds only, never seconds or an object: two of the three consumer
 * signatures (formatNextDispatchCountdown, deriveInflightSlots) already take
 * milliseconds; the one that wants seconds (formatRelativeTime) derives
 * `nowSec` locally with `Math.floor(nowMs / 1000)` at its call site.
 *
 * Deliberately NOT here (future one-file edits this extraction makes
 * possible, out of scope for this refactor): document.visibilitychange
 * pause-when-hidden, requestAnimationFrame, jitter, drift correction, and
 * the unrelated fetch-poll intervals owned by useApi.js / LogsSection.jsx.
 */
export function useTickingClock(intervalMs) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return nowMs;
}
