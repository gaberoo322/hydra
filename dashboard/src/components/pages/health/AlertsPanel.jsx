import { usePageItems } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * AlertsPanel — the /health page's alerts read (issue #4630, ADR-0034 §9.4
 * homing rule).
 *
 * Owns exactly one dark read: GET /alerts (now an envelope
 * `{ alerts, scanned, generatedAt }`, issue #4630 design-concept INV-3 — the
 * one breaking shape change this slice makes, because a bare array could not
 * carry a trust-contract generatedAt).
 *
 * Phone-grade (design-concept INV-7): shows the undismissed count plus the
 * newest 3 undismissed alerts; the rest sits behind a native <details>
 * disclosure — same markup at every viewport, no viewport JS. Dismissed
 * alerts (`dismissed: true`) are excluded from both the count and the list.
 * An asserted-empty undismissed list renders "No active alerts"; a failed or
 * unproven fetch renders UNKNOWN — never a silently-empty list.
 */

const SEVERITY_DOT = {
  error: "bg-rose-400",
  warning: "bg-amber-400",
};

export default function AlertsPanel() {
  // Minutes-tier freshness budget (ADR-0034 §5 / design-concept INV-6).
  const { items, data, status, error } = usePageItems("/alerts", {
    poll: 60_000,
    freshnessMs: 5 * 60 * 1000,
    itemsKey: "alerts",
    filter: (a) => a?.dismissed !== true,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const empty = status === "empty";

  const newest = items.slice(0, 3);
  const rest = items.slice(3);

  return (
    <section data-testid="alerts-panel" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Alerts</h2>
        {data?.generatedAt && (
          <div className="text-[11px] text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={data.generatedAt} stale={stale} />
          </div>
        )}
      </div>

      {unknown ? (
        <div className="text-sm text-zinc-500" data-testid="alerts-count">
          UNKNOWN
        </div>
      ) : empty ? (
        <div className="text-sm text-zinc-500" data-testid="alerts-count">
          No active alerts
        </div>
      ) : (
        <>
          <div className="text-sm text-zinc-300" data-testid="alerts-count">
            {items.length} active alert{items.length === 1 ? "" : "s"}
          </div>
          <ul className="space-y-1" data-testid="alerts-newest">
            {newest.map((a) => (
              <li
                key={a.id}
                data-testid="alerts-item"
                className="flex items-start gap-2 text-xs text-zinc-300 min-w-0 break-words"
              >
                <span
                  className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[a.severity] || "bg-zinc-500"}`}
                  aria-hidden
                />
                <span className="min-w-0 break-words">
                  {a.message || a.type || "alert"}
                  {a.timestamp && (
                    <span className="text-zinc-500">
                      {" · "}
                      <LocalTimestamp ts={a.timestamp} />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <details data-testid="alerts-disclosure">
              <summary className="cursor-pointer text-xs text-zinc-500">
                {rest.length} more
              </summary>
              <ul className="mt-1 space-y-1">
                {rest.map((a) => (
                  <li
                    key={a.id}
                    data-testid="alerts-item"
                    className="flex items-start gap-2 text-xs text-zinc-400 min-w-0 break-words"
                  >
                    <span
                      className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[a.severity] || "bg-zinc-500"}`}
                      aria-hidden
                    />
                    <span className="min-w-0 break-words">
                      {a.message || a.type || "alert"}
                      {a.timestamp && (
                        <span className="text-zinc-500">
                          {" · "}
                          <LocalTimestamp ts={a.timestamp} />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {error && !unknown && (
        <p data-testid="alerts-error" className="text-xs text-rose-400 break-words">
          {error}
        </p>
      )}
    </section>
  );
}
