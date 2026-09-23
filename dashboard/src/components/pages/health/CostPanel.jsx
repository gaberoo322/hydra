import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { formatTokens } from "../../../lib/display-format.ts";

/**
 * CostPanel — the "burning money" half of the /health page (issue #4008;
 * extended #4630, design-concept 883fd8c2).
 *
 * Headline row — four figures, each fetched from its OWN endpoint and
 * carrying its OWN server generatedAt (design-concept 2880e735 INV-8, carried
 * forward by 883fd8c2 INV-5): never blended into one combined cost number,
 * each independently timestamped and independently stale-able.
 *
 *   1. 24h token burn        — /metrics/cost-by-class (comprehensive arm)
 *   2. tokens per merged PR  — /metrics/cost-per-merged-pr (30d window)
 *   3. weekly quota burned   — /v2/outcomes/quota (calibrated meter)
 *   4. burn rate             — /now/cost-burn (its own tile — NOT folded into
 *                               tile 1's subline, INV-5)
 *
 * Cost x3 breakdown (issue #4630, INV-1/INV-7) — CostPanel additionally owns
 * three more dark GET routes as verbatim `useApi` path literals, rendered
 * behind a collapsed-by-default `<details>` "Breakdown" disclosure so the
 * headline row stays phone-grade:
 *
 *   - /metrics/cost            — per-skill token totals for today
 *   - /metrics/cost-efficiency — per-class tokens-per-merged-PR (QA audit)
 *   - /metrics/cost-by-outcome — token cost split by cycle outcome
 *
 * Every tile/row obeys the ADR-0034 §5 trust seam via the shared
 * derivePageStatus state machine (the slice-alpha seam, #4006): loading/
 * unknown render UNKNOWN, a failed refresh with retained data renders stale
 * (amber as-of), and an uncalibrated quota meter renders UNKNOWN — never a
 * confident-looking 0%.
 *
 * Phone-grade: big numbers, one line of context each, stacked at 390px.
 */

// Token counts render through the dashboard-wide canonical formatTokens
// (lib/display-format.ts, issue #4564) so the same number reads the same on
// every page ("1.5M" / "815K").

