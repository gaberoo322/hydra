import { useApi } from "../hooks/useApi.js";

/**
 * Outcomes panel (issue #252).
 *
 * Reads `GET /api/outcomes` (declared contract + current readings) and
 * `GET /api/stuckness` (cycles-since-favorable-move per outcome) and renders
 * a first-class diagnostic surface so the operator can see — without
 * scrolling, without `curl` — whether the orchestrator is moving the
 * outcomes the operator vision actually cares about.
 *
 * Per ADR-0003 (terminal goal hierarchy), leading outcomes drive the
 * stuckness detector (#242) and terminal outcomes drive priority. We sort
 * accordingly: fired-leading > fired-terminal > unfired-leading > unfired-terminal.
 *
 * The "stuckness fired" indicator follows the QualityGatesPanel convention:
 * red border + alert badge so a fired outcome is unmissable.
 */

const POLL_MS = 30000;

function kindLabel(kind) {
  if (kind === "leading") return "Leading";
  if (kind === "terminal") return "Terminal";
  return kind || "—";
}

function directionLabel(direction) {
  if (direction === "higher_is_better") return "higher is better";
  if (direction === "lower_is_better") return "lower is better";
  return direction || "—";
}

function formatValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  // Choose precision based on magnitude
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/**
 * Joins the /outcomes (declared + current) row with the /stuckness row
 * (cyclesStuck/fired/threshold). Stuckness lookup is by name. Outcomes
 * without a matching stuckness entry get sensible defaults.
 */
function mergeRows(outcomesRows, stucknessRows) {
  const byName = new Map();
  for (const s of stucknessRows || []) {
    byName.set(s.name, s);
  }
  return (outcomesRows || []).map((o) => {
    const s = byName.get(o.name);
    return {
      name: o.name,
      kind: o.kind,
      direction: o.direction,
      source: o.source,
      baseline: o.baseline,
      target: o.target,
      current: o.current,
      ts: o.ts,
      cyclesStuck: s?.cyclesStuck ?? null,
      threshold: s?.threshold ?? o.stuckness_threshold_cycles ?? null,
      fired: Boolean(s?.fired),
    };
  });
}

function sortRows(rows) {
  // fired-leading > fired-terminal > unfired-leading > unfired-terminal
  const bucket = (r) => {
    if (r.fired && r.kind === "leading") return 0;
    if (r.fired && r.kind === "terminal") return 1;
    if (!r.fired && r.kind === "leading") return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    // Secondary: highest cyclesStuck first within a bucket
    return (b.cyclesStuck ?? -1) - (a.cyclesStuck ?? -1);
  });
}

