/**
 * LocalTimestamp.jsx — the shared timestamp render helper (issue #3562).
 *
 * A thin renderer over the pure local-time seam in lib/page-item-format.ts:
 * it shows the compact browser-local date+time and carries the full local
 * date+time in a hover `title` tooltip (the agreed UX — keep the cell
 * compact, disambiguate on hover). Every timestamp render site migrates onto
 * this component (sibling tickets #3563 / #3564) so no future cell can
 * silently render UTC or hand-roll its own formatter.
 *
 * All display logic lives in the pure `.ts` seam (localTimestampParts), which
 * the orchestrator node:test suite pins for timezone-conversion and
 * null-guard behaviour — the dashboard ships no JSX test runner, so this
 * component stays a byte-thin presenter with nothing to unit-test.
 */
import { localTimestampParts, EMPTY_TIMESTAMP } from "../lib/page-item-format.ts";

/**
 * Render one timestamp local-by-default.
 *
 * @param {object} props
 * @param {string|number|null|undefined} props.ts  ISO-8601-UTC string or
 *   Unix-epoch-seconds (the two shapes the API sends). Null/invalid renders
 *   the em-dash placeholder with no tooltip.
 * @param {string} [props.className]  passed through to the wrapping <time>.
 * @param {string} [props.prefix=""]  optional label rendered before the time
 *   (e.g. "as of " for the ADR-0034 §5.4 "age always visible" panel header).
 *   Suppressed when the timestamp is invalid so a missing value reads as just
 *   the em-dash, never "as of —".
 */
export default function LocalTimestamp({ ts, className, prefix = "" }) {
  const { compact, title } = localTimestampParts(ts);
  // `title=""` reads as "no tooltip"; only attach one when we have a full form.
  // The prefix only renders for a real timestamp — an absent value shows the
  // bare em-dash placeholder (ADR-0034: an unverifiable age is itself unknown).
  const showPrefix = prefix && compact !== EMPTY_TIMESTAMP;
  return (
    <time className={className} title={title || undefined}>
      {showPrefix ? prefix : ""}
      {compact}
    </time>
  );
}
