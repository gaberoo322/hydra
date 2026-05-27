import { useSpriteAnimations } from "../../hooks/useSpriteAnimations.js";
import AutopilotPavilion from "./AutopilotPavilion.jsx";
import ActiveDispatchesStrip from "./ActiveDispatchesStrip.jsx";
import HabitatGrid from "./HabitatGrid.jsx";
import Attribution from "./Attribution.jsx";

/**
 * NowPixel — pixel-art habitat dashboard at /now-pixel.
 *
 * Slice 4 of /now-pixel (#642, #646). The page now owns the sprite-
 * animation hook so HabitatGrid + AutopilotPavilion can share the same
 * map of per-class animations (excited / cheering / hurt / thinking).
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
      <HabitatGrid anim={anim} />
      <ActiveDispatchesStrip />
      <Attribution />
    </div>
  );
}
