import { resolveVerdict, VERDICT_PAUSED } from "./console-state.ts";

/**
 * StatusVerdict — the Console hero (issue #891, now-console-4).
 *
 * Resolves to exactly one of PAUSED / RUNNING / IDLE / STUCK / CRASHED via the
 * pure `resolveVerdict` in console-state.ts, fed by slice-1 lifecycle
 * (/now/autopilot-tick), slice-3 stuck signals (/now/autopilot-health), slice-2
 * idle-diagnostics (/autopilot/idle-diagnostics), and the operator-only pause
 * flag (/autopilot/paused, issue #988/#989).
 *
 * The Pause/Resume control (issue #989) lives in the hero. Because there is no
 * auto-resume, a forgotten pause silently halts all autopilot work — so PAUSED
 * is the loudest verdict and the toggle is server-confirmed (never optimistic):
 * the parent shows a disabled "pausing…/resuming…" state, then re-renders the
 * verdict only once `GET /autopilot/paused` confirms the write. A failed POST
 * surfaces the error and leaves the verdict at its last server-confirmed value.
 */

const VERDICT_STYLE = {
  RUNNING: {
    chip: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40",
    dot: "bg-emerald-400 animate-pulse",
    label: "RUNNING",
  },
  IDLE: {
    chip: "bg-sky-500/10 text-sky-300 border border-sky-500/40",
    dot: "bg-sky-400",
    label: "IDLE",
  },
  STUCK: {
    chip: "bg-amber-500/10 text-amber-300 border border-amber-500/40",
    dot: "bg-amber-400 animate-pulse",
    label: "STUCK",
  },
  CRASHED: {
    chip: "bg-rose-500/10 text-rose-300 border border-rose-500/40",
    dot: "bg-rose-400 animate-pulse",
    label: "CRASHED",
  },
  PAUSED: {
    chip: "bg-violet-500/15 text-violet-200 border border-violet-400/50",
    dot: "bg-violet-300",
    label: "PAUSED",
  },
};

export default function StatusVerdict({
  lifecycle,
  signals,
  idle,
  paused,
  loading,
  onTogglePause,
  pausePending = false,
  pauseError = null,
}) {
  const { verdict, fact } = resolveVerdict({ lifecycle, signals, idle, paused });
  const style = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.IDLE;

  // The control reflects the LAST SERVER-CONFIRMED pause state, not the
  // resolved verdict — a draining run still resolves to PAUSED, but the
  // button must offer "Resume" because the flag is set.
  const isPaused = paused?.paused === true;
  const canToggle = typeof onTogglePause === "function";

  function handleClick() {
    if (!canToggle || pausePending) return;
    onTogglePause(!isPaused);
  }

  const buttonLabel = pausePending
    ? isPaused
      ? "resuming…"
      : "pausing…"
    : isPaused
      ? "Resume"
      : "Pause";

  return (
    <section
      data-testid="status-verdict"
      data-verdict={verdict}
      className={`rounded-lg border bg-zinc-950 p-5 ${
        verdict === VERDICT_PAUSED ? "border-violet-500/40" : "border-zinc-800"
      }`}
    >
      <div className="flex items-center gap-4">
        <span
          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-lg font-bold tracking-wide ${style.chip}`}
        >
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} aria-hidden />
          {style.label}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-300">
            {loading && !fact ? "Resolving autopilot state…" : fact}
          </p>
          {pauseError && (
            <p data-testid="pause-error" className="mt-1 text-xs text-rose-400">
              {String(pauseError)}
            </p>
          )}
        </div>
        {canToggle && (
          <button
            type="button"
            data-testid="pause-toggle"
            data-paused={isPaused ? "true" : "false"}
            onClick={handleClick}
            disabled={pausePending}
            aria-pressed={isPaused}
            className={`shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              isPaused
                ? "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </section>
  );
}
