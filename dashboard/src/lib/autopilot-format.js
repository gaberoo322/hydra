// Shared constants + pure display utilities for the Autopilot run view.
//
// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589) so the
// formatting helpers and the status-style palette have a single named home
// that the extracted display components can import. Behavior is identical to
// the inline originals — these are pure functions with no React or side
// effects.

import { formatRelativeTime } from "./relative-time-format.ts";
import { formatDuration, formatTokens } from "./display-format.ts";

export const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export const STATUS_STYLES = {
  running: { label: "RUNNING", bg: "bg-emerald-500/15", border: "border-emerald-500/40", text: "text-emerald-300", dot: "bg-emerald-400" },
  wedge:   { label: "RUNNING — WEDGE LIKELY", bg: "bg-amber-500/15", border: "border-amber-500/40", text: "text-amber-300", dot: "bg-amber-400" },
  ended:   { label: "ENDED",   bg: "bg-zinc-500/15", border: "border-zinc-500/40", text: "text-zinc-300", dot: "bg-zinc-400" },
  killed:  { label: "KILLED",  bg: "bg-red-500/15",   border: "border-red-500/40",   text: "text-red-300",   dot: "bg-red-400" },
};

export function statusKey(run) {
  if (!run) return "ended";
  if (run.status === "running" && run.wedge_likely) return "wedge";
  if (run.status === "running") return "running";
  if (run.status === "killed") return "killed";
  return "ended";
}

// formatElapsed / formatTokens delegate to the dashboard-wide canonical
// formatters in lib/display-format.ts (issue #4564) — the h/m/s and K/M bucket
// math lives in exactly one place. Names and arity are kept so every importer
// (AutopilotAtoms, HistoryTable, PipelineSnapshot, TurnTimeline, RunView, …)
// is untouched.
export function formatElapsed(seconds) {
  return formatDuration(seconds, { precision: "seconds" });
}

export { formatTokens };

export function truncId(id) {
  if (!id) return "—";
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// relativeTime delegates the s/m/h/d bucket math to the canonical
// formatRelativeTime in lib/relative-time-format.ts (issue #4400) — the
// thresholds live in exactly one place. This wrapper keeps this module's own
// public contract: it supplies Date.now() itself and renders "—" (not "") for
// an unusable epoch, matching what HistoryTable renders for missing rows.
export function relativeTime(epoch) {
  const rel = formatRelativeTime(epoch, Math.floor(Date.now() / 1000));
  return rel === "" ? "—" : rel;
}
