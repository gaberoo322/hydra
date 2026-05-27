import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

/**
 * NewTargetFindings — issues labeled `target-backlog` opened in the last
 * `windowHours` hours that sweep hasn't routed yet (not closed and not
 * `in-progress`). These are net-new diagnostics from hydra-target-discover
 * waiting on triage.
 *
 * Polls every 30s per PRD #615.
 */
export function NewTargetFindings({ windowHours = 24 }) {
  const { data, error, loading } = useApi(`/today/findings?windowHours=${windowHours}`, {
    poll: 30_000,
  });
  const items = data?.items ?? [];

  return (
    <Section
      title="New target findings"
      subtitle={`target-backlog issues opened in the last ${data?.windowHours ?? windowHours}h, not yet routed.`}
      count={items.length}
      loading={loading}
      error={error}
      empty={!loading && !error && items.length === 0}
      emptyMessage="No un-routed target findings in the window."
    >
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.number} className="border-l-2 border-amber-500/40 pl-3">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-zinc-100 hover:text-amber-300 block"
            >
              <span className="text-zinc-500 mr-1">#{item.number}</span>
              {item.title}
            </a>
            {item.excerpt && (
              <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{item.excerpt}</p>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
