import { useCallback, useState } from "react";
import { useApi, apiFetch } from "../hooks/useApi.js";
import { derivePageStatus } from "../hooks/usePageItems.js";
import LocalTimestamp from "../components/LocalTimestamp.jsx";
import DeployAxes from "../components/pages/health/DeployAxes.jsx";
import CostPanel from "../components/pages/health/CostPanel.jsx";

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
 * Actions are SERVER-CONFIRMED, never optimistic (design-concept 2880e735
 * INV-6): the control shows a pending state and only re-renders once the
 * follow-up GET confirms the write — the established /now Console pause
 * pattern (StatusVerdict.jsx), relocated here rather than rebuilt. The
 * emergency brake additionally requires an explicit second confirm action
 * before its POST fires (INV-7); pause/resume stays single-click.
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

  // ---- Autopilot run state + pause/resume (server-confirmed, INV-6) --------
  // The pause flag rides the /health payload (paused + the verified `ok` flag
  // + generatedAt) — one source of truth for chip, button, and as-of.
  const pauseVerified = health.data?.autopilotPause?.ok !== false;
  const isPaused = pauseVerified && health.data?.autopilotPause?.paused === true;

  const [pausePending, setPausePending] = useState(false);
  const [pauseError, setPauseError] = useState(null);

  const handleTogglePause = useCallback(
    async (next) => {
      setPausePending(true);
      setPauseError(null);
      try {
        await apiFetch("/autopilot/paused", {
          method: "POST",
          body: JSON.stringify({ paused: next }),
        });
        // SERVER-CONFIRMED: re-render only once the read confirms the write.
        await health.refresh();
      } catch (err) {
        setPauseError(err?.message || String(err));
      } finally {
        setPausePending(false);
      }
    },
    [health],
  );

  // ---- Emergency brake (two-step confirm, INV-7) ---------------------------
  const brakeVerified = health.data?.emergencyBrake?.ok !== false;
  const brakeEngaged = brakeVerified && health.data?.emergencyBrake?.engaged === true;
  const [brakeArmed, setBrakeArmed] = useState(false); // the confirm step
  const [brakePending, setBrakePending] = useState(false);
  const [brakeError, setBrakeError] = useState(null);

  const postBrake = useCallback(
    async (engaged) => {
      setBrakePending(true);
      setBrakeError(null);
      try {
        await apiFetch("/autopilot/emergency-brake", {
          method: "POST",
          body: JSON.stringify(engaged ? { engaged: true, engagedBy: "health-page" } : { engaged: false }),
        });
        setBrakeArmed(false);
        // SERVER-CONFIRMED: only the follow-up read flips the indicator.
        await health.refresh();
      } catch (err) {
        setBrakeError(err?.message || String(err));
      } finally {
        setBrakePending(false);
      }
    },
    [health],
  );

  const deepUnknown = deepStatus === "loading" || deepStatus === "unknown";
  const deepStale = deepStatus === "stale";
  const deepStatus_ = deep.data?.status;
  const svc = deep.data?.services;

  return (
    <div className="space-y-5 max-w-4xl" data-testid="health-page">
      <div>
        <h1 className="text-2xl font-bold">Health</h1>
        <p className="text-sm text-zinc-400">Is it on fire, or burning money?</p>
      </div>

      <DeployAxes data={health.data} status={healthStatus} />

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
          <button
            type="button"
            data-testid="pause-toggle"
            data-paused={isPaused ? "true" : "false"}
            disabled={pausePending || !pauseVerified}
            aria-pressed={isPaused}
            onClick={() => handleTogglePause(!isPaused)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pausePending ? (isPaused ? "resuming…" : "pausing…") : isPaused ? "Resume" : "Pause"}
          </button>
        </div>
        {pauseError && (
          <p data-testid="pause-error" className="text-xs text-rose-400 break-words">
            {pauseError}
          </p>
        )}
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
            pending={brakePending}
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
          {!brakeEngaged && !brakeArmed && (
            <button
              type="button"
              data-testid="brake-arm"
              disabled={brakePending || !brakeVerified}
              onClick={() => setBrakeArmed(true)}
              className="rounded-md border border-rose-500/40 px-3 py-1.5 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Engage emergency brake…
            </button>
          )}
          {brakeArmed && !brakeEngaged && (
            <div data-testid="brake-confirm" className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-zinc-400">Halts ALL auto-merge. Sure?</span>
              <button
                type="button"
                data-testid="brake-confirm-yes"
                disabled={brakePending}
                onClick={() => postBrake(true)}
                className="rounded-md border border-rose-500/60 px-3 py-1.5 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {brakePending ? "engaging…" : "Confirm engage"}
              </button>
              <button
                type="button"
                data-testid="brake-confirm-no"
                disabled={brakePending}
                onClick={() => setBrakeArmed(false)}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
          {brakeEngaged && (
            <button
              type="button"
              data-testid="brake-release"
              disabled={brakePending}
              onClick={() => postBrake(false)}
              className="rounded-md border border-emerald-500/40 px-3 py-1.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {brakePending ? "releasing…" : "Release brake"}
            </button>
          )}
        </div>
        {brakeError && (
          <p data-testid="brake-error" className="text-xs text-rose-400 break-words">
            {brakeError}
          </p>
        )}
      </section>

      <CostPanel />
    </div>
  );
}
