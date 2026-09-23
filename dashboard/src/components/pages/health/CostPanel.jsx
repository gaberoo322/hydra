import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { formatTokens } from "../../../lib/display-format.ts";

/**
 * CostPanel — the "burning money" half of the /health page (issue #4008,
 * extended by issue #4630).
 *
 * Four headline tiles, each fetched from its OWN endpoint and carrying its
 * OWN server generatedAt (design-concept 2880e735 INV-8, carried forward by
 * #4630 INV-5): they are never blended into one combined cost number and
 * each stays independently timestamped and independently stale-able.
 *
 *   1. 24h token burn        — /metrics/cost-by-class (comprehensive arm)
 *   2. tokens per merged PR  — /metrics/cost-per-merged-pr (30d window)
 *   3. weekly quota burned   — /v2/outcomes/quota (calibrated meter)
 *   4. burn rate             — /now/cost-burn (5h/24h tokens-per-hour; its
 *      OWN tile, deliberately not folded into tile 1's 24h total — INV-5)
 *
 * Behind a collapsed-by-default "Breakdown" <details> (design-concept INV-7):
 * the cost x3 reads homed to this file —
 *   - /metrics/cost            — per-skill token counts, today
 *   - /metrics/cost-efficiency — per-class tokens-per-merged-PR
 *   - /metrics/cost-by-outcome — token split by cycle outcome
 *
 * Every tile obeys the ADR-0034 §5 trust seam via the shared derivePageStatus
 * state machine (the slice-alpha seam, #4006): loading/unknown render UNKNOWN,
 * a failed refresh with retained data renders stale (amber as-of), and an
 * uncalibrated quota meter renders UNKNOWN — never a confident-looking 0%.
 *
 * Phone-grade: big numbers, one line of context each, stacked at 390px. The
 * breakdown detail lives behind the disclosure so it never inflates the
 * headline scroll height.
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

function BurnRateTile() {
  // Minutes-tier budget (design-concept INV-6): its own tile, its own
  // as-of — never folded into BurnTile's 24h total (INV-5).
  const { data, error, loading } = useApi("/now/cost-burn", { poll: 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 10 * 60 * 1000 });
  return (
    <Tile
      testId="cost-burn-rate-tile"
      title="Burn rate"
      status={status}
      generatedAt={data?.generatedAt}
    >
      <div className="text-2xl font-bold text-zinc-100" data-testid="cost-burn-rate-tile-value">
        {formatTokens(data?.tokensPerHour5h)}/h
      </div>
      <div className="text-xs text-zinc-500">
        24h avg: {formatTokens(data?.tokensPerHour24h)}/h
      </div>
    </Tile>
  );
}

/** One row of the Breakdown disclosure: title + its own trust-seamed value. */
function BreakdownRow({ testId, title, path, freshnessMs, render }) {
  const { data, error, loading } = useApi(path, { poll: 5 * 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs });
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  return (
    <div data-testid={testId} className="py-2 border-t border-zinc-800 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{title}</div>
        {data?.generatedAt && (
          <div className="text-[11px] text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={data.generatedAt} stale={stale} />
          </div>
        )}
      </div>
      {unknown ? (
        <div className="text-sm text-zinc-500" data-testid={`${testId}-value`}>
          UNKNOWN
        </div>
      ) : (
        <div className="text-sm text-zinc-300" data-testid={`${testId}-value`}>
          {render(data)}
        </div>
      )}
    </div>
  );
}

/** Activity-tier budget (design-concept INV-6): 5m poll, 30m freshness. */
const BREAKDOWN_FRESHNESS_MS = 30 * 60 * 1000;

function CostBreakdown() {
  return (
    <details data-testid="cost-breakdown" className="text-sm">
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
        Breakdown
      </summary>
      <div className="mt-2">
        <BreakdownRow
          testId="cost-breakdown-by-skill"
          title="Per-skill tokens (today)"
          path="/metrics/cost"
          freshnessMs={BREAKDOWN_FRESHNESS_MS}
          render={(data) => {
            const bySkill = Array.isArray(data?.bySkill) ? data.bySkill : [];
            if (bySkill.length === 0) return "no token activity today";
            return bySkill
              .slice(0, 5)
              .map((s) => `${s.skill}: ${formatTokens(s.tokens)}`)
              .join(" · ");
          }}
        />
        <BreakdownRow
          testId="cost-breakdown-efficiency"
          title="Tokens per merged PR, by class"
          path="/metrics/cost-efficiency"
          freshnessMs={BREAKDOWN_FRESHNESS_MS}
          render={(data) => {
            const byClass = data?.byClass && typeof data.byClass === "object" ? data.byClass : {};
            const entries = Object.entries(byClass);
            if (entries.length === 0) return "no class data";
            return entries
              .map(([cls, v]) => `${cls}: ${v?.tokensPerMergedPr == null ? "—" : formatTokens(v.tokensPerMergedPr)}`)
              .join(" · ");
          }}
        />
        <BreakdownRow
          testId="cost-breakdown-by-outcome"
          title="Tokens by cycle outcome"
          path="/metrics/cost-by-outcome"
          freshnessMs={BREAKDOWN_FRESHNESS_MS}
          render={(data) => {
            const byOutcome = data?.byOutcome && typeof data.byOutcome === "object" ? data.byOutcome : {};
            const entries = Object.entries(byOutcome);
            if (entries.length === 0) return "no outcome data";
            return entries
              .map(([outcome, v]) => `${outcome}: ${formatTokens(v?.attributedTokens)} (${v?.cycles ?? 0})`)
              .join(" · ");
          }}
        />
      </div>
    </details>
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
      <CostBreakdown />
    </section>
  );
}
