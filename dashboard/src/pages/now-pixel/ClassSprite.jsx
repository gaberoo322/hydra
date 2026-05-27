import { classSpriteFile } from "./sprite-map.ts";

/**
 * ClassSprite — render the Pokemon sprite for a class.
 *
 * Slice 3 (#645) introduced sleeping/active opacity. Slice 4 (#646) adds
 * one-shot / steady animation classes triggered by the WS slot-events
 * bridge via useSpriteAnimations.
 *
 * Animation prop values (closed set, see useSpriteAnimations):
 *   - null / undefined → no extra animation
 *   - "excited"        → 1s scale+bounce (slot just opened)
 *   - "cheering"       → 1s scale+jiggle (subagent_stop success)
 *   - "hurt"           → persistent flash-red (subagent_stop failure)
 *   - "thinking"       → reserved for slice 6; renders inline 💭 bubble
 */
export default function ClassSprite({
  className,
  status,
  signalSeed = null,
  size = 64,
  animation = null,
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
  const animClass = animation ? `sprite-${animation}` : "";

  return (
    <div
      style={{ position: "relative", width: size, height: size }}
      data-anim={animation || ""}
    >
      <img
        src={`/sprites/pokemon/${spriteFile}`}
        alt={className}
        className={animClass}
        style={{
          width: size,
          height: size,
          imageRendering: "pixelated",
          opacity: sleeping ? 0.3 : 1.0,
          filter: sleeping ? "grayscale(100%)" : "none",
          transition: "opacity 200ms, filter 200ms",
        }}
      />
      {animation === "thinking" && (
        <span
          style={{
            position: "absolute",
            top: -4,
            right: -8,
            fontSize: 14,
            color: "#bdbdbd",
            textShadow: "1px 1px 0 #000",
          }}
          title="thinking…"
        >
          💭
        </span>
      )}
      <style>{`
        @keyframes sprite-excited-kf {
          0%   { transform: translateY(0); }
          30%  { transform: translateY(-8px); }
          60%  { transform: translateY(0); }
          80%  { transform: translateY(-4px); }
          100% { transform: translateY(0); }
        }
        .sprite-excited { animation: sprite-excited-kf 1s ease-out; }
        @keyframes sprite-cheering-kf {
          0%   { transform: scale(1) rotate(0); filter: brightness(1); }
          25%  { transform: scale(1.15) rotate(-3deg); filter: brightness(1.3); }
          50%  { transform: scale(1.1) rotate(3deg); filter: brightness(1.4); }
          75%  { transform: scale(1.15) rotate(-2deg); filter: brightness(1.3); }
          100% { transform: scale(1) rotate(0); filter: brightness(1); }
        }
        .sprite-cheering { animation: sprite-cheering-kf 1s ease-out; }
        @keyframes sprite-hurt-kf {
          0%   { filter: hue-rotate(0deg) saturate(1); }
          50%  { filter: hue-rotate(-30deg) saturate(2.5); }
          100% { filter: hue-rotate(0deg) saturate(1); }
        }
        .sprite-hurt { animation: sprite-hurt-kf 600ms ease-in-out infinite; }
      `}</style>
    </div>
  );
}
