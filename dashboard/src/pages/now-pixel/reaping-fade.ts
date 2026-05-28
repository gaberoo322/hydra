/**
 * reaping-fade.ts — pure helpers and constants for the 800ms reaping
 * animation in /now-pixel (issue #661, follow-up to epic #642 slice 6).
 *
 * Split out from ReapingFade.jsx so we can pin the status → icon map +
 * duration constant from a `node:test` `.test.mts` without importing
 * JSX/React.
 */

// The transition over which the soon-to-unmount sprite fades out + the
// status icon overlay is shown. Pinned to 800ms by the spec in #648.
// This is the single source of truth — ReapingFade.jsx imports it and
// uses it for both the CSS `transition` and the auto-complete timeout.
export const REAPING_DURATION_MS = 800;

/**
 * Closed set of statuses we map to an icon. The first three come from
 * the `subagent_stop` slot-event payload (status field); "other" is the
 * catch-all for unknown / no_op / budget_exceeded / missing — we still
 * render a fade-out so the slot doesn't pop, but with a neutral icon.
 */
export type ReapStatus = "success" | "failure" | "other";

export interface ReapIcon {
  /** Emoji / character to overlay on the fading sprite. */
  glyph: string;
  /** Tailwind / inline color hint for consumers that want to tint it. */
  color: string;
}

/**
 * statusToIcon — the canonical map.
 *
 * - success → ✨ (sparkle, gold)
 * - failure → ✗ (red X)
 * - other / no_op / budget_exceeded / unknown → 💤 (neutral, light grey)
 *
 * Unknown values fall through to "other" rather than throwing so a
 * future autopilot status that the dashboard hasn't shipped support
 * for yet still produces a graceful fade (not a runtime crash).
 */
export function statusToIcon(status: string | null | undefined): ReapIcon {
  switch (status) {
    case "success":
      return { glyph: "✨", color: "#fbbf24" }; // amber-400
    case "failure":
      return { glyph: "✗", color: "#ef4444" }; // red-500
    default:
      return { glyph: "💤", color: "#9ca3af" }; // grey-400
  }
}

/**
 * normaliseReapStatus — coerce a raw slot-event status string into the
 * closed `ReapStatus` enum the rendering layer reasons about. Anything
 * not explicitly success/failure becomes "other".
 */
export function normaliseReapStatus(
  status: string | null | undefined,
): ReapStatus {
  if (status === "success") return "success";
  if (status === "failure") return "failure";
  return "other";
}
