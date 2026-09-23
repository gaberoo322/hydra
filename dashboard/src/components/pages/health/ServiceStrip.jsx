import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * ServiceStrip — the "is the machine running" half of the /health page
 * (issue #4630, ADR-0034 §9.4 homing rule: route -> owning file).
 *
 * Owns exactly two dark reads, homed here per the design-concept artifact:
 *
 *   GET /now/service-strip  — per-external-service liveness rows
 *   GET /scheduler/status   — the autopilot cycle scheduler's own liveness
 *
 * Both render as ONE compact chip/light row (design-concept INV-7) so the
 * phone-grade /health page doesn't grow a second full section for what is,
 * at a glance, "is the loop still turning". Each fetch keeps its OWN
 * generatedAt/as-of (INV-5) — the two never blend into one combined figure.
 *
 * The scheduler chip renders ONLY observed fields (INV-9): running ->
 * RUNNING/STOPPED, stopReason, lastTickAt, consecutiveErrors, lastError. It
 * deliberately does NOT duplicate the autopilot pause chip (Health.jsx
 * already owns that off GET /health) and does NOT compute a derived
 * "stalled" verdict — ADR-0034 §5 rule 3 requires derived values to
 * decompose, and that computation is out of scope for this slice.
 */

/** Trust status for a non-list payload via the shared slice-alpha seam. */
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

function Light({ testId, label, ok, title }) {
  const color = ok === true ? "bg-emerald-400" : ok === false ? "bg-rose-400" : "bg-zinc-500";
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
      title={title || label}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}

function Chip({ testId, className, label }) {
  return (
    <span
      data-testid={testId}
      data-state={label}
      className={`inline-block rounded-md px-2 py-1 text-xs font-bold tracking-wide ${className}`}
    >
      {label}
    </span>
  );
}

const SCHEDULER_CHIP = {
  RUNNING: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40",
  STOPPED: "bg-zinc-700/40 text-zinc-300 border border-zinc-600",
  UNKNOWN: "bg-zinc-700/40 text-zinc-400 border border-zinc-600",
};

export default function ServiceStrip() {
  // Minutes-tier freshness budgets (ADR-0034 §5 / design-concept INV-6).
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
  const rows = Array.isArray(strip.data?.rows) ? strip.data.rows : [];

  const schedUnknown = schedStatus === "loading" || schedStatus === "unknown";
  const schedStale = schedStatus === "stale";
  const schedRunning = sched.data?.running === true;
  const schedLabel = schedUnknown ? "UNKNOWN" : schedRunning ? "RUNNING" : "STOPPED";

  return (
    <section data-testid="service-strip-section" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Service strip</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <AsOf generatedAt={strip.data?.generatedAt} stale={stripStale} />
          <AsOf generatedAt={sched.data?.generatedAt} stale={schedStale} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center" data-testid="service-strip-row">
        {stripUnknown ? (
          <Chip testId="service-strip-chip" className="bg-zinc-700/40 text-zinc-400 border border-zinc-600" label="UNKNOWN" />
        ) : rows.length === 0 ? (
          <span className="text-xs text-zinc-500">no services reporting</span>
        ) : (
          rows.map((row) => (
            <Light
              key={row.service}
              testId={`service-light-${row.service}`}
              label={row.service}
              ok={row.status === "ok" ? true : row.status === "down" ? false : null}
              title={row.lastError || row.service}
            />
          ))
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-center" data-testid="scheduler-row">
        <Chip
          testId="scheduler-chip"
          className={SCHEDULER_CHIP[schedLabel]}
          label={schedLabel}
        />
        {!schedUnknown && (
          <span className="text-xs text-zinc-500" data-testid="scheduler-detail">
            {sched.data?.stopReason ? `stopReason: ${sched.data.stopReason} · ` : ""}
            {sched.data?.lastTickAt ? (
              <>
                last tick <LocalTimestamp ts={sched.data.lastTickAt} />
                {" · "}
              </>
            ) : (
              "no tick recorded · "
            )}
            errors: {sched.data?.consecutiveErrors ?? 0}
            {sched.data?.lastError ? ` · last error: ${sched.data.lastError}` : ""}
          </span>
        )}
      </div>
    </section>
  );
}
