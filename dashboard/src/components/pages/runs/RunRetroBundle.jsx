import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { retroCountTiles, retroPartialLine, topFrictionPatterns } from "../../../lib/retro-bundle-tiles.ts";

/**
 * RunRetroBundle — the /runs/:runId retro bundle panel (issue #4634,
 * design-concept a7e7fedb INV-2/4/7; ADR-0034 §9.4).
 *
 * Homes GET /autopilot/runs/:runId/retro — the live-assembled run-tree retro
 * bundle. (pages/now-console/RetroPanel.jsx reads a DIFFERENT route,
 * /autopilot/retros — persisted artifacts — and is neither reused nor
 * modified.)
 *
 * Renders: the run-level flag verdict (`runFlagged` + `runFlagReason`), the
 * five source counts, and the top three friction patterns by hits with their
 * cue. The assembler answers 200 with a PARTIAL bundle when a sub-source
 * fails, so a non-empty `errors[]` renders a persistent amber "partial
 * bundle" line naming each failed source — a partial bundle never reads as
 * complete — AND each count tile / list whose source failed renders UNKNOWN,
 * never the assembler's empty fallback as a confident 0 (the source → field
 * mapping is the pure, tested lib/retro-bundle-tiles.ts). `crossRunTrend` is deliberately not rendered (a trend — /builder
 * owns trends).
 *
 * Trust (ADR-0034 §5): fetched ONCE, no poll (the run is terminal by the
 * time anyone drills into it); the state machine is the shared
 * derivePageStatus seam. `runFound === false` → the whole panel is UNKNOWN;
 * a 400 on a malformed run_id is a failed read → UNKNOWN with the message.
 */

const HOUR_MS = 60 * 60 * 1000;

export default function RunRetroBundle({ runId }) {
  const { data, error, loading } = useApi(`/autopilot/runs/${encodeURIComponent(runId)}/retro`);

  // The bundle is one object, not a list: itemsLen 1 so a clean read is
  // "ready" — emptiness is expressed per field (the five counts), never as
  // a panel-level zero.
  const status = derivePageStatus({ data, error, loading, itemsLen: 1, freshnessMs: HOUR_MS });
  const unknown = status === "loading" || status === "unknown" || data?.runFound === false;
  const stale = status === "stale";
  const partialLine = retroPartialLine(data?.errors);
  // A failed source's tile / list is UNKNOWN (null / unknown), never its
  // empty fallback rendered as 0.
  const tiles = retroCountTiles(data);
  const friction = topFrictionPatterns(data, 3);

  return (
    <section
      data-testid="run-retro-bundle"
      className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-3"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-zinc-100">Retro bundle</h2>
        <div className="text-xs text-zinc-500">
          {stale && <span className="text-amber-400">stale · </span>}
          as of <LocalTimestamp ts={data?.generatedAt} stale={stale} />
        </div>
      </div>

      {unknown ? (
        <div
          data-testid="run-retro-bundle-unknown"
          className="border border-zinc-700 rounded-md px-4 py-4 text-sm text-zinc-400 bg-zinc-900/40"
        >
          UNKNOWN —{" "}
          {data?.runFound === false
            ? "the run record did not load, so no bundle source could be joined."
            : "retro bundle read unproven."}
          {error && <span className="block font-mono text-xs text-zinc-600 break-all">{error}</span>}
        </div>
      ) : (
        <>
          {partialLine && (
            <div
              data-testid="run-retro-bundle-partial"
              className="border border-amber-500/30 bg-amber-500/10 rounded-md px-3 py-2 text-xs text-amber-300"
            >
              {partialLine}
            </div>
          )}

          <p className="text-sm">
            {data.runFlagged ? (
              <span className="text-red-300">
                flagged for drill — {data.runFlagReason ?? "no reason recorded"}
              </span>
            ) : (
              <span className="text-zinc-400">not flagged</span>
            )}
          </p>

          <dl className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            {tiles.map((t) => (
              <div key={t.field}>
                <dt className="uppercase tracking-wide text-zinc-500">{t.label}</dt>
                {t.count === null ? (
                  <dd className="font-mono text-sm font-bold text-zinc-500" title="this source failed to load">
                    UNKNOWN
                  </dd>
                ) : (
                  <dd className="font-mono text-lg text-zinc-100">{t.count}</dd>
                )}
              </div>
            ))}
          </dl>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Top friction patterns</h3>
            {friction.unknown ? (
              <p className="text-xs font-bold text-zinc-500">UNKNOWN — the friction source failed to load.</p>
            ) : friction.patterns.length === 0 ? (
              <p className="text-xs text-zinc-500 italic">No friction patterns in the bundle.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {friction.patterns.map((p) => (
                  <li key={p.category} className="py-1 flex items-center gap-2 text-xs">
                    <span className="font-mono text-zinc-400 shrink-0">{p.hitCount}x</span>
                    <span className="flex-1 min-w-0 text-zinc-200 truncate" title={p.category}>
                      {p.category}
                    </span>
                    <span className="text-[10px] uppercase text-zinc-500 shrink-0">{p.severity}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
