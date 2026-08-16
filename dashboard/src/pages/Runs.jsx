import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import { usePageItems } from "../hooks/usePageItems.js";
import LocalTimestamp from "../components/LocalTimestamp.jsx";
import RunsList from "../components/pages/runs/RunsList.jsx";
import FrictionPanel from "../components/pages/runs/FrictionPanel.jsx";
import { describeDispatchTrigger } from "../components/pages/runs/runs-state.js";

/**
 * /runs — the forensics page (issue #4009, dashboard v3 slice delta,
 * ADR-0034 §2): "why did that fail?"
 *
 * The list→detail→trace spine every surveyed product shares: the runs list
 * (RunsList) drills into the per-run detail (/runs/:runId) which drills into
 * the agent transcript (/dispatch/:id/transcript). The list and transcript
 * levels already existed; this page is the missing list-level entry point.
 *
 * Alongside the list, two attribution surfaces (ADR-0034 §2 — "every event
 * shows who or what triggered it", Temporal's principal attribution):
 *
 *   Dispatch events — GET /now/active-dispatches. Each row names its TRIGGER
 *   (autopilot / operator / subagent + class label) and carries the
 *   dispatch→issue join; a missing join renders the explicit `unattributed`
 *   state, never a fabricated source (INV-8). The join being weak (~4.97%,
 *   ADR-0034 §2) is exactly what this page is supposed to make visible.
 *
 *   Outcome attribution — GET /attribution, the ridge estimator's per-metric
 *   producer-class effects. A DERIVED value rendered as one: every effect
 *   row carries its identifiability flags verbatim (belowNoiseFloor /
 *   lowVariance / collinear / suspect) and its observation count — never a
 *   bare point estimate. The endpoint emits no generatedAt, so this panel
 *   claims no as-of; it is a decomposition, not an observed current value.
 *
 * Anti-scope (ADR-0034 §2): aggregate trends belong on /builder — this page
 * renders no trend of any kind.
 */

function EffectFlags({ effect }) {
  const flags = [];
  if (effect.belowNoiseFloor) flags.push("below-noise-floor");
  if (effect.lowVariance) flags.push("low-variance");
  if (effect.collinear) flags.push("collinear");
  if (effect.identifiabilitySuspect) flags.push("identifiability-suspect");
  if (flags.length === 0) return null;
  return (
    <span className="text-[10px] uppercase tracking-wide text-amber-400/80">
      {flags.join(" · ")}
    </span>
  );
}

/** Derived outcome-attribution panel — flags on every row, no bare β. */
function OutcomeAttribution() {
  const { data, error, loading } = useApi("/attribution", { poll: 5 * 60_000 });
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];

  return (
    <section data-testid="outcome-attribution" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Outcome attribution</h2>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          derived · ridge estimate, flags shown · no as-of
        </span>
      </div>
      {loading && !data ? (
        <p className="text-xs text-zinc-500">loading…</p>
      ) : error && !data ? (
        <p className="text-xs text-zinc-500">
          derived estimate <span className="text-zinc-400">UNKNOWN</span> (attribution fetch failed)
        </p>
      ) : metrics.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No attribution signal yet — the ledger has no identifiable class effects.
        </p>
      ) : (
        <div className="space-y-2">
          {metrics.slice(0, 4).map((m) => (
            <div key={m.metric} className="border border-zinc-800 rounded-md bg-zinc-900/30 p-3">
              <div className="text-xs font-mono text-zinc-300 mb-1.5">{m.metric}</div>
              <ul className="space-y-1">
                {(m.effects ?? []).slice(0, 3).map((e) => (
                  <li key={e.producerClass} className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="font-mono text-zinc-200 w-28 shrink-0">{e.producerClass}</span>
                    <span className="font-mono text-zinc-400">β {Number(e.beta).toFixed(4)}</span>
                    <span className="text-zinc-600">n={e.nonZeroObservationCount}</span>
                    <EffectFlags effect={e} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Dispatch events with per-event trigger attribution (INV-8). */
function DispatchEvents() {
  const { items, data, status } = usePageItems("/now/active-dispatches", {
    itemsKey: "items",
    // Live sessions are minutes-tier: a dispatch list that stops refreshing
    // must demote quickly (ADR-0034 §5 budgets).
    freshnessMs: 5 * 60 * 1000,
    poll: 30_000,
  });
  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";

  return (
    <section data-testid="dispatch-events" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Dispatch events <span className="text-zinc-600">({items.length})</span>
        </h2>
        <div className="text-xs text-zinc-500">
          {stale && <span className="text-amber-400">stale · </span>}
          as of <LocalTimestamp ts={data?.generatedAt} stale={stale} />
        </div>
      </div>
      {unknown ? (
        <div
          data-testid="dispatch-events-unknown"
          className="border border-zinc-700 rounded-md px-4 py-4 text-center text-sm text-zinc-400 bg-zinc-900/40"
        >
          UNKNOWN — dispatch registry unproven.
        </div>
      ) : status === "empty" ? (
        <div
          data-testid="dispatch-events-empty"
          className="border border-zinc-800 rounded-md px-4 py-4 text-center text-sm text-zinc-500 bg-zinc-900/30"
        >
          No dispatches recorded in the active window.
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60 border border-zinc-800 rounded-lg bg-zinc-900/30 px-3">
          {items.map((d) => {
            const attr = describeDispatchTrigger(d);
            return (
              <li key={d.id} className="py-2 flex items-center gap-3 flex-wrap" data-testid="dispatch-event-row">
                {/* Attribution: who or what triggered this event. */}
                <span
                  data-testid="dispatch-event-trigger"
                  className="text-xs text-zinc-200 font-mono shrink-0 truncate max-w-56"
                  title={attr.trigger}
                >
                  {attr.trigger}
                </span>
                <LocalTimestamp ts={d.startedAt} className="text-xs text-zinc-400 font-mono shrink-0" />
                {d.currentStep && (
                  <span className="text-xs text-zinc-500 truncate" title={d.currentStep}>
                    {d.currentStep}
                  </span>
                )}
                {attr.attributed ? (
                  <span className="text-xs text-zinc-300 font-mono shrink-0" data-testid="dispatch-event-target">
                    {attr.target}
                  </span>
                ) : (
                  // INV-8: the missing dispatch→issue join is EXPLICIT, never
                  // fabricated. Rendering it loudly is the point of this page.
                  <span
                    data-testid="dispatch-event-unattributed"
                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-300 border-amber-500/30 shrink-0"
                    title="dispatch→issue join missing for this row"
                  >
                    unattributed
                  </span>
                )}
                <span className="flex-1" />
                <Link
                  to={`/dispatch/${encodeURIComponent(d.id)}/transcript`}
                  data-testid="dispatch-event-transcript-link"
                  className="text-xs text-blue-400 hover:underline shrink-0"
                >
                  transcript →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function Runs() {
  return (
    <div className="space-y-5" data-testid="runs-page">
      <div>
        <h1 className="text-2xl font-bold">Runs</h1>
        <p className="text-sm text-zinc-400">
          Why did that fail? — runs list → run detail → transcript. Aggregate trends live on /builder.
        </p>
      </div>
      <RunsList />
      <DispatchEvents />
      <OutcomeAttribution />
      <FrictionPanel />
    </div>
  );
}
