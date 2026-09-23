import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * AlertsPanel — /health's home for the previously-dark `GET /alerts` read
 * (issue #4630, ADR-0034 §9.4).
 *
 * The route now returns an envelope, `{ items, generatedAt }` (issue #4630 —
 * a bare array can't carry the as-of the trust seam needs), where each item
 * may carry a `dismissed` boolean written by `POST /alerts/:id/dismiss`.
 * Phone-grade per the issue's contract: the fold shows a count of ACTIVE
 * (non-dismissed) alerts plus the newest three; the full list sits behind a
 * `<details>` disclosure so a busy alert stream never pushes the rest of
 * /health below the fold.
 *
 * Obeys the ADR-0034 §5 trust seam via the shared derivePageStatus state
 * machine: loading/unknown render UNKNOWN, a failed refresh with retained
 * data renders stale (amber as-of) — never a confident-looking "0 active".
 */

const SEVERITY_DOT = {
  error: "bg-rose-400",
  warning: "bg-amber-400",
};

/** Trust status for the `{items, generatedAt}` payload via the shared seam. */
function payloadStatus({ data, error, loading, freshnessMs }) {
  return derivePageStatus({ data, error, loading, itemsLen: data?.items?.length ?? 0, freshnessMs });
}

export default function AlertsPanel() {
  const { data, error, loading } = useApi("/alerts", { poll: 60_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 10 * 60 * 1000 });
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";

  const all = data?.items ?? [];
  const active = all.filter((a) => a?.dismissed !== true);
  const newest = active.slice(0, 3);
  const rest = active.slice(3);

  return (
    <section data-testid="alerts-section" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Alerts</h2>
        {data?.generatedAt && (
          <div className="text-xs text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={data.generatedAt} stale={stale} />
          </div>
        )}
      </div>
      {unknown ? (
        <span
          data-testid="alerts-chip"
          className="inline-block rounded-md px-3 py-1.5 text-sm font-bold bg-zinc-700/40 text-zinc-400 border border-zinc-600"
        >
          UNKNOWN
        </span>
      ) : active.length === 0 ? (
        <p className="text-xs text-zinc-500" data-testid="alerts-empty">
          no active alerts
        </p>
      ) : (
        <>
          <p className="text-sm font-semibold text-zinc-100" data-testid="alerts-count">
            {active.length} active
          </p>
          <ul className="space-y-1" data-testid="alerts-newest">
            {newest.map((a) => (
              <li key={a.id} className="flex items-center gap-1.5 text-xs text-zinc-400">
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[a.severity] ?? "bg-zinc-500"}`}
                  aria-hidden
                />
                <span className="truncate">{a.message}</span>
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <details data-testid="alerts-disclosure">
              <summary className="cursor-pointer text-xs text-zinc-500">show all {active.length}</summary>
              <ul className="mt-1 space-y-1">
                {rest.map((a) => (
                  <li key={a.id} className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[a.severity] ?? "bg-zinc-500"}`}
                      aria-hidden
                    />
                    <span className="truncate">{a.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
