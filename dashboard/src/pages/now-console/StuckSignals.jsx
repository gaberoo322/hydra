import { useApi } from "../../hooks/useApi.js";
import { rankStuckSignals } from "./console-state.ts";

/**
 * StuckSignals — ranked stuck-signal list (issue #891, now-console-4).
 *
 * Renders the signals from the slice-3 autopilot-health aggregator
 * (/api/now/autopilot-health), ranked highest-severity-first via the same
 * `rankStuckSignals` the hero uses so the two agree on the top signal.
 */

const SEV_STYLE = {
  critical: { border: "border-l-rose-400", chip: "text-rose-300 bg-rose-500/10" },
  warn: { border: "border-l-amber-400", chip: "text-amber-300 bg-amber-500/10" },
  info: { border: "border-l-sky-400", chip: "text-sky-300 bg-sky-500/10" },
};

export default function StuckSignals() {
  const { data, loading } = useApi("/now/autopilot-health", { poll: 30_000 });
  const ranked = rankStuckSignals(data?.signals);

  return (
    <section
      data-testid="stuck-signals"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-zinc-200">Stuck signals</h2>
        {typeof data?.historyWindow === "number" && (
          <span className="text-[10px] text-zinc-500 font-mono">
            last {data.historyWindow} runs
          </span>
        )}
      </div>

      {loading && !data ? (
        <p className="text-xs text-zinc-500 italic">Checking for stall signals…</p>
      ) : ranked.length === 0 ? (
        <p data-testid="stuck-signals-empty" className="text-xs text-emerald-300/80 italic">
          No stuck signals — autopilot looks healthy.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {ranked.map((s, i) => {
            const sev = SEV_STYLE[String(s.severity)] ?? SEV_STYLE.info;
            return (
              <li
                key={`${s.type}-${i}`}
                data-testid="stuck-signal-row"
                data-severity={s.severity}
                className={`border-l-2 ${sev.border} pl-2 py-1`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] rounded px-1.5 py-0.5 font-mono ${sev.chip}`}>
                    {String(s.severity).toUpperCase()}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-400">{s.type}</span>
                </div>
                <p className="text-[11px] text-zinc-300 mt-0.5">{s.summary}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
