import { useApi } from "../../../hooks/useApi.js";
import { Section } from "../today/Section.jsx";
import { Sparkline } from "../outcomes/Sparkline.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * QualityGates — the /builder page's quality-gate trends panel (issue #4011,
 * ADR-0034 §2): mutation kill-rate percentiles + JIT trend from
 * /metrics/quality-gates.
 *
 * Trust note (ADR-0034 §5, deliberate): this endpoint carries NO top-level
 * `generatedAt` (its backing files are outside #4011's scope, so it cannot
 * gain one here), so the panel does NOT render through usePageItems — that
 * would pin it to `unknown` forever, or worse, invite a fabricated
 * timestamp. Instead it derives an honest as-of signal from the latest trend
 * entry's real `completedAt` field (the trend is newest-first) and shows it
 * as the panel's age. When no entry carries a timestamp, the as-of reads
 * UNKNOWN rather than guessing.
 *
 * No action controls (ADR-0034 §2: /builder "must not show anything
 * actionable today").
 */
export function QualityGates({ cycles = 25 }) {
  const { data, error, loading } = useApi(`/metrics/quality-gates?count=${cycles}`, {
    poll: 5 * 60_000,
  });

  const trend = data?.trend ?? [];
  const summary = data?.summary;

  // Newest-first trend → the first entry with a real completedAt is the
  // honest as-of for the whole panel.
  const asOf = trend.find((e) => e.completedAt)?.completedAt ?? null;

  const killPoints = trend
    .filter((e) => typeof e.killRate === "number")
    .map((e) => ({ t: Date.parse(e.completedAt ?? "") || 0, v: e.killRate }))
    .reverse();

  const empty = !loading && !error && trend.length === 0;

  return (
    <Section
      title="Quality gates"
      subtitle="Mutation kill-rate + JIT tests kept, per cycle — is verification depth holding?"
      count={trend.length}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage="No quality-gate cycles recorded yet."
      generatedAt={asOf ?? undefined}
      unknown={!loading && !error && trend.length > 0 && !asOf}
    >
      <div className="space-y-5">
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat
              label="Avg kill-rate"
              value={summary.avgKillRate != null ? `${summary.avgKillRate}%` : "—"}
              sub={`${summary.cyclesWithMutationData}/${summary.cycles} cycles with data`}
            />
            <Stat
              label="p50 kill-rate"
              value={summary.killRateP50 != null ? `${summary.killRateP50}%` : "—"}
            />
            <Stat
              label="p95 kill-rate"
              value={summary.killRateP95 != null ? `${summary.killRateP95}%` : "—"}
            />
            <Stat
              label="Gate blocks"
              value={String(summary.gateBlockCount ?? 0)}
              sub={`${summary.totalJitTestsAdded ?? 0} JIT tests kept`}
              accent={(summary.gateBlockCount ?? 0) > 0 ? "text-amber-300" : "text-zinc-100"}
            />
          </div>
        )}

        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
            Kill-rate per cycle (oldest → newest)
          </div>
          {killPoints.length > 0 ? (
            <Sparkline points={killPoints} width={360} height={40} stroke="#34d399" />
          ) : (
            <div className="text-sm text-zinc-500">No cycles with mutation data yet.</div>
          )}
        </div>

        {trend.length > 0 && (
          <p className="text-xs text-zinc-500">
            as of{" "}
            {asOf ? (
              <LocalTimestamp ts={asOf} />
            ) : (
              <span className="text-zinc-400">UNKNOWN — no completed cycle carries a timestamp</span>
            )}
          </p>
        )}
      </div>
    </Section>
  );
}

function Stat({ label, value, sub, accent = "text-zinc-100" }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{label}</div>
      <div className={`text-2xl font-mono ${accent}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
