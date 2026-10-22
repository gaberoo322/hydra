import { useCallback } from "react";
import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { ControlAffordance, useCheckedRefresh } from "../../ActionAffordance.jsx";
import { alertVerdicts, alertsVerdicts, resolveControlRoute } from "../../../lib/health-verdicts.ts";

/**
 * AlertsPanel — the `/alerts` homing for `/health` (issue #4630,
 * design-concept 883fd8c2, ADR-0034 §5 / #4425).
 *
 * Owns the ONE breaking change in this slice: `GET /alerts` moved from a bare
 * array to the envelope `{ alerts, scanned, generatedAt }` (INV-3) so an
 * asserted-empty undismissed count can render "No active alerts" instead of
 * staying UNKNOWN forever (ADR-0034 §5 rule 2 — a list response must assert
 * its own zero).
 *
 * Phone-grade (INV-7): shows the undismissed count plus the newest 3
 * undismissed alerts; anything beyond that sits behind a native `<details>`
 * disclosure — same markup on every viewport, no viewport-conditional JS.
 * Dismissed alerts never count toward the headline count or the list.
 *
 * Controls (issue #4631, design-concept 5ae4b72c INV-7/8/9/13): every
 * undismissed row — headline and disclosure alike — carries its own Dismiss
 * (`control:health/alert-dismiss`, immediate · undo), and one Dismiss all
 * (`control:health/alerts-dismiss-all`, confirms first) sits beside the
 * `N active` count. Both render through ControlAffordance from the registry
 * entries Health.jsx reads once and passes down as `entries` — this file
 * carries no label, precondition or consequence of its own. The per-row
 * route `/alerts/{id}/dismiss` is resolved through `resolveControlRoute`
 * before the action reaches ActionAffordance, so each alert gets its own
 * undo window. Every write awaits a CHECKED re-read of this file's own
 * `/alerts` read (onFired); a committed dismiss is visible only through that
 * re-read, since the count and list keep excluding dismissed alerts.
 */

/** No registry handed down → every control renders the disabled
 * "registry unavailable" state (fail closed, never a fallback label). */
const NO_ENTRIES = Object.freeze({ ready: false, byKey: new Map() });

const SEVERITY_DOT = {
  error: "bg-rose-400",
  warning: "bg-amber-400",
};

function AsOf({ generatedAt, stale }) {
  if (!generatedAt) return null;
  return (
    <span className="text-[11px] text-zinc-500">
      {stale && <span className="text-amber-400">stale · </span>}
      as of <LocalTimestamp ts={generatedAt} stale={stale} />
    </span>
  );
}

function AlertRow({ alert, entries, onFired }) {
  const alertId = alert?.id;
  const resolveRoute = useCallback((route) => resolveControlRoute(route, { id: alertId }), [alertId]);
  return (
    <li data-testid="alert-row" className="flex items-start gap-2 py-1 text-xs">
      <span
        className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[alert?.severity] ?? "bg-zinc-500"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-zinc-200">
          {alert?.message ?? alert?.type ?? "alert"}
        </span>
        {alert?.timestamp && (
          <span className="text-zinc-500">
            <LocalTimestamp ts={alert.timestamp} />
          </span>
        )}
      </span>
      <span className="shrink-0">
        <ControlAffordance
          registry={entries}
          controlKey="control:health/alert-dismiss"
          testId={`alert-dismiss-${alertId ?? "unknown"}`}
          verdicts={alertVerdicts(alert)}
          resolveRoute={resolveRoute}
          onFired={onFired}
          rereadNoun="health"
        />
      </span>
    </li>
  );
}

export default function AlertsPanel({ entries = NO_ENTRIES }) {
  // Minutes-tier budget (ADR-0034 §5 / design-concept 883fd8c2 INV-6).
  const alertsRead = useApi("/alerts", { poll: 60_000 });
  const { data, error, loading } = alertsRead;
  // The controls' onFired: a CHECKED re-read of this panel's own /alerts
  // read — "health re-read FAILED" when it settles with an error (#4629).
  const refreshAlerts = useCheckedRefresh(alertsRead);
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  const undismissed = alerts.filter((a) => a?.dismissed !== true);

  // itemsLen keys off the UNDISMISSED count, not the raw scanned length — an
  // asserted zero here means "no active alerts", never "nothing was scanned"
  // (INV-7's own-zero-assertion, carried by the envelope's `scanned` field).
  const status = derivePageStatus({
    data,
    error,
    loading,
    itemsLen: undismissed.length,
    freshnessMs: 5 * 60 * 1000,
  });
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const empty = status === "empty";

  const headline = undismissed.slice(0, 3);
  const rest = undismissed.slice(3);

  return (
    <section data-testid="alerts-panel" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Alerts</h2>
        <AsOf generatedAt={data?.generatedAt} stale={stale} />
      </div>

      {unknown ? (
        <div className="text-sm font-bold text-zinc-500" data-testid="alerts-count">
          UNKNOWN
        </div>
      ) : empty ? (
        <div className="text-sm text-emerald-300" data-testid="alerts-count">
          No active alerts
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <div className="text-sm font-bold text-zinc-100" data-testid="alerts-count">
              {undismissed.length} active
            </div>
            <ControlAffordance
              registry={entries}
              controlKey="control:health/alerts-dismiss-all"
              testId="alerts-dismiss-all"
              verdicts={alertsVerdicts(undismissed.length)}
              onFired={refreshAlerts}
              rereadNoun="health"
            />
          </div>
          <ul data-testid="alerts-headline" className="divide-y divide-zinc-800">
            {headline.map((a, i) => (
              <AlertRow
                key={a?.id ?? `${a?.timestamp ?? "alert"}-${i}`}
                alert={a}
                entries={entries}
                onFired={refreshAlerts}
              />
            ))}
          </ul>
          {rest.length > 0 && (
            <details data-testid="alerts-disclosure">
              <summary className="cursor-pointer text-xs text-zinc-400">{rest.length} more</summary>
              <ul className="divide-y divide-zinc-800">
                {rest.map((a, i) => (
                  <AlertRow
                    key={a?.id ?? `${a?.timestamp ?? "alert"}-rest-${i}`}
                    alert={a}
                    entries={entries}
                    onFired={refreshAlerts}
                  />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
