import AutopilotPavilion from "./AutopilotPavilion.jsx";
import ActiveDispatchesStrip from "./ActiveDispatchesStrip.jsx";
import HabitatGrid from "./HabitatGrid.jsx";
import Attribution from "./Attribution.jsx";

/**
 * NowPixel — pixel-art habitat dashboard at /now-pixel.
 *
 * Slice 3 of the epic (#642, #645). Page layout: Pavilion top,
 * HabitatGrid (7 pipeline + 5 signal class slots) middle,
 * Active dispatches strip bottom, Attribution footer.
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
      <HabitatGrid />
      <ActiveDispatchesStrip />
      <Attribution />
    </div>
  );
}
