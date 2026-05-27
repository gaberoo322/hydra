import { useApi } from "../../hooks/useApi.js";
import { deriveDispatchesStripState } from "./derive-sprite-state.ts";

/**
 * ActiveDispatchesStrip — horizontal strip of sprite-per-dispatch.
 *
 * Slice 2 of /now-pixel (#642, #644). Renders one placeholder sprite per
 * /api/now/active-dispatches item. The real class-to-sprite mapping
 * lands in slice 3 (#645); for now everything is a pikachu.
 */
export default function ActiveDispatchesStrip() {
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
          {state.rows.map((row) => (
            <li
              key={row.id}
              title={row.tooltip}
              className="flex flex-col items-center gap-1"
            >
              <img
                src={`/sprites/pokemon/${row.spriteFile}`}
                alt={row.classLabel}
                style={{
                  width: 64,
                  height: 64,
                  imageRendering: "pixelated",
                }}
              />
              <span
                className="text-[10px] uppercase tracking-wide text-zinc-500 truncate max-w-[64px]"
                style={{ fontFamily: "monospace" }}
              >
                {row.classLabel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
