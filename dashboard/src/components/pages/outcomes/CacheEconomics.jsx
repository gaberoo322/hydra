import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * CacheEconomics — point-in-time cache-hit ratios from the Subscription
 * Usage Tracker (issue #694). Surfaces `cacheHitRatioLast5h` and
 * `cacheHitRatioLast7d` as percentages: the share of cache-eligible input
 * tokens that were served from the prompt cache rather than re-billed.
 *
 * Formula (computed server-side): cacheRead / (cacheRead + cacheCreation +
 * input). Higher is better; a falling ratio means the next hour's tokens
 * get more expensive. No threshold / warning state in v1 — just the
 * numbers, following the tracker's calibration-discipline pattern.
 *
 * NB: unlike its sibling panels (which poll the `/outcomes/*` 7-day trend
 * endpoints), this panel reads `GET /api/usage` — a live point-in-time
 * snapshot, not a time series. That divergence is intentional: the
 * cache-hit ratios are snapshot fields on UsageSnapshot, not a projected
 * trend. Polls every 5min to match the rest of the Outcomes page cadence.
 */
const RATIO_TOOLTIP =
  "Share of cache-eligible input tokens served from cache: " +
  "cacheRead / (cacheRead + cacheCreation + input). " +
  "Higher is better; falling = next hour gets more expensive.";

export function CacheEconomics() {
  const { data, error, loading } = useApi(`/usage`, { poll: 5 * 60_000 });

  const ratio5h = typeof data?.cacheHitRatioLast5h === "number" ? data.cacheHitRatioLast5h : null;
  const ratio7d = typeof data?.cacheHitRatioLast7d === "number" ? data.cacheHitRatioLast7d : null;

  return (
    <Section
      title="Cache economics"
      subtitle="Cache-hit ratio as a leading indicator of quota burn. Higher is better."
      right={
        data?.generatedAt && (
          <>
            Updated <LocalTimestamp ts={data.generatedAt} />
          </>
        )
      }
      loading={loading}
      error={error}
      empty={!loading && !error && ratio5h === null && ratio7d === null}
      emptyMessage="No usage snapshot available yet."
    >
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <RatioCard label="Cache hit (5h)" sublabel="last 5 hours" ratio={ratio5h} />
        <RatioCard label="Cache hit (7d)" sublabel="last 7 days" ratio={ratio7d} />
      </div>
    </Section>
  );
}

function RatioCard({ label, sublabel, ratio }) {
  return (
    <div
      className="bg-zinc-900/40 rounded-md border border-zinc-700 p-4"
      title={RATIO_TOOLTIP}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{label}</div>
          <div className="text-xs text-zinc-500">{sublabel}</div>
        </div>
        <div className="text-right">
          <div className="text-base font-mono text-zinc-100">
            {ratio === null ? "—" : `${(ratio * 100).toFixed(1)}%`}
          </div>
          <div className="text-[10px] text-zinc-500">cache hit</div>
        </div>
      </div>
    </div>
  );
}
