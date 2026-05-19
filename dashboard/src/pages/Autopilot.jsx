import { useApi } from "../hooks/useApi.js";

// Slice 1 of epic #496 — "Is it alive?" header strip only. No turn timeline,
// no log, no history yet — those land in slices #498, #499, #500.

const STATUS_STYLES = {
  running: { label: "RUNNING", bg: "bg-emerald-500/15", border: "border-emerald-500/40", text: "text-emerald-300", dot: "bg-emerald-400" },
  wedge:   { label: "RUNNING — WEDGE LIKELY", bg: "bg-amber-500/15", border: "border-amber-500/40", text: "text-amber-300", dot: "bg-amber-400" },
  ended:   { label: "ENDED",   bg: "bg-zinc-500/15", border: "border-zinc-500/40", text: "text-zinc-300", dot: "bg-zinc-400" },
  killed:  { label: "KILLED",  bg: "bg-red-500/15",   border: "border-red-500/40",   text: "text-red-300",   dot: "bg-red-400" },
};

function statusKey(run) {
  if (!run) return "ended";
  if (run.status === "running" && run.wedge_likely) return "wedge";
  if (run.status === "running") return "running";
  if (run.status === "killed") return "killed";
  return "ended";
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function StatusPill({ run }) {
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

function MetaCell({ label, value, mono = false }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`text-sm text-zinc-200 ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

function BudgetBar({ label, current, max, formatValue }) {
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

function truncId(id) {
  if (!id) return "—";
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export default function Autopilot() {
  const { data, error, loading } = useApi("/autopilot/runs/current", { poll: 5000 });

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Autopilot</h1>
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  // 404 (no run yet) bubbles up as `error`. Render a friendly empty state
  // rather than a red error — backfill: the first row appears at next bootstrap.
  if (error || !data) {
    const isNoRun = error && /404|no autopilot runs/i.test(error);
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-2">Autopilot</h1>
        <p className="text-sm text-zinc-500 mb-6">Slice 1 — "Is it alive?" header strip.</p>
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          {isNoRun ? (
            <>
              <h2 className="text-base font-semibold text-zinc-200 mb-1">No autopilot run recorded yet</h2>
              <p className="text-sm text-zinc-500">
                The first row appears when bootstrap.sh runs at the start of the next
                <code className="mx-1 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-xs">hydra-autopilot</code>
                invocation.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load run</h2>
              <p className="text-sm text-zinc-500 font-mono">{error}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const run = data;
  const limits = run.limits || {};
  const tokenBudget = Number(limits.token_budget) || 0;
  const wallClockMax = Number(limits.wall_clock_max_sec) || 0;
  const idleDrainMax = Number(limits.idle_drain_turns) || 0;
  const key = statusKey(run);

  return (
    <div className="p-6">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-white">Autopilot</h1>
        <span className="text-xs text-zinc-500 font-mono">polls every 5s</span>
      </div>
      <p className="text-sm text-zinc-500 mb-6">Slice 1 — "Is it alive?" header strip.</p>

      <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <StatusPill run={run} />
          <span className="text-xs text-zinc-500 font-mono" title={run.run_id}>
            run_id: {truncId(run.run_id)}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <MetaCell label="Started" value={run.started} mono />
          <MetaCell label="Elapsed" value={formatElapsed(run.elapsed_s)} />
          <MetaCell
            label="PID"
            value={
              key === "running"
                ? `${run.pid} ${run.pid_alive ? "(alive)" : "(dead)"}`
                : String(run.pid || "—")
            }
            mono
          />
          <MetaCell label="Trigger" value={run.trigger} />
          <MetaCell label="Term reason" value={run.term_reason || "—"} />
          <MetaCell label="Heartbeat age" value={formatElapsed(run.age_s)} />
        </div>

        <div className="space-y-3">
          <BudgetBar
            label="Tokens"
            current={run.cumulative_tokens}
            max={tokenBudget}
            formatValue={(n) => n.toLocaleString()}
          />
          <BudgetBar
            label="Wall clock (s)"
            current={run.elapsed_s}
            max={wallClockMax}
            formatValue={(n) => `${n}s`}
          />
          <BudgetBar
            label="Idle turns"
            current={run.idle_turns}
            max={idleDrainMax}
            formatValue={(n) => String(n)}
          />
        </div>

        <p className="text-xs text-zinc-600 italic">
          Slice 2 wires per-turn writes — until then, token / idle counters stay at zero.
        </p>
      </div>
    </div>
  );
}
