import { STATUS_STYLES, statusKey, formatElapsed } from "../lib/autopilot-format.js";

// Small, prop-driven display atoms shared across the Autopilot run view.
// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589) so each atom's
// prop interface is a named, importable module boundary rather than an inline
// definition invisible to other pages. Behavior is identical to the originals.

export function StatusPill({ run }) {
  const key = statusKey(run);
  const style = STATUS_STYLES[key];
  let label = style.label;
  if (key === "ended" && run?.term_reason) label = `ENDED: ${run.term_reason}`;
  if (key === "killed" && run?.term_reason) label = `KILLED: ${run.term_reason}`;
  const tooltip = key === "wedge"
    ? `Heartbeat age: ${formatElapsed(run.age_s)} (threshold 10m)`
    : undefined;
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border ${style.bg} ${style.border} ${style.text} text-sm font-semibold`}
      title={tooltip}
    >
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      {label}
    </div>
  );
}

export function StatusPillSmall({ row }) {
  const key = row.status === "running" ? "running" : row.status === "killed" ? "killed" : "ended";
  const style = STATUS_STYLES[key];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${style.bg} ${style.border} ${style.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {(row.status || "ended").toUpperCase()}
    </span>
  );
}

export function MetaCell({ label, value, mono = false }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`text-sm text-zinc-200 ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

export function BudgetBar({ label, current, max, formatValue }) {
  const safeMax = Number(max) || 0;
  const safeCurrent = Number(current) || 0;
  const pct = safeMax > 0 ? Math.min(100, (safeCurrent / safeMax) * 100) : 0;
  const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500";
  const fmt = formatValue || ((n) => String(n));
  return (
    <div>
      <div className="flex justify-between items-baseline text-xs text-zinc-400 mb-1">
        <span>{label}</span>
        <span className="font-mono text-zinc-300">
          {fmt(safeCurrent)} / {fmt(safeMax)}
        </span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
