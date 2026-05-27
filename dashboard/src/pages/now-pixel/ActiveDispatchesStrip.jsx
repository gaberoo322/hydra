import { useApi } from "../../hooks/useApi.js";
import { deriveDispatchesStripState } from "./derive-sprite-state.ts";

/**
 * ActiveDispatchesStrip — horizontal strip of sprite-per-dispatch.
 *
 * Slice 2 (#644) introduced the strip with a placeholder Pikachu per
 * row. Slice 6 (#648) adds hover-link to the in-zone SubagentSprite —
 * shared `hoveredSubagentId` lifted to NowPixel. The IDs map only when
 * a dispatch's `id` matches a subagent's `task_id`; that alignment is
 * a data-plane concern and may be partial today, but the wiring is
 * here so future server-side changes light up the cross-highlight
 * without a UI refactor.
 *
 * The class-mapped sprite (replacing the slice-2 placeholder) will
 * land alongside operator-launched dispatches in a follow-up — the
 * autopilot rows currently carry `classLabel: "autopilot"`, which
 * doesn't resolve to a class sprite cleanly.
 */
export default function ActiveDispatchesStrip({
  hoveredSubagentId = null,
  onSubagentHover = () => {},
}) {
  const { data, error } = useApi("/now/active-dispatches", { poll: 5_000 });
  const state = deriveDispatchesStripState(data);

  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      data-testid="active-dispatches-strip"
    >
      <header className="mb-3">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Active dispatches
        </h2>
      </header>
      {error ? (
        <p className="text-sm text-rose-400">Error: {error}</p>
      ) : state.empty ? (
        <p className="text-sm text-zinc-500">
          No subagents in flight. Pavilion is quiet.
        </p>
      ) : (
        <ul
          className="flex flex-wrap gap-3"
          data-count={state.rows.length}
        >
          {state.rows.map((row) => {
            const isHovered = hoveredSubagentId === row.id;
            return (
              <li
                key={row.id}
                title={row.tooltip}
                data-task-id={row.id}
                className="flex flex-col items-center gap-1"
                style={{
                  cursor: "pointer",
                  transform: isHovered ? "scale(1.1)" : "scale(1)",
                  transition: "transform 150ms",
                }}
                onMouseEnter={() => onSubagentHover(row.id)}
                onMouseLeave={() => onSubagentHover(null)}
              >
                <img
                  src={`/sprites/pokemon/${row.spriteFile}`}
                  alt={row.classLabel}
                  style={{
                    width: 64,
                    height: 64,
                    imageRendering: "pixelated",
                    opacity: isHovered ? 1 : 0.95,
                    transition: "opacity 200ms",
                  }}
                />
                <span
                  className="text-[10px] uppercase tracking-wide text-zinc-500 truncate max-w-[64px]"
                  style={{ fontFamily: "monospace" }}
                >
                  {row.classLabel}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
