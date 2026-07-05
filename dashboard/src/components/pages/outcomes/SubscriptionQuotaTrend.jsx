import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import { Sparkline } from "./Sparkline.jsx";

/**
 * SubscriptionQuotaTrend — % burned (area-style) + headroom (inverse line)
 * over the window. Shows an "uncalibrated" state when the quota env vars
 * are not set.
 *
 * Polls every 5min.
 */
export function SubscriptionQuotaTrend({ windowDays = 7 }) {
  const { data, error, loading } = useApi(`/outcomes/quota?window=${windowDays}d`, {
    poll: 5 * 60_000,
  });

  const burned = data?.percentBurned?.points ?? [];
  const headroom = data?.headroom?.points ?? [];
  const calibrated = data?.calibrated === true;
  const latestBurn = burned.length > 0 ? burned[burned.length - 1].v : null;

  return (
    <Section
      title="Subscription quota"
      subtitle={
        calibrated
          ? `Weekly burn vs headroom (current reading).`
          : `Uncalibrated — set HYDRA_USAGE_WEEKLY_QUOTA_TOKENS and HYDRA_USAGE_5H_QUOTA_TOKENS to enable.`
      }
      right={data?.generatedAt && `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
      loading={loading}
      error={error}
      empty={!loading && !error && burned.length === 0 && headroom.length === 0}
      emptyMessage="No usage snapshots in the window."
    >
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <div className="bg-zinc-900/40 rounded-md border border-zinc-700 p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="text-sm font-semibold text-zinc-100">% burned</div>
              <div className="text-xs text-zinc-500">weekly quota consumed</div>
            </div>
            {latestBurn !== null && (
              <div className="text-right">
                <div className="text-base font-mono text-zinc-100">{latestBurn.toFixed(1)}%</div>
                <div className="text-[10px] text-zinc-500">latest</div>
              </div>
            )}
          </div>
          <Sparkline points={burned} width={220} height={48} stroke="#ef4444" fill="rgba(239,68,68,0.10)" />
        </div>
        <div className="bg-zinc-900/40 rounded-md border border-zinc-700 p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="text-sm font-semibold text-zinc-100">Headroom</div>
              <div className="text-xs text-zinc-500">100% − burned</div>
            </div>
            {headroom.length > 0 && (
              <div className="text-right">
                <div className="text-base font-mono text-zinc-100">
                  {headroom[headroom.length - 1].v.toFixed(1)}%
                </div>
                <div className="text-[10px] text-zinc-500">latest</div>
              </div>
            )}
          </div>
          <Sparkline points={headroom} width={220} height={48} stroke="#34d399" />
        </div>
      </div>
    </Section>
  );
}
