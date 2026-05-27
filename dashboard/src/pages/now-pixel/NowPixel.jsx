import AutopilotPavilion from "./AutopilotPavilion.jsx";
import ActiveDispatchesStrip from "./ActiveDispatchesStrip.jsx";
import Attribution from "./Attribution.jsx";

/**
 * NowPixel — pixel-art habitat dashboard at /now-pixel.
 *
 * Slice 2 of the epic (#642, #644). Page shell only: Pavilion at the top,
 * habitat-zones placeholder card in the middle (slice 3 fills it),
 * Active dispatches strip at the bottom, Attribution footer.
 *
 * This route is intentionally NOT linked from the main nav — it's
 * reachable only by typing /now-pixel into the address bar. The atomic
 * swap to /now happens in slice 7 (#649).
 */
export default function NowPixel() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold">Now (Pixel View)</h1>
        <p className="text-sm text-zinc-400">
          Pokemon-habitat rendering of the live orchestrator. Preview build —
          not yet wired into nav.
        </p>
      </header>
      <AutopilotPavilion />
      <section
        className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
        data-testid="habitat-placeholder"
      >
        <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-2">
          Habitat zones
        </h2>
        <p className="text-sm text-zinc-500">
          Island coming. Pipeline + signal class slots land in slice 3.
        </p>
      </section>
      <ActiveDispatchesStrip />
      <Attribution />
    </div>
  );
}
