import { useSpriteAnimations } from "../../hooks/useSpriteAnimations.js";
import AutopilotPavilion from "./AutopilotPavilion.jsx";
import ActiveDispatchesStrip from "./ActiveDispatchesStrip.jsx";
import HabitatGrid from "./HabitatGrid.jsx";
import OakTownCrier from "./OakTownCrier.jsx";
import Attribution from "./Attribution.jsx";

/**
 * NowPixel — pixel-art habitat dashboard at /now-pixel.
 *
 * Slice 5 of /now-pixel (#642, #647). Layout now includes the Infirmary
 * (services HP bars) in HabitatGrid's center column, the alerts notice
 * board pinned to the Pavilion, and Oak town crier on the right edge.
 *
 * The route is intentionally NOT linked from the main nav — reachable
 * only by typing /now-pixel into the address bar. The atomic swap to
 * /now happens in slice 7 (#649).
 */
export default function NowPixel({ ws }) {
  const anim = useSpriteAnimations(ws);

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
      <div className="flex gap-4 items-stretch">
        <div className="flex-1 min-w-0">
          <HabitatGrid anim={anim} />
        </div>
        <OakTownCrier ws={ws} />
      </div>
      <ActiveDispatchesStrip />
      <Attribution />
    </div>
  );
}
