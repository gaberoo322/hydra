import { resolveVerdict } from "./console-state.ts";

/**
 * StatusVerdict — the Console hero (issue #891, now-console-4).
 *
 * Resolves to exactly one of RUNNING / IDLE / STUCK / CRASHED via the pure
 * `resolveVerdict` in console-state.ts, fed by slice-1 lifecycle
 * (/now/autopilot-tick), slice-3 stuck signals (/now/autopilot-health), and
 * slice-2 idle-diagnostics (/autopilot/idle-diagnostics). Shows the single
 * most relevant supporting fact for the resolved state.
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
};

export default function StatusVerdict({ lifecycle, signals, idle, loading }) {
  const { verdict, fact } = resolveVerdict({ lifecycle, signals, idle });
  const style = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.IDLE;

  return (
    <section
      data-testid="status-verdict"
      data-verdict={verdict}
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-5"
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
        </div>
      </div>
    </section>
  );
}
