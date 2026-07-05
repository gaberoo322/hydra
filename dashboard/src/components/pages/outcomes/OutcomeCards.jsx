import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import { Sparkline } from "./Sparkline.jsx";

/**
 * OutcomeCards — one card per declared Target Outcome. Renders gracefully
 * with the single-outcome case (today only `orchestrator-self-improvement-share`
 * is declared) and with N>1.
 *
 * Polls every 5min (slow review cadence per PRD #615).
 */
export function OutcomeCards({ windowDays = 7 }) {
  const { data, error, loading } = useApi(`/outcomes/trends?window=${windowDays}d`, {
    poll: 5 * 60_000,
  });

  const outcomes = data?.outcomes ?? [];

  return (
    <Section
      title="Outcome trends"
      subtitle={`Per-outcome current reading vs baseline.`}
      right={data?.generatedAt && `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
      loading={loading}
      error={error}
      empty={!loading && !error && outcomes.length === 0}
      emptyMessage="No outcomes declared in config/direction/outcomes.yaml."
    >
      <div className={`grid gap-3 ${outcomes.length === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
        {outcomes.map((o) => (
          <OutcomeCard key={o.name} outcome={o} />
        ))}
      </div>
    </Section>
  );
}

function OutcomeCard({ outcome }) {
  const { name, direction, points, baseline, target, deltaPct } = outcome;
  const latest = points && points.length > 0 ? points[points.length - 1] : null;
  const deltaClass = deltaSignClass(deltaPct, direction);
  const targetReached = latest && isTargetReached(latest.v, target, baseline, direction);

  return (
    <div className="bg-zinc-900/40 rounded-md border border-zinc-700 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100 truncate">{name}</div>
          <div className="text-xs text-zinc-500">
            baseline {formatNumber(baseline)} → target {formatNumber(target)} ({direction})
          </div>
        </div>
        <div className={`text-xs px-2 py-0.5 rounded ${deltaClass}`}>
          {deltaPct === null ? "no data" : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Sparkline points={points} width={140} height={32} />
        <div className="text-xs text-zinc-400 text-right">
          {latest && (
            <>
              <div className="text-base font-mono text-zinc-100">{formatNumber(latest.v)}</div>
              <div className="text-zinc-500">latest</div>
            </>
          )}
          {targetReached && (
            <div className="mt-1 text-emerald-300 text-[10px] uppercase tracking-wider">at target</div>
          )}
        </div>
      </div>
    </div>
  );
}

function deltaSignClass(deltaPct, direction) {
  if (deltaPct === null) return "bg-zinc-700/40 text-zinc-400 border border-zinc-700";
  const movingTowardTarget = direction === "up" ? deltaPct > 0 : deltaPct < 0;
  if (Math.abs(deltaPct) < 1) return "bg-zinc-700/40 text-zinc-300 border border-zinc-700";
  return movingTowardTarget
    ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
    : "bg-amber-500/10 text-amber-300 border border-amber-500/30";
}

function isTargetReached(v, target, baseline, direction) {
  if (typeof v !== "number" || typeof target !== "number") return false;
  if (direction === "up") return v >= target;
  return v <= target;
}

function formatNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}
