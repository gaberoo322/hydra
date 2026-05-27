import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

const SEVERITY_STYLES = {
  critical: "bg-red-500/10 text-red-300 border-red-500/30",
  error: "bg-red-500/10 text-red-300 border-red-500/30",
  warning: "bg-yellow-500/10 text-yellow-300 border-yellow-500/30",
  info: "bg-sky-500/10 text-sky-300 border-sky-500/30",
};

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

/**
 * AlertsNow — recent alerts within a 60-minute window by default. Polls
 * every 30s (PRD #615). Thin wrapper over `/api/alerts` reshaped for the
 * Now page widget.
 */
export function AlertsNow({ windowMinutes = 60 }) {
  const { data, error, loading } = useApi(
    `/now/alerts?sinceMinutes=${windowMinutes}`,
    { poll: 30_000 },
  );
  const items = data?.items ?? [];

  return (
    <Section
      title="Recent alerts"
      subtitle={`Last ${data?.windowMinutes ?? windowMinutes} minutes.`}
      count={items.length}
      loading={loading}
      error={error}
      empty={!loading && !error && items.length === 0}
      emptyMessage="No alerts in the window."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((alert) => (
          <li key={alert.id} className="py-2 flex items-start gap-3">
            <span
              className={`px-1.5 py-0.5 text-[10px] rounded border shrink-0 ${SEVERITY_STYLES[alert.severity] || "bg-zinc-700/60 text-zinc-300 border-zinc-600"}`}
            >
              {alert.severity}
            </span>
            <span className="text-xs text-zinc-500 shrink-0">{formatTime(alert.timestamp)}</span>
            <span className="flex-1 min-w-0 text-sm text-zinc-100 truncate" title={alert.message}>
              {alert.message}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
