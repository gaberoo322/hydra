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
 * the per-trigger breakdown (subagent_noop vs subagent_failure), the REALISED
 * token cost delta, and the post-escalation merge rate. Answers architecture-
 * review rec #6's open "is cascading paying off, or is the gate too restrictive?".
 *
 * The cost delta is the ACTUAL per-dispatch token spend recorded on the escalated
 * dispatches' outcome records (#2942, the authoritative ADR-0016 token plane) —
 * NOT a re-estimated per-model budget (design-concept invariant 7). The
 * post-escalation merge rate (`postEscalationMergeRate`, invariant 8) is the
 * fraction of terminal escalated dispatches that still merged — the measurement
 * of the issue's ">85% escalation-triggered cycles still merge" criterion.
 * Because these two figures derive from the outcome plane (which lags the
 * decision-time count until the escalated attempts reap), they read 0 with an
 * explicit "not yet measured" hint until the first escalated dispatch settles.
 * Polls every 5min to match the Outcomes page cadence.
 *
 * Low-N guard (issue #3284 success criterion c + design-concept q6): a sample of
 * 1–9 cascade decisions is too small to answer "what % cost savings has
 * cascading delivered?" within 1 SD, so the card renders an explicit
 * "measurement insufficient" notice instead of a misleadingly-precise raw-stat
 * grid. N===0 keeps the neutral empty state; N>=10 renders the full telemetry.
 */
const MIN_SAMPLE = 10;

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
  const costDeltaTokens =
    typeof data?.costDeltaTokens === "number" ? data.costDeltaTokens : 0;
  const avgCostDeltaPerEscalation =
    typeof data?.avgCostDeltaPerEscalation === "number"
      ? data.avgCostDeltaPerEscalation
      : 0;
  const measuredEscalations =
    typeof data?.measuredEscalations === "number" ? data.measuredEscalations : 0;
  const postEscalationMergeRate =
    typeof data?.postEscalationMergeRate === "number"
      ? data.postEscalationMergeRate
      : 0;
  const terminalEscalations =
    typeof data?.terminalEscalations === "number" ? data.terminalEscalations : 0;
  const byTrigger = data?.byTrigger || {};
  const sampleSize = typeof data?.sampleSize === "number" ? data.sampleSize : 0;

  const decisions = escalations + blocked;
  const triggerRows = Object.entries(byTrigger).sort((a, b) => b[1] - a[1]);

  // Low-N guard: N is the aggregate cascade-decision sample the endpoint folded.
  // 1–9 is too small to report a cost-savings answer within 1 SD (criterion c),
  // so we surface "measurement insufficient" rather than a misleading stat grid.
  const insufficient = sampleSize > 0 && sampleSize < MIN_SAMPLE;

  const STATS = [
    { label: "Escalations", value: String(escalations), text: "text-emerald-300" },
    { label: "Gate-blocked", value: String(blocked), text: "text-amber-300" },
    { label: "Gate-block rate", value: fmtPct(gateBlockRate), text: "text-rose-300" },
    {
      label: "Cost delta (actual)",
      // Realised token spend of the escalated dispatches (#2942). Reads "—" until
      // the first escalated attempt reaps a token figure (the outcome plane lags
      // the decision-time count).
      value: measuredEscalations > 0 ? `${fmtTokens(costDeltaTokens)} tok` : "—",
      text: "text-sky-300",
    },
  ];

  return (
    <Section
      title="Cascade routing"
      subtitle="Cheap-tier → strong-model escalations (PR #3274), how often the usage gate throttled them, their actual token cost delta, and the post-escalation merge rate."
      right={sampleSize > 0 && `${sampleSize} decisions`}
      loading={loading}
      error={error}
      empty={!loading && !error && sampleSize === 0}
      emptyMessage="No cascade-routing escalations recorded yet."
    >
      {insufficient && (
        <div className="bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-3 text-sm text-zinc-400">
          <div className="font-semibold text-zinc-300">Measurement insufficient</div>
          <div className="mt-1 text-xs text-zinc-500">
            Only {sampleSize} cascade{" "}
            {sampleSize === 1 ? "decision" : "decisions"} recorded (need{" "}
            {MIN_SAMPLE}). Too small a sample to report escalation cost savings
            within 1 SD — collecting more data.
          </div>
        </div>
      )}

      {!insufficient && sampleSize >= MIN_SAMPLE && (
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

          {/* Post-escalation merge rate (design-concept invariant 8): the
              fraction of TERMINAL escalated dispatches that still merged — the
              measurement of the issue's >85% success criterion. "—" until the
              first escalated dispatch reaches a merged/failed outcome. */}
          <div className="flex items-center justify-between gap-3 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-2">
            <span className="text-sm text-zinc-100">Post-escalation merge rate</span>
            <span className="text-sm font-mono text-emerald-300">
              {terminalEscalations > 0
                ? `${fmtPct(postEscalationMergeRate)} (${terminalEscalations})`
                : "not yet measured"}
            </span>
          </div>

          {/* Per-escalation average ACTUAL cost delta (#2942). "—" until the
              first escalated dispatch reaps a token figure. */}
          <div className="flex items-center justify-between gap-3 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-2">
            <span className="text-sm text-zinc-100">Cost delta / escalation (actual)</span>
            <span className="text-sm font-mono text-sky-300">
              {measuredEscalations > 0
                ? `${fmtTokens(avgCostDeltaPerEscalation)} tok`
                : "not yet measured"}
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
