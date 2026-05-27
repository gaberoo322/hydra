import { useApi } from "../../hooks/useApi.js";

/**
 * Dashboard v2 — `/v2/today` page (issue #616, PRD #615).
 *
 * Slice 1 — tracer-bullet: renders ONE section, the OvernightBanner,
 * fed by `GET /api/v2/today/summary`. No sidebar entry, no other
 * sections. Visiting `/v2/today` by URL is the only way to reach it
 * until slice 2 wires it into the layout.
 */

const HEADROOM_STYLES = {
  green: {
    chip: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30",
    dot: "bg-emerald-400",
    label: "Headroom: clear",
  },
  yellow: {
    chip: "bg-yellow-500/10 text-yellow-300 border border-yellow-500/30",
    dot: "bg-yellow-400",
    label: "Headroom: on pace",
  },
  red: {
    chip: "bg-red-500/10 text-red-300 border border-red-500/30",
    dot: "bg-red-400 animate-pulse",
    label: "Headroom: over budget",
  },
  unknown: {
    chip: "bg-zinc-500/10 text-zinc-300 border border-zinc-500/30",
    dot: "bg-zinc-400",
    label: "Headroom: uncalibrated",
  },
};

function formatMoney(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

function OvernightBanner({ summary }) {
  const headroomStyle = HEADROOM_STYLES[summary?.headroom || "unknown"];
  const merges = summary?.mergeCount ?? 0;
  const runs = summary?.runCount ?? 0;
  const cost = summary?.costSpent ?? 0;
  const issues = summary?.issuesOpened ?? 0;
  const hours = summary?.windowHours ?? 12;

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">
            Since you were gone — last {hours}h
          </h2>
          <p className="text-2xl font-semibold text-zinc-100">
            {merges} {merges === 1 ? "PR" : "PRs"} merged
            <span className="text-zinc-500 mx-2">·</span>
            {runs} autopilot {runs === 1 ? "run" : "runs"}
            <span className="text-zinc-500 mx-2">·</span>
            {formatMoney(cost)} spent
            <span className="text-zinc-500 mx-2">·</span>
            {issues} {issues === 1 ? "issue" : "issues"} opened
          </p>
        </div>
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap ${headroomStyle.chip}`}
        >
          <span className={`w-2 h-2 rounded-full ${headroomStyle.dot}`} />
          {headroomStyle.label}
        </div>
      </div>
      {summary?.generatedAt && (
        <p className="text-xs text-zinc-500">
          Updated {new Date(summary.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

export default function Today() {
  const { data, error, loading } = useApi("/v2/today/summary", { poll: 60_000 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Today</h1>
        <p className="text-sm text-zinc-400">
          Dashboard v2 — slice 1 (tracer-bullet). One banner, one endpoint.
        </p>
      </div>

      {loading && !data && (
        <div className="bg-zinc-800/30 rounded-lg animate-pulse h-32" />
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg p-4">
          <div className="font-semibold mb-1">Couldn't load overnight summary</div>
          <div className="text-sm font-mono break-all">{error}</div>
        </div>
      )}

      {data && <OvernightBanner summary={data} />}
    </div>
  );
}
