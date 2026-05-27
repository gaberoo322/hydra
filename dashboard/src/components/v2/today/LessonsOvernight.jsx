import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

/**
 * LessonsOvernight — two correlated learning-system signals:
 *
 *   - promotionCandidates — friction patterns close to the
 *     PROMOTION_THRESHOLD that would auto-escalate on the next hit.
 *   - metaFrictionOpened — `meta-friction` GitHub issues opened in the
 *     window (i.e. patterns that already crossed the threshold).
 *
 * Polls every 30s per PRD #615.
 */
export function LessonsOvernight({ windowHours = 24 }) {
  const { data, error, loading } = useApi(`/v2/today/lessons-overnight?windowHours=${windowHours}`, {
    poll: 30_000,
  });

  const candidates = data?.promotionCandidates ?? [];
  const opened = data?.metaFrictionOpened ?? [];
  const threshold = data?.promotionThreshold ?? 3;
  const total = candidates.length + opened.length;

  return (
    <Section
      title="Lessons (overnight)"
      subtitle={`Threshold: ${threshold} hits → meta-friction issue.`}
      count={total}
      loading={loading}
      error={error}
      empty={!loading && !error && total === 0}
      emptyMessage="No promotions or near-promotions. The agents aren't hitting repeat friction."
    >
      <div className="space-y-4">
        {candidates.length > 0 && (
          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              Near promotion <span className="text-zinc-600">({candidates.length})</span>
            </h3>
            <ul className="divide-y divide-zinc-700/50">
              {candidates.map((c) => (
                <li key={`${c.skill}::${c.cue}`} className="py-1.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-zinc-500 mr-2">{c.skill}</span>
                    <span className="text-sm text-zinc-100 truncate">{c.cue}</span>
                  </div>
                  <span className="text-xs text-amber-300 shrink-0">
                    {c.hitCount}/{threshold}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {opened.length > 0 && (
          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              meta-friction opened <span className="text-zinc-600">({opened.length})</span>
            </h3>
            <ul className="divide-y divide-zinc-700/50">
              {opened.map((i) => (
                <li key={i.number} className="py-1.5">
                  <a
                    href={i.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-zinc-100 hover:text-violet-300 truncate block"
                  >
                    <span className="text-zinc-500 mr-1">#{i.number}</span>
                    {i.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
