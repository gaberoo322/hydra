import { useCallback, useState } from "react";
import { useApi } from "../hooks/useApi.js";
import { derivePageStatus } from "../hooks/usePageItems.js";
import {
  ControlAffordance,
  UndoToastStack,
  UndoWindowContext,
  useCheckedRefresh,
  useOperatorActions,
  useUndoWindowHost,
} from "../components/ActionAffordance.jsx";
import { healthVerdicts } from "../lib/control-verdicts.ts";
import { housekeepingSummary } from "../lib/health-verdicts.ts";
import LocalTimestamp from "../components/LocalTimestamp.jsx";
import DeployAxes from "../components/pages/health/DeployAxes.jsx";
import CostPanel from "../components/pages/health/CostPanel.jsx";
import ServiceStrip from "../components/pages/health/ServiceStrip.jsx";
import AlertsPanel from "../components/pages/health/AlertsPanel.jsx";

/**
 * /health — the only phone-grade dashboard surface (issue #4008, ADR-0034
 * §2): "is it on fire, or burning money?" Scanned, often on a phone — nothing
 * here requires interpretation.
 *
 *   Deploy   — two orthogonal axes (drift / health), never one combined light
 *   Deep     — GET /health/deep surfaced as a status chip + subsystem lights
 *   Autopilot— RUNNING/PAUSED chip + the relocated pause/resume control
 *   Brake    — emergency brake with a mandatory second confirm step
 *   Cost     — three independently-timestamped figures (CostPanel)
 *
 * Trust seam (slice alpha #4006, ADR-0034 §5): every value renders through
 * the shared derivePageStatus machine — unproven renders UNKNOWN, an aged or
 * failed-refresh payload renders stale with an amber as-of, and the as-of age
 * is always visible.
 *
 * Issue #4630 (design-concept 883fd8c2, ADR-0034 §5/#4425): homes the
 * remaining dark reads. `ServiceStrip` (below) owns `/now/service-strip` +
 * `/scheduler/status`; `AlertsPanel` owns `/alerts`; `CostPanel` gains a
 * fourth headline tile (`/now/cost-burn`) plus a collapsed "Breakdown"
 * disclosure over `/metrics/cost`, `/metrics/cost-efficiency` and
 * `/metrics/cost-by-outcome`. This file itself owns the one remaining
 * literal, `/capacity`, rendered below as a single chip (INV-1/INV-7).
 *
 * Actions are SERVER-CONFIRMED, never optimistic (design-concept 2880e735
 * INV-6): the control shows a pending state and only re-renders once the
 * follow-up GET confirms the write. Since issue #4629 (design-concept
 * 821e48ed, ADR-0034 §8.3) every write control — pause, resume, brake
 * engage, brake release — renders through the shared ActionAffordance from
 * its `control:health/<name>` registry entry (one read via
 * useOperatorActions): the label, the live ✓/✗ precondition checklist and
 * the consequence all come from the registry, and the button is disabled
 * while any line is ✗ (healthVerdicts, lib/control-verdicts.ts). The
 * affordance POSTs, awaits a CHECKED /health re-read via onFired (a failed
 * re-read renders "/health re-read FAILED"), and renders only the verified
 * state; the RUNNING/PAUSED and ENGAGED/OFF chips keep deriving from the
 * /health read.
 * Pause is immediate-with-undo (the ~5 s delayed commit hosted here); resume
 * and both brake controls confirm first (resume spends quota; the brake
 * halts or re-enables every auto-merge).
 *
 * Issue #4631 (design-concept 5ae4b72c INV-7/8/11): the same one registry
 * read is passed DOWN as `entries` to AlertsPanel (per-alert Dismiss +
 * Dismiss all) and ServiceStrip (scheduler Stop ⇄ Start), each placed beside
 * the read it owns — this file fetches neither of their routes. The
 * housekeeping section below hosts `control:health/housekeeping` and renders
 * the verified `{ran, skipped}` summary from the lifted result's `body`, only
 * after the request settled (housekeepingSummary, lib/health-verdicts.ts).
 */

const DEEP_CHIP = {
  healthy: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40",
  degraded: "bg-amber-500/10 text-amber-300 border border-amber-500/40",
  unhealthy: "bg-rose-500/10 text-rose-300 border border-rose-500/40",
  critical: "bg-rose-500/20 text-rose-200 border border-rose-500/60",
};

