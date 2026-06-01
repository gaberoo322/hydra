import { usePageItems } from "../../../hooks/usePageItems.js";
import { SeverityBadge } from "../../badges/Badges.jsx";
import { formatTimeOfDay } from "../../../lib/page-item-format.ts";
import { Section } from "./Section.jsx";

/**
 * AlertsNow — recent alerts within a 60-minute window by default. Polls
 * every 30s (PRD #615). Thin wrapper over `/api/alerts` reshaped for the
 * Now page widget.
 *
 * Thin renderer over the page-item seam (issue #822): SeverityBadge + the
 * shared time-of-day formatter.
 */
export function AlertsNow({ windowMinutes = 60 }) {
  const { items, data, status, error, loading } = usePageItems(
    `/now/alerts?sinceMinutes=${windowMinutes}`,
    { poll: 30_000 },
  );

  return (
    <Section
      title="Recent alerts"
      subtitle={`Last ${data?.windowMinutes ?? windowMinutes} minutes.`}
      count={items.length}
      loading={loading}
      error={error}
      empty={status === "empty"}
      emptyMessage="No alerts in the window."
    >
      <ul className="divide-y divide-zinc-700/50">
        {items.map((alert) => (
          <li key={alert.id} className="py-2 flex items-start gap-3">
            <SeverityBadge severity={alert.severity} />
            <span className="text-xs text-zinc-500 shrink-0">{formatTimeOfDay(alert.timestamp)}</span>
            <span className="flex-1 min-w-0 text-sm text-zinc-100 truncate" title={alert.message}>
              {alert.message}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
