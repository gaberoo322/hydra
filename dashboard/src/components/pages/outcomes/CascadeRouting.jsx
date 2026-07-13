import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

/**
 * CascadeRouting — cascade-routing escalation telemetry (issue #3284).
 *
 * Reads `GET /api/metrics/cascade-routing` and renders the observability the
 * cascade-routing feature (PR #3274) shipped without: how often decide.py's
 * `_rule_escalation` re-dispatched a cheap-tier class at a stronger model
 * (`cascade_routing_escalation`), how often the Subscription-Usage-Tracker hard
 * stop threw an otherwise-eligible escalation away (`cascade_routing_blocked`),
 * the per-trigger breakdown (subagent_noop vs subagent_failure), and an
 * estimated token cost delta. Answers architecture-review rec #6's open "is
 * cascading paying off, or is the gate too restrictive?".
 *
 * The cost delta is an ESTIMATE (Σ tokens(strong) − tokens(cheap) over the
 * escalations) — the exact realised cost is not known at the decision point the
 * event is emitted. The relative trend, not the absolute number, is the signal.
 * Polls every 5min to match the Outcomes page cadence.
 */

function fmtTokens(n) {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtPct(fraction) {
  if (!Number.isFinite(fraction)) return "0%";
  return `${(fraction * 100).toFixed(0)}%`;
}

export function CascadeRouting() {
  const { data, error, loading } = useApi(`/metrics/cascade-routing`, {
    poll: 5 * 60_000,
  });

  const escalations = typeof data?.escalations === "number" ? data.escalations : 0;
  const blocked = typeof data?.blocked === "number" ? data.blocked : 0;
  const gateBlockRate =
    typeof data?.gateBlockRate === "number" ? data.gateBlockRate : 0;
  const estimatedCostDelta =
    typeof data?.estimatedCostDelta === "number" ? data.estimatedCostDelta : 0;
  const avgCostDeltaPerEscalation =
    typeof data?.avgCostDeltaPerEscalation === "number"
      ? data.avgCostDeltaPerEscalation
      : 0;
  const byTrigger = data?.byTrigger || {};
  const sampleSize = typeof data?.sampleSize === "number" ? data.sampleSize : 0;

  const decisions = escalations + blocked;
  const triggerRows = Object.entries(byTrigger).sort((a, b) => b[1] - a[1]);

  const STATS = [
    { label: "Escalations", value: String(escalations), text: "text-emerald-300" },
    { label: "Gate-blocked", value: String(blocked), text: "text-amber-300" },
    { label: "Gate-block rate", value: fmtPct(gateBlockRate), text: "text-rose-300" },
    {
      label: "Est. cost delta",
      value: `${fmtTokens(estimatedCostDelta)} tok`,
      text: "text-sky-300",
    },
  ];

  return (
    <Section
      title="Cascade routing"
      subtitle="Cheap-tier → strong-model escalations (PR #3274), how often the usage gate throttled them, and the estimated token cost delta."
      right={sampleSize > 0 && `${sampleSize} decisions`}
      loading={loading}
      error={error}
      empty={!loading && !error && decisions === 0}
      emptyMessage="No cascade-routing escalations recorded yet."
    >
      {decisions > 0 && (
        <div className="space-y-4">
          {/* Headline stat grid */}
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            {STATS.map(({ label, value, text }) => (
              <div
                key={label}
                className="flex flex-col gap-1 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-2"
              >
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                  {label}
                </span>
                <span className={`text-sm font-mono ${text}`}>{value}</span>
              </div>
            ))}
          </div>

          {/* Per-escalation average cost delta */}
          <div className="flex items-center justify-between gap-3 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-2">
            <span className="text-sm text-zinc-100">Est. cost delta / escalation</span>
            <span className="text-sm font-mono text-sky-300">
              {escalations > 0 ? `${fmtTokens(avgCostDeltaPerEscalation)} tok` : "—"}
            </span>
          </div>

          {/* Per-trigger breakdown */}
          {triggerRows.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                Escalation trigger
              </div>
              {triggerRows.map(([trigger, count]) => (
                <div
                  key={trigger}
                  className="flex items-center justify-between gap-3 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-1.5"
                >
                  <span className="text-sm font-mono text-zinc-300 truncate">
                    {trigger}
                  </span>
                  <span className="text-sm font-mono text-zinc-100 shrink-0">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
