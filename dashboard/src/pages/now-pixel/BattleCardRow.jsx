import { useEffect, useReducer, useState, useCallback } from "react";
import { useApi } from "../../hooks/useApi.js";
import BattleCard, { CARD_WIDTH } from "./BattleCard.jsx";
import PokedexModal from "./PokedexModal.jsx";
import {
  applySlotEvent,
  deriveBattleCardRows,
  derivePokedexEntries,
  reapStalePermissionWaits,
} from "./battle-card-state.ts";

/**
 * BattleCardRow — replaces ActiveDispatchesStrip for /now-pixel.
 *
 * Slice D of /now-observability (epic #667, issue #672). Renders one
 * 220x150 BattleCard per in-flight subagent dispatch, accumulates tool-call
 * counters and current-activity from the WS slot-event stream, and opens
 * a Pokedex-style chronological modal on card click.
 *
 * Wire shape consumed (graceful no-op if upstream slices haven't shipped):
 *   - /api/now/active-dispatches  → which task ids are alive right now
 *   - WS slot-event frames        → subagent_tool_call, slot_waiting_permission,
 *                                   subagent_stop, pr_opened
 *
 * Hover-link (slice 6 in HabitatGrid) is preserved: the shared
 * `hoveredSubagentId` from NowPixel scales both the in-zone sprite and
 * the matching card together.
 */

/**
 * Reducer over the per-task runtime accumulator. Two action shapes:
 *   { type: "event", frame }    — fold a WS frame in (battle-card-state)
 *   { type: "reap", nowEpoch }  — drop stale permission-waits
 */
function taskReducer(state, action) {
  if (action.type === "event") return applySlotEvent(state, action.frame);
  if (action.type === "reap")
    return reapStalePermissionWaits(state, action.nowEpoch);
  return state;
}

export default function BattleCardRow({
  hoveredSubagentId = null,
  onSubagentHover = () => {},
  ws = null,
}) {
  const { data, error } = useApi("/now/active-dispatches", { poll: 5_000 });
  const [taskState, dispatch] = useReducer(taskReducer, {});
  const [openTaskId, setOpenTaskId] = useState(null);

  // Subscribe to slot-event WS frames. The OakTownCrier already subscribes
  // with "*"; multiple subscriptions are independent, so this one is safe.
  useEffect(() => {
    if (!ws || typeof ws.subscribe !== "function") return undefined;
    const off = ws.subscribe("slot-event", (frame) => {
      dispatch({ type: "event", frame });
    });
    return () => off?.();
  }, [ws]);

  // Periodic stale-wait reaper — defensive against missed resolution events.
  useEffect(() => {
    const t = setInterval(() => {
      dispatch({ type: "reap", nowEpoch: Math.floor(Date.now() / 1000) });
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const onOpenPokedex = useCallback((taskId) => setOpenTaskId(taskId), []);
  const onClosePokedex = useCallback(() => setOpenTaskId(null), []);

  const { rows, empty } = deriveBattleCardRows(data, taskState);
  const modalEntries =
    openTaskId != null ? derivePokedexEntries(taskState, openTaskId) : [];
  const modalRow = openTaskId != null
    ? rows.find((r) => r.id === openTaskId) ?? null
    : null;

  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      data-testid="battle-card-row"
    >
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Active dispatches
        </h2>
        <span className="text-[10px] text-zinc-500 font-mono">
          {rows.length} in flight
        </span>
      </header>
      {error ? (
        <p className="text-sm text-rose-400">Error: {error}</p>
      ) : empty ? (
        <p className="text-sm text-zinc-500">
          No subagents in flight. Pavilion is quiet.
        </p>
      ) : (
        <div
          className="flex gap-3 overflow-x-auto"
          style={{ paddingBottom: 4 }}
          data-count={rows.length}
          data-card-width={CARD_WIDTH}
        >
          {rows.map((row) => (
            <BattleCard
              key={row.id}
              row={row}
              isHovered={hoveredSubagentId === row.id}
              onHover={onSubagentHover}
              onOpenPokedex={onOpenPokedex}
            />
          ))}
        </div>
      )}
      {modalRow && (
        <PokedexModal
          row={modalRow}
          entries={modalEntries}
          onClose={onClosePokedex}
        />
      )}
    </section>
  );
}
