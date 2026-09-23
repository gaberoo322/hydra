import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * ServiceStrip — the "is the machine running" compact row (issue #4630,
 * design-concept 883fd8c2, ADR-0034 §5, #4425).
 *
 * Owns two of the eight dark GET routes homed by this slice — `/now/service-
 * strip` (external service liveness) and `/scheduler/status` (heartbeat
 * lifecycle) — as verbatim `useApi` path literals (INV-1): no other file may
 * fetch either path.
 *
 * Renders as ONE compact chip/light row (INV-7), same markup on every
 * viewport. It deliberately does NOT duplicate the autopilot pause/resume
 * chip Health.jsx already owns off `GET /health`, and does NOT compute a
 * derived "stalled" verdict — the scheduler panel renders only the fields
 * `/scheduler/status` actually reports: running, stopReason, lastTickAt,
 * consecutiveErrors, lastError (INV-9; a derived verdict would have to
 * decompose per ADR-0034 §5 rule 3, out of scope for this read-only slice).
 *
 * Trust seam (INV-4/INV-5/INV-6): each of the two endpoints derives its OWN
 * status through the shared `derivePageStatus` machine with its OWN budget —
 * `/now/service-strip` polls 30s/budget 2m, `/scheduler/status` polls
 * 60s/budget 5m — and renders its own as-of, never blended into one row.
 */

function Dot({ ok, title }) {
  const color = ok === true ? "bg-emerald-400" : ok === false ? "bg-rose-400" : "bg-zinc-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden title={title} />;
}

function payloadStatus({ data, error, loading, freshnessMs }) {
  return derivePageStatus({ data, error, loading, itemsLen: 1, freshnessMs });
}

function AsOf({ generatedAt, stale }) {
  if (!generatedAt) return null;
  return (
    <span className="text-[11px] text-zinc-500">
      {stale && <span className="text-amber-400">stale · </span>}
      as of <LocalTimestamp ts={generatedAt} stale={stale} />
    </span>
  );
}

export default function ServiceStrip() {
  // Minutes-tier budgets (ADR-0034 §5 / design-concept 883fd8c2 INV-6).
  const strip = useApi("/now/service-strip", { poll: 30_000 });
  const sched = useApi("/scheduler/status", { poll: 60_000 });

  const stripStatus = payloadStatus({
    data: strip.data,
    error: strip.error,
    loading: strip.loading,
    freshnessMs: 2 * 60 * 1000,
  });
  const schedStatus = payloadStatus({
    data: sched.data,
    error: sched.error,
    loading: sched.loading,
    freshnessMs: 5 * 60 * 1000,
  });

  const stripUnknown = stripStatus === "loading" || stripStatus === "unknown";
  const stripStale = stripStatus === "stale";
  const schedUnknown = schedStatus === "loading" || schedStatus === "unknown";
  const schedStale = schedStatus === "stale";
  const rows = Array.isArray(strip.data?.rows) ? strip.data.rows : [];

  return (
    <section data-testid="service-strip" className="space-y-1">
      <h2 className="text-sm uppercase tracking-wide text-zinc-400">Service strip</h2>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-700 px-3 py-2">
        {stripUnknown ? (
          <span data-testid="service-strip-value" className="text-xs font-semibold text-zinc-500">
            UNKNOWN
          </span>
        ) : rows.length === 0 ? (
          <span data-testid="service-strip-value" className="text-xs text-zinc-500">
            no services reported
          </span>
        ) : (
          rows.map((row) => (
            <span
              key={row.service}
              data-testid={`service-row-${row.service}`}
              className="inline-flex items-center gap-1.5 text-xs text-zinc-300"
              title={row.lastError || row.service}
            >
              <Dot ok={row.status === "ok" ? true : row.status === "down" ? false : null} />
              {row.service}
            </span>
          ))
        )}
        <AsOf generatedAt={strip.data?.generatedAt} stale={stripStale} />

        <span className="text-zinc-600" aria-hidden>
          ·
        </span>

        {schedUnknown ? (
          <span data-testid="scheduler-chip" className="text-xs font-semibold text-zinc-500">
            Scheduler UNKNOWN
          </span>
        ) : (
          <span
            data-testid="scheduler-chip"
            data-running={sched.data.running ? "true" : "false"}
            className={`text-xs font-semibold ${sched.data.running ? "text-emerald-300" : "text-rose-300"}`}
          >
            Scheduler {sched.data.running ? "RUNNING" : "STOPPED"}
            {sched.data.stopReason ? ` (${sched.data.stopReason})` : ""}
          </span>
        )}
        {!schedUnknown && (
          <span data-testid="scheduler-counters" className="text-xs text-zinc-500">
            errs {sched.data.consecutiveErrors ?? 0}
            {sched.data.lastTickAt && (
              <>
                {" "}
                · last tick <LocalTimestamp ts={sched.data.lastTickAt} />
              </>
            )}
          </span>
        )}
        <AsOf generatedAt={sched.data?.generatedAt} stale={schedStale} />
      </div>
      {!schedUnknown && sched.data.lastError && (
        <p data-testid="scheduler-last-error" className="text-xs text-rose-400 break-words">
          {sched.data.lastError}
        </p>
      )}
    </section>
  );
}
