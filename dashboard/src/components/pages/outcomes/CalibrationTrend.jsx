import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import { Sparkline } from "./Sparkline.jsx";

/**
 * CalibrationTrend — dual sparkline: tier-accuracy and cost-accuracy
 * (= confidence vs merge outcome) over the window. Higher is better;
 * the dashboard renders the latest value alongside the trend.
 *
 * Polls every 5min.
 */
export function CalibrationTrend({ windowDays = 7 }) {
  const { data, error, loading } = useApi(`/outcomes/calibration?window=${windowDays}d`, {
    poll: 5 * 60_000,
  });

  const tier = data?.tierAccuracy ?? { points: [], sampleSize: 0 };
  const cost = data?.costAccuracy ?? { points: [], sampleSize: 0 };
  const totalSamples = tier.sampleSize + cost.sampleSize;

  return (
    <Section
      title="Calibration trend"
      subtitle="Predicted tier and confidence vs actual merge outcomes."
      right={data?.generatedAt && `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
      loading={loading}
      error={error}
      empty={!loading && !error && totalSamples === 0}
      emptyMessage="No calibration records in the window — anchor-scorer hasn't recorded any cycle outcomes yet."
    >
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <CalibrationCard label="Tier accuracy" series={tier} stroke="#34d399" />
        <CalibrationCard label="Cost accuracy" series={cost} stroke="#fbbf24" />
      </div>
    </Section>
  );
}

function CalibrationCard({ label, series, stroke }) {
  const points = series?.points ?? [];
  const sampleSize = series?.sampleSize ?? 0;
  const latest = points.length > 0 ? points[points.length - 1] : null;
  return (
    <div className="bg-zinc-900/40 rounded-md border border-zinc-700 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{label}</div>
          <div className="text-xs text-zinc-500">{sampleSize} sample{sampleSize === 1 ? "" : "s"}</div>
        </div>
        {latest && (
          <div className="text-right">
            <div className="text-base font-mono text-zinc-100">{(latest.v * 100).toFixed(0)}%</div>
            <div className="text-[10px] text-zinc-500">latest</div>
          </div>
        )}
      </div>
      <Sparkline points={points} width={200} height={40} stroke={stroke} />
    </div>
  );
}
