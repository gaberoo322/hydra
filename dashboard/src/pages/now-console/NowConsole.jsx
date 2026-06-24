import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, useApi } from "../../hooks/useApi.js";
import StatusVerdict from "./StatusVerdict.jsx";
import StatusStrip from "./StatusStrip.jsx";
import StopBanner from "./StopBanner.jsx";
import UsagePanel from "./UsagePanel.jsx";
import StuckSignals from "./StuckSignals.jsx";
import RunHistoryStrip from "./RunHistoryStrip.jsx";
import RunDetailDrawer from "./RunDetailDrawer.jsx";
import RetroPanel from "./RetroPanel.jsx";
import { summariseTurns, formatRelativeTime } from "../now-pixel/oak-tab-state.ts";

/**
 * NowConsole — dense autopilot-diagnostics Console for /now (issue #891,
 * now-console-4, parent #887).
 *
 * The lifecycle-accurate, quota-aware, stuck-signal-aware operator console.
 * Layout (top → bottom):
 *   1. StatusVerdict hero (RUNNING / IDLE / STUCK / CRASHED) — slices 1+2+3.
 *   2. UsagePanel — 5h burn, weekly pace, attribution, cache-hit (no $0).
 *   3. Two columns: live turn journal (left) + ranked StuckSignals (right).
 *   4. RunHistoryStrip — recent runs trend.
 *
 * The mode toggle that flips between this Console and the pixel Habitat is
 * owned by the route shell (NowPixel hosts the toggle header too); see
 * console-state.ts for the deep-link + localStorage plumbing.
 */

/**
 * TurnJournal — per-turn dispatch decisions with their reasons. Reuses the
 * pixel view's `summariseTurns` derivation against /autopilot/runs/current so
 * the two surfaces stay consistent.
 */
function TurnJournal() {
  const { data } = useApi("/autopilot/runs/current", { poll: 10_000 });
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => summariseTurns(data?.turns), [data]);

  return (
    <section
      data-testid="turn-journal"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <h2 className="text-sm font-semibold text-zinc-200 mb-2">Turn journal</h2>
      {rows.length === 0 ? (
        <p data-testid="turn-journal-empty" className="text-xs text-zinc-500 italic">
          No turns recorded yet this run.
        </p>
      ) : (
        <ul
          className="divide-y divide-zinc-900"
          style={{ maxHeight: 360, overflowY: "auto" }}
        >
          {rows.map((row) => (
            <li key={row.id} data-testid="turn-journal-row" className="py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-zinc-400" style={{ minWidth: 32 }}>
                  #{row.turn_n ?? "?"}
                </span>
                <span className="text-[10px] text-zinc-500" style={{ minWidth: 52 }}>
                  {formatRelativeTime(row.epoch, nowSec)}
                </span>
                <span className="flex-1 text-[11px] text-zinc-300 truncate">{row.summary}</span>
              </div>
              {row.dispatchDetails.length > 0 && (
                <ul className="mt-1 ml-8 space-y-0.5">
                  {row.dispatchDetails.map((d, i) => (
                    <li
                      key={`${d.slot}-${i}`}
                      data-testid="turn-journal-dispatch"
                      className="text-[10px] leading-tight border-l-2 border-zinc-700 pl-2"
                    >
                      <span className="font-mono text-zinc-400 mr-1">{d.slot}</span>
                      {d.skill && <span className="text-zinc-500">({d.skill}) </span>}
                      <span className="text-zinc-300">{d.reason || "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function NowConsole() {
  // Slice-1 lifecycle + slice-3 stuck signals feed the hero. Slice-2
  // idle-diagnostics provides the "why idle" supporting fact. The
  // operator-only pause flag (#988/#989) is polled fast so the hero reflects
  // a kill-switch promptly.
  const tick = useApi("/now/autopilot-tick", { poll: 10_000 });
  const health = useApi("/now/autopilot-health", { poll: 30_000 });
  const idle = useApi("/autopilot/idle-diagnostics", { poll: 30_000 });
  const paused = useApi("/autopilot/paused", { poll: 10_000 });

  const [pausePending, setPausePending] = useState(false);
  const [pauseError, setPauseError] = useState(null);

  // RunHistoryStrip → RunDetailDrawer open/close state (issue #2410). The
  // selected run_id is null when no drawer is open.
  const [selectedRunId, setSelectedRunId] = useState(null);

  // Server-confirmed, never optimistic: POST the new state, then re-fetch the
  // flag and only let the verdict flip once the read confirms the write. A
  // failed POST surfaces the error and leaves the verdict where it was.
  const handleTogglePause = useCallback(
    async (next) => {
      setPausePending(true);
      setPauseError(null);
      try {
        await apiFetch("/autopilot/paused", {
          method: "POST",
          body: JSON.stringify({ paused: next }),
        });
        await paused.refresh();
      } catch (err) {
        setPauseError(err?.message || String(err));
      } finally {
        setPausePending(false);
      }
    },
    [paused],
  );

  const loading = tick.loading && !tick.data;

  return (
    <div className="space-y-4" data-testid="now-console">
      <StopBanner />
      <StatusVerdict
        lifecycle={tick.data?.lifecycle}
        signals={health.data?.signals}
        idle={idle.data}
        paused={paused.data}
        loading={loading}
        onTogglePause={handleTogglePause}
        pausePending={pausePending}
        pauseError={pauseError}
      />
      <StatusStrip />
      <UsagePanel />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <TurnJournal />
        <StuckSignals />
      </div>
      <RunHistoryStrip onSelect={setSelectedRunId} />
      <RetroPanel />
      <RunDetailDrawer runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
    </div>
  );
}
