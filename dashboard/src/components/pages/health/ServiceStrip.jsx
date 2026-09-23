import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * ServiceStrip — /health's home for the previously-dark `GET /now/service-strip`
 * read (issue #4630, ADR-0034 §9.4).
 *
 * `src/aggregators/service-strip.ts` reshapes the shared external-service
 * liveness probes (currently orchestrator + redis, issue #3544) into an
 * ordered row list; this component renders that list verbatim as a strip of
 * status lights, same visual language as the existing `/health/deep` lights
 * in Health.jsx. It is a DIFFERENT probe set from `/health/deep` (a broader
 * fan-out) — a sibling read, not a duplicate of the Service section above it.
 *
 * Obeys the ADR-0034 §5 trust seam via the shared derivePageStatus state
 * machine: loading/unknown render UNKNOWN, a failed refresh with retained
 * data renders stale (amber as-of) — never a confident-looking empty strip.
 */

const DOT = {
  ok: "bg-emerald-400",
  degraded: "bg-amber-400",
  down: "bg-rose-400",
};

/** Trust status for the `{rows, generatedAt}` payload via the shared seam. */
function payloadStatus({ data, error, loading, freshnessMs }) {
  return derivePageStatus({ data, error, loading, itemsLen: data?.rows?.length ?? 0, freshnessMs });
}

export default function ServiceStrip() {
  const { data, error, loading } = useApi("/now/service-strip", { poll: 30_000 });
  const status = payloadStatus({ data, error, loading, freshnessMs: 2 * 60 * 1000 });
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const rows = data?.rows ?? [];

  return (
    <section data-testid="service-strip-section" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Services</h2>
        {data?.generatedAt && (
          <div className="text-xs text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={data.generatedAt} stale={stale} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2" data-testid="service-strip-rows">
        {unknown ? (
          <span
            data-testid="service-strip-chip"
            className="inline-block rounded-md px-3 py-1.5 text-sm font-bold bg-zinc-700/40 text-zinc-400 border border-zinc-600"
          >
            UNKNOWN
          </span>
        ) : rows.length === 0 ? (
          <span className="text-xs text-zinc-500">no services reporting</span>
        ) : (
          rows.map((row) => (
            <span
              key={row.service}
              data-testid={`service-strip-${row.service}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
              title={row.lastError || row.service}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${DOT[row.status] ?? "bg-zinc-500"}`} aria-hidden />
              {row.service}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
