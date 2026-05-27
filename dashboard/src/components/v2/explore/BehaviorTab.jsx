import { useState, useMemo } from "react";
import { useApi } from "../../../hooks/useApi.js";
import { TabShell } from "./TabShell.jsx";

const OUTCOMES = ["", "success", "failure", "aborted", "in-progress"];

const OUTCOME_STYLE = {
  success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  failure: "bg-red-500/10 text-red-300 border-red-500/30",
  aborted: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
  "in-progress": "bg-sky-500/10 text-sky-300 border-sky-500/30",
  unknown: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
};

function fmtDuration(s) {
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

function fmtMoney(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

export function BehaviorTab() {
  const [outcome, setOutcome] = useState("");
  const [classFilter, setClassFilter] = useState("");

  const path = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (outcome) params.set("outcome", outcome);
    if (classFilter) params.set("class", classFilter);
    return `/v2/explore/behavior?${params.toString()}`;
  }, [outcome, classFilter]);

  const { data, error, loading } = useApi(path, { poll: 30_000 });
  const items = data?.items ?? [];
  const empty = !loading && !error && items.length === 0;

  const subtitle = `Last ${data?.limit ?? 50} autopilot runs. Each row links to its detail page.`;

  const actions = (
    <>
      <select
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200"
        aria-label="Filter by outcome"
      >
        {OUTCOMES.map((o) => (
          <option key={o} value={o}>
            {o || "all outcomes"}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={classFilter}
        onChange={(e) => setClassFilter(e.target.value.trim())}
        placeholder="class (e.g. dev_orch)"
        className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 w-44"
        aria-label="Filter by class"
      />
    </>
  );

  return (
    <TabShell
      title="Behavior"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage="No autopilot runs match the current filter."
      actions={actions}
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((row) => {
          const style = OUTCOME_STYLE[row.outcome] || OUTCOME_STYLE.unknown;
          return (
            <li key={row.runId} className="py-2 flex items-center gap-3">
              <a
                href={row.detailHref}
                className="text-zinc-100 hover:text-amber-300 font-mono text-xs shrink-0 w-32 truncate"
                title={row.runId}
              >
                {row.runId}
              </a>
              <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border shrink-0 ${style}`}>
                {row.outcome}
              </span>
              <span className="text-xs text-zinc-400 shrink-0 w-16 truncate" title={row.trigger}>
                {row.trigger}
              </span>
              <span className="text-xs text-zinc-300 shrink-0 w-16 font-mono">
                {fmtDuration(row.durationS)}
              </span>
              <span className="text-xs text-zinc-300 shrink-0 w-20 font-mono">
                {row.mergedCount}m/{row.failedCount}f
              </span>
              <span className="text-xs text-zinc-300 shrink-0 w-16 font-mono">
                {fmtMoney(row.totalCostUsd)}
              </span>
              <span className="flex-1 min-w-0 text-xs text-zinc-500 truncate">
                {row.classes.join(", ")}
              </span>
            </li>
          );
        })}
      </ul>
    </TabShell>
  );
}