function Tile({ testId, title, status, generatedAt, children }) {
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  return (
    <div
      data-testid={testId}
      className="bg-zinc-900/40 rounded-md border border-zinc-700 p-3 sm:p-4 min-w-0"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{title}</div>
        {generatedAt && (
          <div className="text-[11px] text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={generatedAt} stale={stale} />
          </div>
        )}
      </div>
      {unknown ? (
        <div className="text-2xl font-bold text-zinc-500" data-testid={`${testId}-value`}>
          UNKNOWN
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** Trust status for a non-list payload, reused from the slice-alpha seam. */
function payloadStatus({ data, error, loading, freshnessMs }) {
  // itemsLen:1 — a present payload is "non-empty"; the empty branch never
  // applies to scalar figures (emptiness is handled per-tile below).
  return derivePageStatus({ data, error, loading, itemsLen: 1, freshnessMs });
}

function BurnTile() {
  const { data, error, loading } = useApi("/metrics/cost-by-class", { poll: 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 10 * 60 * 1000 });
  const byClass = data?.byClass ?? {};
  const top = Object.entries(byClass).sort((a, b) => (b[1]?.tokens ?? 0) - (a[1]?.tokens ?? 0))[0];
  return (
    <Tile
      testId="cost-burn-tile"
      title="24h token burn"
      status={status}
      generatedAt={data?.generatedAt}
    >
      <div className="text-2xl font-bold text-zinc-100" data-testid="cost-burn-tile-value">
        {formatTokens(data?.totalTokens)}
      </div>
      <div className="text-xs text-zinc-500">
        {top && (top[1]?.tokens ?? 0) > 0
          ? `top: ${top[0]} · ${Math.round((top[1]?.fraction ?? 0) * 100)}%`
          : "all classes idle"}
      </div>
    </Tile>
  );
}

function PerPrTile() {
  const { data, error, loading } = useApi("/metrics/cost-per-merged-pr", { poll: 5 * 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 30 * 60 * 1000 });
  const per = data?.tokensPerMergedPr;
  return (
    <Tile
      testId="cost-per-pr-tile"
      title="Tokens / merged PR"
      status={status}
      generatedAt={data?.generatedAt}
    >
      <div className="text-2xl font-bold text-zinc-100" data-testid="cost-per-pr-tile-value">
        {/* null = no merges in the window: the ratio is UNDEFINED, rendered as
            an explicit em-dash — never a misleading 0. */}
        {per === null || per === undefined ? "—" : formatTokens(per)}
      </div>
      <div className="text-xs text-zinc-500">
        {data?.mergedPrCount > 0
          ? `${formatTokens(data?.totalTokens)} over ${data.mergedPrCount} merges · ${data?.windowDays}d`
          : "no merged PRs in the window"}
      </div>
    </Tile>
  );
}

function QuotaTile() {
  const { data, error, loading } = useApi("/outcomes/quota?window=7d", { poll: 5 * 60_000 });
  // An UNCALIBRATED quota meter has no reading at all — it is UNKNOWN, not a
  // confident 0% (ADR-0034 §5 rule 1).
  const points = data?.percentBurned?.points ?? [];
  const latest = points.length > 0 ? points[points.length - 1].v : null;
  const calibrated = data?.calibrated === true && latest !== null;
  const effectiveData = calibrated ? data : null;
  const status = payloadStatus({
    data: effectiveData,
    error: calibrated ? error : null,
    loading,
    freshnessMs: 10 * 60 * 1000,
  });
  const burned = calibrated ? latest : null;
  return (
    <Tile
      testId="quota-tile"
      title="Weekly quota burned"
      status={status}
      generatedAt={data?.generatedAt}
    >
      <div className="text-2xl font-bold text-zinc-100" data-testid="quota-tile-value">
        {burned === null ? "—" : `${burned.toFixed(1)}%`}
      </div>
      {/* The meter bar: filled share of the weekly quota, amber past 80%. */}
      <div className="mt-2 h-2 rounded-full bg-zinc-700/60 overflow-hidden">
        <div
          className={`h-full rounded-full ${burned !== null && burned > 80 ? "bg-amber-400" : "bg-emerald-400"}`}
          style={burned !== null ? { width: `${Math.min(100, Math.max(0, burned))}%` } : { width: "0%" }}
        />
      </div>
      <div className="text-xs text-zinc-500 mt-1">
        {calibrated ? "weekly subscription quota" : "meter uncalibrated — no verified reading"}
      </div>
    </Tile>
  );
}

/**
 * /now/cost-burn — its own tile (issue #4630, INV-5): tokens/hour over the
 * rolling 5h and 24h windows, deliberately never folded into BurnTile's
 * subline above (a distinct endpoint keeps its own as-of).
 */
function BurnRateTile() {
  const { data, error, loading } = useApi("/now/cost-burn", { poll: 60_000 });
  // Minutes-tier budget (ADR-0034 §5 / design-concept 883fd8c2 INV-6).
  const status = payloadStatus({ data, error, loading, freshnessMs: 10 * 60 * 1000 });
  return (
    <Tile testId="burn-rate-tile" title="Burn rate" status={status} generatedAt={data?.generatedAt}>
      <div className="text-2xl font-bold text-zinc-100" data-testid="burn-rate-tile-value">
        {formatTokens(data?.tokensPerHour5h)}/hr
      </div>
      <div className="text-xs text-zinc-500">{formatTokens(data?.tokensPerHour24h)}/hr over 24h</div>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Cost x3 breakdown (issue #4630, INV-1/INV-7) — collapsed by default, each
// row deriving its OWN trust status from its OWN endpoint.
// ---------------------------------------------------------------------------

function BreakdownRow({ testId, title, status, generatedAt, children }) {
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  return (
    <div data-testid={testId} className="py-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{title}</div>
        {generatedAt && (
          <div className="text-[11px] text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={generatedAt} stale={stale} />
          </div>
        )}
      </div>
      {unknown ? (
        <div className="text-sm text-zinc-500" data-testid={`${testId}-value`}>
          UNKNOWN
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/** /metrics/cost — per-skill token totals for today. */
function PerSkillBreakdown() {
  const { data, error, loading } = useApi("/metrics/cost", { poll: 5 * 60_000 });
  // Activity-tier budget (ADR-0034 §5 / design-concept 883fd8c2 INV-6).
  const status = payloadStatus({ data, error, loading, freshnessMs: 30 * 60 * 1000 });
  const bySkill = Array.isArray(data?.bySkill) ? data.bySkill : [];
  const top = bySkill.slice(0, 3);
  return (
    <BreakdownRow testId="cost-per-skill" title="Per-skill (today)" status={status} generatedAt={data?.generatedAt}>
      {top.length === 0 ? (
        <div className="text-xs text-zinc-500">no per-skill tokens recorded today</div>
      ) : (
        <ul className="space-y-0.5 text-xs text-zinc-300">
          {top.map((s) => (
            <li key={s.skill}>
              {s.skill}: {formatTokens(s.tokens)} · {s.pct}%
            </li>
          ))}
        </ul>
      )}
    </BreakdownRow>
  );
}

/** /metrics/cost-efficiency — per-class tokens-per-merged-PR (QA audit read). */
function PerClassEfficiencyBreakdown() {
  const { data, error, loading } = useApi("/metrics/cost-efficiency", { poll: 5 * 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 30 * 60 * 1000 });
  const qa = data?.qa;
  const qaPerMerge = qa?.tokensPerMergedPr;
  return (
    <BreakdownRow
      testId="cost-efficiency"
      title="Per-class efficiency"
      status={status}
      generatedAt={data?.generatedAt}
    >
      <div className="text-xs text-zinc-300" data-testid="cost-efficiency-qa">
        QA: {qaPerMerge === null || qaPerMerge === undefined ? "—" : `${formatTokens(qaPerMerge)}/merge`}
        {" · "}
        {qa ? `${Math.round((qa.fraction ?? 0) * 100)}% share` : "—"}
      </div>
    </BreakdownRow>
  );
}

/** /metrics/cost-by-outcome — token cost split by cycle outcome. */
function CostByOutcomeBreakdown() {
  const { data, error, loading } = useApi("/metrics/cost-by-outcome", { poll: 5 * 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 30 * 60 * 1000 });
  const byOutcome = data?.byOutcome ?? {};
  return (
    <BreakdownRow testId="cost-by-outcome" title="By outcome" status={status} generatedAt={data?.generatedAt}>
      <ul className="space-y-0.5 text-xs text-zinc-300">
        {["merged", "empty", "failed"].map((k) => {
          const e = byOutcome[k];
          const per = e?.tokensPerCycle;
          return (
            <li key={k}>
              {k}: {per === null || per === undefined ? "—" : `${formatTokens(per)}/cycle`} · {e?.cycles ?? 0} cycles
            </li>
          );
        })}
      </ul>
    </BreakdownRow>
  );
}

export default function CostPanel() {
  return (
    <section data-testid="cost-panel" className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide text-zinc-400">Cost</h2>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <BurnTile />
        <PerPrTile />
        <QuotaTile />
        <BurnRateTile />
      </div>
      <details data-testid="cost-breakdown-disclosure">
        <summary className="cursor-pointer text-xs text-zinc-400">Breakdown</summary>
        <div className="divide-y divide-zinc-800">
          <PerSkillBreakdown />
          <PerClassEfficiencyBreakdown />
          <CostByOutcomeBreakdown />
        </div>
      </details>
    </section>
  );
}
