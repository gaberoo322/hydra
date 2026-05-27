import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";
import { Sparkline } from "./Sparkline.jsx";

/**
 * LessonsTrend — promotion-rate sparkline + top-5 friction table + the
 * count of meta-friction GitHub issues opened in the window.
 *
 * Polls every 5min.
 */
export function LessonsTrend({ windowDays = 7 }) {
  const { data, error, loading } = useApi(`/outcomes/lessons?window=${windowDays}d`, {
    poll: 5 * 60_000,
  });

  const rate = data?.promotionRate ?? [];
  const top = data?.topFriction ?? [];
  const meta = data?.metaFrictionOpened ?? 0;
  const threshold = data?.promotionThreshold ?? 3;
  const isEmpty = rate.length === 0 && top.length === 0 && meta === 0;

  return (
    <Section
      title="Lessons trend"
      subtitle={`Friction promotions in the last ${windowDays}d (threshold ${threshold} hits → meta-friction).`}
      right={data?.generatedAt && `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
      loading={loading}
      error={error}
      empty={!loading && !error && isEmpty}
      emptyMessage="No promotions or meta-friction issues in the window. The system is calibrated."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-6 text-sm text-zinc-300">
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Promotions / day</div>
            <Sparkline points={rate} width={200} height={36} stroke="#f472b6" />
          </div>
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Meta-friction opened</div>
            <div className="text-2xl font-mono text-zinc-100">{meta}</div>
          </div>
        </div>

        {top.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              Top friction <span className="text-zinc-600">({top.length})</span>
            </div>
            <ul className="divide-y divide-zinc-700/50">
              {top.map((f) => (
                <li key={`${f.skill}::${f.cue}`} className="py-1.5 flex items-center gap-3">
                  <span className="text-xs text-zinc-500 w-32 truncate">{f.skill}</span>
                  <span className="text-sm text-zinc-100 flex-1 truncate">{f.cue}</span>
                  <span className="text-xs text-amber-300 shrink-0">{f.hitCount} hits</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
