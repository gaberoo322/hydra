import { useState } from "react";

import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import { Sparkline } from "./Sparkline.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * BuilderHealth — the Builder-Health Scorecard widget (issue #732) plus the
 * per-realm stagnation deep-dive panel (issue #3291, epic #3285, ADR-0028).
 *
 * The builder-side counterpart to the OutcomeCards: "is the 25%
 * self-improvement investment producing a measurably better builder?".
 * Surfaces all six candidate metrics + learning throughput, each with its
 * own native window. Degrades gracefully to "no data yet" when every
 * sub-source is empty — it never errors the page.
 *
 * The deep-dive (this slice) adds a per-realm panel of the four ADR-0028
 * signals (autonomy rate, rework rate, cycle yield, time-to-merge). Each
 * instrumented signal shows a trailing baseline→current sparkline, its
 * self-baseline, and a 'stagnating' badge when the detector reports a
 * sustained breach; an un-instrumented realm signal (dark by construction —
 * e.g. every target signal, autonomy/time-to-merge on this substrate) shows a
 * dark marker rather than a fabricated number. A realm toggle switches
 * orch/target. The panel reads only the `stagnation` block the extended
 * GET /api/builder-health already exposes (#3288) — never a composite index.
 *
 * Polls every 5min (a weekly-review surface, not live monitoring).
 */
export function BuilderHealth({ windowDays = 7, prWindow = 50 }) {
  const { data, error, loading } = useApi(
    `/builder-health?windowDays=${windowDays}&prWindow=${prWindow}`,
    { poll: 5 * 60_000 },
  );

  const [realm, setRealm] = useState("orch");

  const auto = data?.autonomyRate;
  const ttm = data?.timeToMerge;
  const rework = data?.reworkRate;
  const share = data?.selfImprovementShare;
  const mutation = data?.mutationKillRateTrend;
  const scope = data?.scopeViolations;
  const learning = data?.learningThroughput;
  const stagnation = data?.stagnation;

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
      right={
        data?.generatedAt && (
          <>
            Updated <LocalTimestamp ts={data.generatedAt} />
          </>
        )
      }
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

        {/* Per-realm stagnation deep-dive (issue #3291, ADR-0028) */}
        <StagnationPanel panel={stagnation} realm={realm} onRealm={setRealm} />

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

// ---------------------------------------------------------------------------
// Stagnation deep-dive panel (issue #3291, epic #3285, ADR-0028)
// ---------------------------------------------------------------------------

/**
 * The four ADR-0028 signals in the canonical panel order. `panelKey` is the
 * key on `stagnation.signals` when the signal carries a per-realm detector
 * verdict; `null` means the signal has no per-realm series on this substrate
 * (autonomy rate + time-to-merge are GitHub-join aggregates — dark in the
 * per-realm panel by construction, never fabricated).
 */
const STAGNATION_SIGNALS = [
  { key: "autonomyRate", label: "Autonomy rate", panelKey: null },
  { key: "reworkRate", label: "Rework rate", panelKey: "reworkRate" },
  { key: "cycleYield", label: "Cycle yield", panelKey: "cycleYield" },
  { key: "timeToMerge", label: "Time-to-merge", panelKey: null },
];

const REALMS = ["orch", "target"];

/**
 * Per-realm stagnation panel. Renders the four ADR-0028 signals for the
 * selected realm — each instrumented signal with a trailing baseline→current
 * sparkline, its self-baseline, and a 'stagnating' badge on a sustained
 * breach; each un-instrumented signal (dark by construction) with a dark
 * marker. A realm toggle switches orch/target. Pure presentational — reads
 * only the already-computed `stagnation` block off the scorecard.
 */
function StagnationPanel({ panel, realm, onRealm }) {
  if (!panel || !panel.signals) return null;

  const ctx = panel.windowContext;

  return (
    <div className="border-t border-zinc-700/50 pt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-400">
            Stagnation — per-realm, vs self-baseline
          </div>
          <div className="text-xs text-zinc-500">
            Has the builder stopped improving on any signal? (ADR-0028)
          </div>
        </div>
        <RealmToggle realm={realm} onRealm={onRealm} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {STAGNATION_SIGNALS.map((sig) => {
          const result = sig.panelKey ? panel.signals?.[sig.panelKey]?.[realm] ?? null : null;
          return <SignalCell key={sig.key} label={sig.label} result={result} />;
        })}
      </div>

      {ctx && (
        <div className="mt-3 text-xs text-zinc-500">
          Window: {Number.isFinite(ctx.cycles) ? ctx.cycles : 0} cycles · mix{" "}
          {Number.isFinite(ctx.mix?.cleanup) ? ctx.mix.cleanup : 0} cleanup:
          {Number.isFinite(ctx.mix?.feature) ? ctx.mix.feature : 0} feature
          {ctx.anchorTypes && Object.keys(ctx.anchorTypes).length > 0 && (
            <> · {formatAnchorTypes(ctx.anchorTypes)}</>
          )}
        </div>
      )}
    </div>
  );
}

/** The orch/target realm switch. */
function RealmToggle({ realm, onRealm }) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-xs">
      {REALMS.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onRealm(r)}
          aria-pressed={realm === r}
          className={
            realm === r
              ? "px-3 py-1 bg-zinc-700 text-zinc-100"
              : "px-3 py-1 bg-transparent text-zinc-400 hover:text-zinc-200"
          }
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/**
 * One signal cell for the selected realm. A `null` verdict is an
 * un-instrumented (dark) realm signal → a dark marker (never a fabricated
 * number). A `warming` verdict has no trustworthy baseline yet. A `breach`
 * carries the 'stagnating' badge. The trailing sparkline is the honest
 * baseline→current excursion the detector judges.
 */
function SignalCell({ label, result }) {
  if (!result) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
          <DarkMarker />
        </div>
        <div className="mt-1 text-xs text-zinc-600">not instrumented</div>
      </div>
    );
  }

  const breached = result.state === "breach";
  const warming = result.state === "warming";
  const current = Number.isFinite(result.current) ? result.current : null;
  const baseline = Number.isFinite(result.baseline) ? result.baseline : null;

  // Honest trailing shape: the baseline→current move the detector judged. Only
  // build the two-point series when both endpoints exist; otherwise render the
  // single-point (current) so the sparkline never fabricates a trend.
  const points =
    baseline != null && current != null
      ? [{ t: 0, v: baseline }, { t: 1, v: current }]
      : current != null
        ? [{ t: 0, v: current }]
        : [];

  const stroke = breached ? "#fb7185" : warming ? "#a1a1aa" : "#34d399";

  return (
    <div
      className={
        breached
          ? "rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2"
          : "rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2"
      }
    >
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
        {breached ? <StagnatingBadge /> : warming ? <WarmingBadge /> : null}
      </div>
      <div className="mt-1 flex items-center gap-3">
        <Sparkline points={points} width={120} height={28} stroke={stroke} />
        <div className="text-xs text-zinc-400 leading-tight">
          <div>
            now <span className="text-zinc-200 font-mono">{fmtSignal(current)}</span>
          </div>
          <div>
            baseline <span className="text-zinc-300 font-mono">{fmtSignal(baseline)}</span>
          </div>
        </div>
      </div>
      {breached && result.sustainedCycles > 0 && (
        <div className="mt-1 text-xs text-rose-300">
          worse {result.sustainedCycles} cycle{result.sustainedCycles === 1 ? "" : "s"} running
        </div>
      )}
    </div>
  );
}

function StagnatingBadge() {
  return (
    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">
      stagnating
    </span>
  );
}

function WarmingBadge() {
  return (
    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400">
      warming
    </span>
  );
}

/** A dark marker for an un-instrumented realm signal (never a fabricated number). */
function DarkMarker() {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full bg-zinc-700"
      title="un-instrumented on this substrate"
      aria-label="un-instrumented"
    />
  );
}

/** Compact anchor-type distribution (top few) for the window-context footer. */
function formatAnchorTypes(anchorTypes) {
  const entries = Object.entries(anchorTypes)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (entries.length === 0) return "";
  return entries.map(([t, n]) => `${t} ${n}`).join(", ");
}

/** Compact fixed-precision signal value (yield/rework 0..1, kill-rate 0..100). */
function fmtSignal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
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