export default function Outcomes() {
  const { data: outcomesData, error: outcomesError, loading: outcomesLoading } = useApi("/outcomes", { poll: POLL_MS });
  const { data: stucknessData, error: stucknessError } = useApi("/stuckness", { poll: POLL_MS });

  const outcomes = Array.isArray(outcomesData?.outcomes) ? outcomesData.outcomes : [];
  const stuckness = Array.isArray(stucknessData?.outcomes) ? stucknessData.outcomes : [];

  const merged = mergeRows(outcomes, stuckness);
  const sorted = sortRows(merged);

  const firedCount = sorted.filter((r) => r.fired).length;
  const total = sorted.length;

  // Surface server-side errors from the outcomes loader (e.g. malformed yaml).
  const serverErrors = outcomesData?.errors || stucknessData?.errors || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Outcomes</h1>
        <span className="text-xs text-zinc-500">Polls every {Math.round(POLL_MS / 1000)}s</span>
      </div>

      {/* Stuckness banner — visible without scrolling */}
      <StucknessBanner firedCount={firedCount} total={total} loading={outcomesLoading && !outcomesData} />

      {/* Fetch errors */}
      {(outcomesError || stucknessError) && (
        <div className="bg-red-500/5 border border-red-500/40 rounded-lg p-3 text-sm text-red-300">
          <p className="font-medium">Failed to load outcomes data</p>
          {outcomesError && <p className="text-xs mt-1 font-mono">/api/outcomes: {outcomesError}</p>}
          {stucknessError && <p className="text-xs mt-1 font-mono">/api/stuckness: {stucknessError}</p>}
        </div>
      )}

      {/* Server-reported config errors (malformed outcomes.yaml etc.) */}
      {serverErrors.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/40 rounded-lg p-3 text-sm text-amber-200">
          <p className="font-medium">Outcome configuration errors</p>
          <ul className="text-xs mt-1 list-disc list-inside space-y-0.5">
            {serverErrors.map((e, i) => <li key={i} className="font-mono">{e}</li>)}
          </ul>
        </div>
      )}

      {/* Cards */}
      {outcomesLoading && !outcomesData ? (
        <div className="p-8 animate-pulse bg-zinc-800/30 rounded-lg" />
      ) : sorted.length === 0 && serverErrors.length === 0 && !outcomesError ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sorted.map((row) => (
            <OutcomeCard key={row.name} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function StucknessBanner({ firedCount, total, loading }) {
  if (loading) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 animate-pulse">
        <p className="text-sm text-zinc-600">Loading outcomes…</p>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <p className="text-sm text-zinc-400">No declared outcomes.</p>
      </div>
    );
  }
  if (firedCount === 0) {
    return (
      <div className="bg-zinc-900 border border-emerald-600/30 rounded-lg p-4 flex items-center gap-3">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />
        <p className="text-sm text-emerald-300">
          <span className="font-semibold">All clear.</span> 0 of {total} outcomes are stuck.
        </p>
      </div>
    );
  }
  return (
    <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-start gap-3">
      <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div>
        <p className="text-sm font-semibold text-red-300">
          Stuckness fired: {firedCount} of {total} outcomes stuck
        </p>
        <p className="text-xs text-red-300/80 mt-1">
          The orchestrator is shipping cycles but the operator-declared outcomes aren't moving.
          Anchor selection will prefer research over backlog work until at least one outcome moves favorably.
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
      <svg className="w-12 h-12 mx-auto text-zinc-700 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
      <p className="text-zinc-400 text-sm">No outcomes declared</p>
      <p className="text-zinc-600 text-xs mt-2">
        The orchestrator has no operator-declared outcomes to track. Add entries to{" "}
        <code className="text-zinc-500">config/direction/outcomes.yaml</code> to make Hydra's
        progress observable. See ADR-0003 (terminal goal hierarchy).
      </p>
    </div>
  );
}

function OutcomeCard({ row }) {
  const fired = row.fired;
  const borderClass = fired
    ? "border-red-500/60"
    : row.kind === "terminal"
      ? "border-blue-600/30"
      : "border-zinc-800";
  const ringClass = fired ? "ring-1 ring-red-500/20" : "";

  return (
    <div className={`bg-zinc-900 border ${borderClass} ${ringClass} rounded-lg p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{row.name}</p>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] uppercase tracking-wider">
            <KindBadge kind={row.kind} />
            <span className="text-zinc-600">{directionLabel(row.direction)}</span>
          </div>
        </div>
        {fired && (
          <span className="text-[10px] font-bold px-2 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/40 shrink-0 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            STUCK
          </span>
        )}
      </div>

      {/* Current value vs baseline/target */}
      <div className="grid grid-cols-3 gap-2">
        <ValueCell label="Baseline" value={formatValue(row.baseline)} muted />
        <ValueCell label="Current" value={formatValue(row.current)} emphasize />
        <ValueCell label="Target" value={formatValue(row.target)} muted />
      </div>

      {/* Progress bar (visual direction indicator) */}
      <ProgressBar baseline={row.baseline} current={row.current} target={row.target} direction={row.direction} />

      {/* Stuckness indicator */}
      <div className="flex items-center justify-between text-xs pt-1 border-t border-zinc-800">
        <span className="text-zinc-500">Cycles since favorable move</span>
        <span className={fired ? "text-red-400 font-semibold tabular-nums" : "text-zinc-300 tabular-nums"}>
          {row.cyclesStuck ?? "—"}
          {row.threshold !== null && row.threshold !== undefined && (
            <span className="text-zinc-600"> / {row.threshold}</span>
          )}
        </span>
      </div>

      {/* Reading timestamp */}
      {row.ts && (
        <p className="text-[10px] text-zinc-600 -mt-1">
          Last reading: {new Date(row.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      )}
    </div>
  );
}

function KindBadge({ kind }) {
  const classes = kind === "terminal"
    ? "text-blue-300 bg-blue-500/10 border border-blue-500/30"
    : kind === "leading"
      ? "text-purple-300 bg-purple-500/10 border border-purple-500/30"
      : "text-zinc-400 bg-zinc-800";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${classes}`}>
      {kindLabel(kind)}
    </span>
  );
}

function ValueCell({ label, value, emphasize, muted }) {
  const valueClass = emphasize ? "text-xl font-bold text-white" : muted ? "text-sm font-medium text-zinc-400" : "text-sm font-medium text-zinc-300";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</p>
      <p className={`${valueClass} tabular-nums mt-0.5`}>{value}</p>
    </div>
  );
}

/**
 * Renders a simple horizontal bar showing baseline → current → target.
 * Position of the "current" marker uses linear interpolation; clamps to [0,1].
 * If baseline == target we show a neutral midpoint.
 */
function ProgressBar({ baseline, current, target, direction }) {
  if (
    typeof baseline !== "number" ||
    typeof target !== "number" ||
    typeof current !== "number" ||
    Number.isNaN(baseline) || Number.isNaN(target) || Number.isNaN(current)
  ) {
    return <div className="h-1.5 rounded-full bg-zinc-800" />;
  }
  let pct;
  if (baseline === target) {
    pct = 50;
  } else {
    const raw = (current - baseline) / (target - baseline);
    pct = Math.max(0, Math.min(1, raw)) * 100;
  }
  // Determine if current direction is favorable. For higher_is_better,
  // higher current vs baseline = good. For lower_is_better the API serves
  // baseline > target, so the formula still works directionally.
  const favorable = direction === "higher_is_better"
    ? current >= baseline
    : current <= baseline;
  const fillClass = favorable ? "bg-emerald-400" : "bg-amber-400";
  return (
    <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-hidden">
      <div className={`absolute inset-y-0 left-0 ${fillClass}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
