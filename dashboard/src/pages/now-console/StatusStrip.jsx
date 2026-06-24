import { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi.js";
import { formatNextDispatchCountdown, deriveInflightSlots } from "./console-state.ts";

/**
 * StatusStrip — two small top-of-/now status widgets (issue #2411,
 * now-status-5, parent #2408) that answer "is 'idle' stuck or just waiting?"
 * and "how many dispatches are in flight right now?".
 *
 * Both are READ-ONLY consumers of existing endpoints (NO new backend, no new
 * runtime dependency, per the design-concept invariants):
 *   - Next-dispatch countdown ← GET /autopilot/idle-diagnostics
 *     (`nextPaceGateCheck` ISO timestamp, may be null; `blockedBy` is one of
 *     running|emergency-stop|pacing-ahead|endpoint-error|null).
 *   - In-flight slots ← GET /autopilot/inflight-slots (`slots` record).
 *
 * Both poll at 30s (matching the idle-diagnostics server cadence) via the
 * shared `useApi(path,{poll})` hook, and degrade gracefully — a fetch error or
 * null payload renders a sensible text fallback, never a blank/crashed view.
 * The load-bearing derivations are pure and unit-tested in
 * `console-state.ts` / `test/now-console-state.test.mts`; this component is the
 * thin render shell.
 */

const POLL_MS = 30_000;

const COUNTDOWN_STATE_STYLE = {
  counting: "text-zinc-200",
  due: "text-emerald-300",
  unknown: "text-zinc-500 italic",
};

function NextDispatchWidget() {
  const { data, error, loading } = useApi("/autopilot/idle-diagnostics", { poll: POLL_MS });

  // Tick a local clock so the countdown ticks down between 30s polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const countdown = formatNextDispatchCountdown(data?.nextPaceGateCheck, nowMs);
  const blockedBy = typeof data?.blockedBy === "string" ? data.blockedBy : null;

  return (
    <div
      data-testid="next-dispatch-widget"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1">
        Next dispatch
      </h3>
      {loading && !data ? (
        <p className="text-xs text-zinc-500 italic">Checking pace gate…</p>
      ) : error && !data ? (
        <p data-testid="next-dispatch-error" className="text-xs text-amber-300/80 italic">
          Pace-gate status unavailable
        </p>
      ) : (
        <>
          <p
            data-testid="next-dispatch-countdown"
            data-state={countdown.state}
            className={`text-sm ${COUNTDOWN_STATE_STYLE[countdown.state] ?? COUNTDOWN_STATE_STYLE.unknown}`}
          >
            {countdown.label}
          </p>
          {blockedBy && (
            <p data-testid="next-dispatch-blocked-by" className="text-[10px] text-zinc-500 mt-1">
              blocked by <span className="font-mono text-zinc-400">{blockedBy}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function InflightSlotsWidget() {
  const { data, error, loading } = useApi("/autopilot/inflight-slots", { poll: POLL_MS });

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const rows = deriveInflightSlots(data?.slots, nowMs);

  return (
    <div
      data-testid="inflight-slots-widget"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
    >
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          In flight
        </h3>
        {!loading || data ? (
          <span data-testid="inflight-slots-count" className="text-[10px] font-mono text-zinc-500">
            {rows.length}
          </span>
        ) : null}
      </div>
      {loading && !data ? (
        <p className="text-xs text-zinc-500 italic">Checking dispatches…</p>
      ) : error && !data ? (
        <p data-testid="inflight-slots-error" className="text-xs text-amber-300/80 italic">
          Dispatch status unavailable
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="inflight-slots-empty" className="text-xs text-zinc-500 italic">
          no dispatches in flight
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li
              key={row.key}
              data-testid="inflight-slot-row"
              className="flex items-baseline gap-2 text-[11px]"
            >
              <span className="font-mono text-zinc-300">{row.skill}</span>
              {row.relativeStart && (
                <span className="text-zinc-500">({row.relativeStart})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StatusStrip() {
  return (
    <div
      data-testid="status-strip"
      className="grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      <NextDispatchWidget />
      <InflightSlotsWidget />
    </div>
  );
}
