import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import { Sparkline } from "./Sparkline.jsx";

/**
 * BuilderHealth — the Builder-Health Scorecard widget (issue #732).
 *
 * The builder-side counterpart to the OutcomeCards: "is the 25%
 * self-improvement investment producing a measurably better builder?".
 * Surfaces all six candidate metrics + learning throughput, each with its
 * own native window. Degrades gracefully to "no data yet" when every
 * sub-source is empty — it never errors the page.
 *
 * Polls every 5min (a weekly-review surface, not live monitoring).
 */
export function BuilderHealth({ windowDays = 7, prWindow = 50 }) {
  const { data, error, loading } = useApi(
    `/builder-health?windowDays=${windowDays}&prWindow=${prWindow}`,
    { poll: 5 * 60_000 },
  );

  const auto = data?.autonomyRate;
  const ttm = data?.timeToMerge;
  const rework = data?.reworkRate;
  const share = data?.selfImprovementShare;
  const mutation = data?.mutationKillRateTrend;
  const scope = data?.scopeViolations;
  const learning = data?.learningThroughput;

  const isEmpty =
    !data ||
    ((auto?.total ?? 0) === 0 &&
      (ttm?.samples ?? 0) === 0 &&
      (rework?.window ?? 0) === 0 &&
      (share?.window ?? 0) === 0 &&
      (mutation?.series?.length ?? 0) === 0 &&
      (scope?.total ?? 0) === 0 &&
      (learning?.metaFrictionOpened ?? 0) === 0 &&
      (learning?.promotionRate?.length ?? 0) === 0);

  return (
    <Section
      title="Builder health"
      subtitle="Is the 25% self-improvement investment producing a measurably better builder?"
      right={data?.generatedAt && `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
      loading={loading}
      error={error}
      empty={!loading && !error && isEmpty}
      emptyMessage="No builder-health data yet — scorecard tracking is enabled and will fill in as dispatches land."
    >
      <div className="space-y-5">
        {/* Headline row: Autonomy rate + time-to-merge */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat
            label="Autonomy rate"
            value={auto && auto.total > 0 ? `${Math.round((auto.rate || 0) * 100)}%` : "—"}
            sub={auto && auto.total > 0 ? `${auto.autonomous}/${auto.total} PRs` : "no merged PRs"}
            accent="text-emerald-300"
          />
          <Stat
            label="Time-to-merge (median)"
            value={ttm && ttm.medianMinutes != null ? formatMinutes(ttm.medianMinutes) : "—"}
            sub={ttm && ttm.p90Minutes != null ? `p90 ${formatMinutes(ttm.p90Minutes)}` : `${ttm?.samples ?? 0} merges`}
          />
          <Stat
            label="Self-improvement share"
            value={share && share.window > 0 ? `${Math.round((share.share || 0) * 100)}%` : "—"}
            sub={
              share && share.window > 0
                ? `floor ${Math.round((share.floor || 0.25) * 100)}% ${share.floorMet ? "✅" : "⚠️"}`
                : "no cycles"
            }
            accent={share && !share.floorMet ? "text-amber-300" : "text-zinc-100"}
          />
          <Stat
            label="Scope violations"
            value={scope ? String(scope.total) : "—"}
            sub={scope ? `last ${scope.windowDays}d` : ""}
          />
        </div>

        {/* Rework + learning row */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Rework rate</div>
            <div className="text-zinc-200">
              {rework && rework.window > 0
                ? `${rework.regressionRate}% regressions · ${rework.noOpMergeRate}% no-op`
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Learning throughput</div>
            <div className="text-zinc-200">
              {learning
                ? `${learning.metaFrictionOpened} meta-friction · ${learning.designConceptsProducedToday} concepts today`
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Mutation kill-rate</div>
            <Sparkline points={mutation?.series ?? []} width={180} height={32} stroke="#34d399" />
          </div>
        </div>

        {/* Trend sparklines */}
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Scope violations / day</div>
            <Sparkline points={scope?.series ?? []} width={180} height={32} stroke="#fb7185" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Promotions / day</div>
            <Sparkline points={learning?.promotionRate ?? []} width={180} height={32} stroke="#f472b6" />
          </div>
        </div>

        {/* Non-autonomous breakdown — why a PR was counted as intervention */}
        {auto?.breakdown?.some((d) => !d.autonomous) && (
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Non-autonomous PRs</div>
            <ul className="divide-y divide-zinc-700/50">
              {auto.breakdown
                .filter((d) => !d.autonomous)
                .slice(0, 8)
                .map((d) => (
                  <li key={d.prNumber} className="py-1 flex items-center gap-3 text-sm">
                    <span className="text-zinc-400 font-mono">#{d.prNumber}</span>
                    <span className="text-zinc-300">{d.reason}</span>
                  </li>
                ))}
            </ul>
          </div>
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

function formatMinutes(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m)) return "—";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 24 * 60) return `${(m / 60).toFixed(1)}h`;
  return `${(m / (24 * 60)).toFixed(1)}d`;
}