function Light({ label, ok, title }) {
  const color = ok === true ? "bg-emerald-400" : ok === false ? "bg-rose-400" : "bg-zinc-500";
  return (
    <span
      data-testid={`deep-light-${label}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
      title={title || label}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}

/** A status word rendered as a big chip; UNKNOWN when unproven (rule 1). */
function Chip({ testId, className, label, pending }) {
  return (
    <span
      data-testid={testId}
      data-state={label}
      className={`inline-block rounded-md px-3 py-1.5 text-base sm:text-lg font-bold tracking-wide ${className} ${
        pending ? "animate-pulse opacity-70" : ""
      }`}
    >
      {label}
    </span>
  );
}

/** Trust status for a non-list payload via the shared slice-alpha seam. */
function payloadStatus({ data, error, loading, freshnessMs, trusted }) {
  // `trusted === false` marks a payload whose value was NOT verified
  // server-side (the /health ok:false flags) — unverifiable → UNKNOWN.
  if (data && trusted === false) return "unknown";
  return derivePageStatus({ data, error, loading, itemsLen: 1, freshnessMs });
}

function AsOf({ generatedAt, stale }) {
  if (!generatedAt) return null;
  return (
    <div className="text-xs text-zinc-500">
      {stale && <span className="text-amber-400">stale · </span>}
      as of <LocalTimestamp ts={generatedAt} stale={stale} />
    </div>
  );
}

export default function Health() {
  // Is-it-on-fire is a minutes-tier surface (ADR-0034 §5 budgets).
  const health = useApi("/health", { poll: 30_000 });
  const deep = useApi("/health/deep", { poll: 60_000 });

  const healthStatus = payloadStatus({
    data: health.data,
    error: health.error,
    loading: health.loading,
    freshnessMs: 2 * 60 * 1000,
  });
  const deepStatus = payloadStatus({
    data: deep.data,
    error: deep.error,
    loading: deep.loading,
    freshnessMs: 5 * 60 * 1000,
  });

  // ---- Capacity: one chip (issue #4630, design-concept 883fd8c2 INV-1/7) ---
  // Activity-tier budget (poll 5m / budget 30m) — this file owns the
  // "/capacity" literal verbatim, per INV-1.
  const capacity = useApi("/capacity", { poll: 5 * 60_000 });
  const capacityStatus = payloadStatus({
    data: capacity.data,
    error: capacity.error,
    loading: capacity.loading,
    freshnessMs: 30 * 60 * 1000,
  });
  const capacityUnknown = capacityStatus === "loading" || capacityStatus === "unknown";
  const capacityStale = capacityStatus === "stale";
  const floorStatus = capacity.data?.floorStatus;
  const CAPACITY_CHIP = {
    met: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40",
    breached: "bg-rose-500/20 text-rose-200 border border-rose-500/60",
    unmeasured: "bg-zinc-700/40 text-zinc-400 border border-zinc-600",
  };

  // ---- Write controls: registry entries + the undo-window host -------------
  // (issue #4629) One registry read, no poll; pause's immediate-with-undo
  // window is hosted at page level. Every affordance awaits refreshHealth
  // (onFired) before rendering its result — server-confirmed, and CHECKED:
  // it resolves false when the /health re-read settled with an error.
  const registry = useOperatorActions();
  const undoHost = useUndoWindowHost();
  const refreshHealth = useCheckedRefresh(health);
  const verdicts = healthVerdicts(
    health.data,
    healthStatus !== "loading" && healthStatus !== "unknown",
  );

  // ---- Housekeeping (issue #4631 INV-11) -----------------------------------
  // The lifted result: cleared as a new run starts, set once it settled.
  const [housekeepingResult, setHousekeepingResult] = useState(null);
  const clearHousekeepingResult = useCallback(() => setHousekeepingResult(null), []);
  const housekeepingLine = housekeepingSummary(housekeepingResult);

  // ---- Autopilot run state + pause/resume (server-confirmed, INV-6) --------
  // The pause flag rides the /health payload (paused + the verified `ok` flag
  // + generatedAt) — one source of truth for chip, controls, and as-of.
  const pauseVerified = health.data?.autopilotPause?.ok !== false;
  const isPaused = pauseVerified && health.data?.autopilotPause?.paused === true;

  // ---- Emergency brake (confirm-first, INV-7) ------------------------------
  const brakeVerified = health.data?.emergencyBrake?.ok !== false;
  const brakeEngaged = brakeVerified && health.data?.emergencyBrake?.engaged === true;

  const deepUnknown = deepStatus === "loading" || deepStatus === "unknown";
  const deepStale = deepStatus === "stale";
  const deepStatus_ = deep.data?.status;
  const svc = deep.data?.services;

  // ---- Operator channel: delivery health (issue #5048, ADR-0045 D8) --------
  // The ONE read-only delivery-health route; this file owns the literal. A
  // Redis-down answer is 200 `{available:false, reason}` — `trusted:false`
  // routes it through the shared seam as UNKNOWN, never a confident "all
  // delivered". Minutes-tier budget like the rest of this page.
  const channel = useApi("/operator-channel/delivery-health", { poll: 60_000 });
  const channelStatus = payloadStatus({
    data: channel.data,
    error: channel.error,
    loading: channel.loading,
    freshnessMs: 5 * 60 * 1000,
    trusted: channel.data ? channel.data.available !== false : undefined,
  });
  // Send brief now (issue #5164): the verified result is the re-read "Last
  // brief" cell — the CHECKED refresh of this one delivery-health read.
  const refreshChannel = useCheckedRefresh(channel);
  const channelUnknown = channelStatus === "loading" || channelStatus === "unknown";
  const channelStale = channelStatus === "stale";
  const lastPage = channel.data?.lastPage ?? null;
  const lastBrief = channel.data?.lastBrief ?? null;
  const lastBriefDeliveredAt = channel.data?.lastBriefDeliveredAt ?? null;
  const channelWindow = channel.data?.window ?? null;
  const channelFailed = Number(channelWindow?.failed ?? 0);
  const channelSuppressed = Number(channelWindow?.suppressed ?? 0);
  const OUTCOME_CLASS = {
    "sent-html": "text-emerald-300",
    "sent-plain": "text-emerald-300",
    failed: "text-rose-300",
    "skipped-no-credentials": "text-amber-300",
  };
  const outcomeClass = (o) => OUTCOME_CLASS[o] ?? "text-zinc-300";

  return (
    <UndoWindowContext.Provider value={undoHost}>
    <div className="space-y-5 max-w-4xl" data-testid="health-page">
      <div>
        <h1 className="text-2xl font-bold">Health</h1>
        <p className="text-sm text-zinc-400">Is it on fire, or burning money?</p>
      </div>

      <DeployAxes data={health.data} status={healthStatus} />

      <ServiceStrip entries={registry} />

      {/* ---- Capacity: one chip (INV-7); floorStatus rendered verbatim ------ */}
      <section data-testid="capacity-section" className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm uppercase tracking-wide text-zinc-400">Capacity</h2>
          <AsOf generatedAt={capacity.data?.generatedAt} stale={capacityStale} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {capacityUnknown ? (
            <Chip
              testId="capacity-chip"
              className="bg-zinc-700/40 text-zinc-400 border border-zinc-600"
              label="UNKNOWN"
            />
          ) : (
            // floorStatus rendered VERBATIM — "unmeasured" never renders as "met" (INV-9).
            <Chip
              testId="capacity-chip"
              className={CAPACITY_CHIP[floorStatus] ?? CAPACITY_CHIP.unmeasured}
              label={String(floorStatus ?? "unmeasured").toUpperCase()}
            />
          )}
          {!capacityUnknown && (
            <span className="text-xs text-zinc-500">
              orchestrator share {Math.round((capacity.data?.orchestrator?.share ?? 0) * 100)}%
            </span>
          )}
        </div>
      </section>

      {/* ---- Deep health: the richest payload, surfaced as lights ---------- */}
      <section data-testid="deep-section" className="space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm uppercase tracking-wide text-zinc-400">Service</h2>
          <AsOf generatedAt={deep.data?.generatedAt} stale={deepStale} />
        </div>
        {deepUnknown ? (
          <Chip testId="deep-chip" className="bg-zinc-700/40 text-zinc-400 border border-zinc-600" label="UNKNOWN" />
        ) : (
          <Chip
            testId="deep-chip"
            className={DEEP_CHIP[deepStatus_] ?? DEEP_CHIP.unhealthy}
            label={String(deepStatus_ ?? "UNKNOWN").toUpperCase()}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Light label="api" ok={deepUnknown ? null : svc?.orchestrator?.status === "running"} title={svc?.orchestrator?.uptimeHuman} />
          <Light label="redis" ok={deepUnknown ? null : svc?.redis?.status === "running"} />
          <Light label="scheduler" ok={deepUnknown ? null : svc?.scheduler?.status === "running"} />
          <Light
            label="systemd"
            ok={
              deepUnknown
                ? null
                : ["orchestrator", "watchdog", "targetWeb"].every(
                    (k) => deep.data?.infrastructure?.systemd?.[k] === "active",
                  )
            }
            title={svc ? JSON.stringify(deep.data?.infrastructure?.systemd) : undefined}
          />
        </div>
      </section>

      {/* ---- Autopilot run state + pause/resume ---------------------------- */}
      <section data-testid="autopilot-section" className="space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm uppercase tracking-wide text-zinc-400">Autopilot</h2>
          <AsOf generatedAt={health.data?.generatedAt} stale={healthStatus === "stale"} />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {pauseVerified ? (
            <Chip
              testId="autopilot-chip"
              className={
                isPaused
                  ? "bg-violet-500/15 text-violet-200 border border-violet-400/50"
                  : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40"
              }
              label={isPaused ? "PAUSED" : "RUNNING"}
            />
          ) : (
            // INV-5: the pause read failed — UNKNOWN, never a confident RUNNING.
            <Chip
              testId="autopilot-chip"
              className="bg-zinc-700/40 text-zinc-400 border border-zinc-600"
              label="UNKNOWN"
            />
          )}
          {/* Pause (immediate · undo) while running; Resume (confirms
              first) while paused — the verified read picks which control
              shows, and each one's live checklist re-checks that read. */}
          {isPaused ? (
            <ControlAffordance
              registry={registry}
              controlKey="control:health/resume"
              testId="autopilot-resume"
              verdicts={verdicts}
              context={{ paused: false }}
              onFired={refreshHealth}
              rereadNoun="/health"
            />
          ) : (
            <ControlAffordance
              registry={registry}
              controlKey="control:health/pause"
              testId="autopilot-pause"
              verdicts={verdicts}
              context={{ paused: true }}
              onFired={refreshHealth}
              rereadNoun="/health"
            />
          )}
        </div>
      </section>

      {/* ---- Emergency brake (confirm-first, INV-7) ------------------------- */}
      <section data-testid="brake-section" className="space-y-2">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Emergency brake</h2>
        {brakeVerified ? (
          <Chip
            testId="brake-chip"
            className={
              brakeEngaged
                ? "bg-rose-500/20 text-rose-200 border border-rose-500/60"
                : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40"
            }
            label={brakeEngaged ? "ENGAGED" : "OFF"}
          />
        ) : (
          // INV-5: the brake read failed — UNKNOWN, never a confident OFF.
          <Chip
            testId="brake-chip"
            className="bg-zinc-700/40 text-zinc-400 border border-zinc-600"
            label="UNKNOWN"
          />
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Both confirm first: arm, then Confirm/Cancel with the
              consequence restated — the affordance's own arming. */}
          {brakeEngaged ? (
            <ControlAffordance
              registry={registry}
              controlKey="control:health/brake-release"
              testId="brake-release"
              verdicts={verdicts}
              context={{ engaged: false }}
              onFired={refreshHealth}
              rereadNoun="/health"
            />
          ) : (
            <ControlAffordance
              registry={registry}
              controlKey="control:health/brake-engage"
              testId="brake-engage"
              verdicts={verdicts}
              context={{ engaged: true }}
              onFired={refreshHealth}
              rereadNoun="/health"
            />
          )}
        </div>
      </section>

      {/* ---- Operator channel: delivery health (issue #5048, ADR-0045 D8) --- */}
      <section data-testid="operator-channel-section" className="space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm uppercase tracking-wide text-zinc-400">Operator channel</h2>
          <AsOf generatedAt={channel.data?.generatedAt} stale={channelStale} />
        </div>
        {/* Renders in the UNKNOWN state too: the send does not need Redis. */}
        <ControlAffordance
          registry={registry}
          controlKey="control:health/brief-send"
          testId="brief-send"
          verdicts={{}}
          onFired={refreshChannel}
          rereadNoun="/health"
        />
        {channelUnknown ? (
          <div className="space-y-1">
            {/* available:false (Redis down) or no payload yet — UNKNOWN, never a confident "all delivered". */}
            <Chip
              testId="operator-channel-chip"
              className="bg-zinc-700/40 text-zinc-400 border border-zinc-600"
              label="UNKNOWN"
            />
            {channel.data?.available === false && (
              <p data-testid="operator-channel-reason" className="text-xs text-zinc-500 break-words">
                delivery log unavailable: {String(channel.data.reason ?? "")}
              </p>
            )}
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div data-testid="operator-channel-last-page" className="rounded-md border border-zinc-800 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Last page</dt>
              <dd className="text-zinc-200">
                {lastPage ? (
                  <>
                    <span className="font-medium break-words">{lastPage.title}</span>
                    <div className="text-xs text-zinc-400">
                      {lastPage.kind} · <span className={outcomeClass(lastPage.outcome)}>{lastPage.outcome}</span> ·{" "}
                      <LocalTimestamp ts={lastPage.at} />
                    </div>
                  </>
                ) : (
                  <span className="text-zinc-500">none logged</span>
                )}
              </dd>
            </div>
            <div data-testid="operator-channel-last-brief" className="rounded-md border border-zinc-800 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Last brief</dt>
              <dd className="text-zinc-200">
                {lastBrief ? (
                  <div className="text-xs text-zinc-400">
                    <span className={outcomeClass(lastBrief.outcome)}>{lastBrief.outcome}</span> ·{" "}
                    <LocalTimestamp ts={lastBrief.at} />
                  </div>
                ) : lastBriefDeliveredAt ? (
                  // The bounded log rotated past the brief but the last-sent
                  // stamp (the delivered one) survives.
                  <div className="text-xs text-zinc-400">
                    <span className="text-emerald-300">delivered</span> · <LocalTimestamp ts={lastBriefDeliveredAt} />
                  </div>
                ) : (
                  <span className="text-zinc-500">never delivered</span>
                )}
                {lastBrief && lastBrief.outcome === "failed" && lastBriefDeliveredAt && (
                  <div className="text-xs text-zinc-500">
                    last delivered <LocalTimestamp ts={lastBriefDeliveredAt} />
                  </div>
                )}
              </dd>
            </div>
            <div data-testid="operator-channel-window" className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <span className="text-xs text-zinc-500">last {channelWindow?.hours ?? 24}h</span>
              <span
                data-testid="operator-channel-failed"
                className={`rounded-md border px-2 py-1 text-xs ${
                  channelFailed > 0 ? "border-rose-500/40 text-rose-300" : "border-zinc-700 text-zinc-300"
                }`}
              >
                failed {channelFailed}
              </span>
              <span
                data-testid="operator-channel-suppressed"
                className={`rounded-md border px-2 py-1 text-xs ${
                  channelSuppressed > 0 ? "border-amber-500/40 text-amber-300" : "border-zinc-700 text-zinc-300"
                }`}
              >
                suppressed {channelSuppressed}
              </span>
            </div>
          </dl>
        )}
      </section>

      <AlertsPanel entries={registry} />

      {/* ---- Housekeeping: run the due chores now (issue #4631 INV-11) ----- */}
      <section data-testid="housekeeping-section" className="space-y-2">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Housekeeping</h2>
        <ControlAffordance
          registry={registry}
          controlKey="control:health/housekeeping"
          testId="housekeeping-run"
          verdicts={{}}
          onFired={refreshHealth}
          onStart={clearHousekeepingResult}
          onResult={setHousekeepingResult}
          rereadNoun="/health"
        />
        {housekeepingLine && (
          <p data-testid="housekeeping-summary" className="break-words font-mono text-xs text-zinc-300">
            {housekeepingLine}
          </p>
        )}
      </section>

      <CostPanel />
    </div>
    <UndoToastStack windows={undoHost.windows} onUndo={undoHost.undo} />
    </UndoWindowContext.Provider>
  );
}
