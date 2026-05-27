import { classSpriteFile } from "./sprite-map.ts";

/**
 * ClassSprite — render the Pokemon sprite for a class at a given state.
 *
 * Sleeping zones are 30% opacity grayscale; active zones are full-color.
 * Slice 3 of /now-pixel (#642, #645) — no animation states yet, those
 * land in slice 4 (#646).
 */
export default function ClassSprite({
  className,
  status,
  signalSeed = null,
  size = 64,
}) {
  let spriteFile = null;
  let resolveError = null;
  try {
    spriteFile = classSpriteFile(className, signalSeed);
  } catch (err) {
    resolveError = err.message;
  }

  if (resolveError) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          color: "#666",
        }}
      >
        ?
      </div>
    );
  }

  const sleeping = status === "sleeping";
  return (
    <img
      src={`/sprites/pokemon/${spriteFile}`}
      alt={className}
      style={{
        width: size,
        height: size,
        imageRendering: "pixelated",
        // 30% opacity + grayscale for sleeping zones makes them clearly
        // visually distinct from full-color active ones without
        // changing the layout footprint.
        opacity: sleeping ? 0.3 : 1.0,
        filter: sleeping ? "grayscale(100%)" : "none",
        transition: "opacity 200ms, filter 200ms",
      }}
    />
  );
}
