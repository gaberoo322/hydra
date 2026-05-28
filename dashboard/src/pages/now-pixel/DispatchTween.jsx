import { createPortal } from "react-dom";
import { classSpriteFile } from "./sprite-map.ts";

/**
 * DispatchTween — portal-rendered transient sprites for the
 * Pavilion → HabitatZone dispatch animation.
 *
 * Slice E of autopilot observability (#667, #670). Consumes the
 * `tweens` map from useSpriteAnimations and renders one fixed-position
 * sprite per active entry, plus a small dust-puff div that fades in at
 * the landing point in the final ~200ms.
 *
 * Why a portal:
 *   The Pavilion + HabitatGrid live in separate panels with their own
 *   `overflow` clipping. A nested absolutely-positioned sprite would
 *   get clipped at the panel boundary halfway through the trip.
 *   Rendering into document.body via createPortal sidesteps every
 *   ancestor's overflow rules.
 *
 * Why CSS keyframes (not requestAnimationFrame):
 *   The motion path is a straight line and we don't need per-frame
 *   coordination with React state. Inline @keyframes generated per-
 *   tween-id let the browser composite the whole motion off the main
 *   thread.
 *
 * Reduced motion:
 *   Handled upstream in `tweenSpec()`. When `spec.kind === "instant"`,
 *   the start/end are identical and the keyframes degenerate into a
 *   stationary sprite that just fades in/out. The dust puff still
 *   plays so the dispatch is at least *visible* — operators with
 *   reduced motion still need to know a dispatch happened.
 */
export default function DispatchTween({ tweens = {} }) {
  if (typeof document === "undefined") return null;
  const entries = Object.values(tweens);
  if (entries.length === 0) return null;

  return createPortal(
    <div
      data-testid="dispatch-tween-layer"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
      }}
    >
      {entries.map((entry) => (
        <TweenSprite key={entry.id} entry={entry} />
      ))}
    </div>,
    document.body,
  );
}

function TweenSprite({ entry }) {
  const { id, cls, spec } = entry;
  const { kind, startX, startY, endX, endY, durationMs, dustStartAtMs } = spec;
  const spriteSrc = `/sprites/${classSpriteFile(cls, null)}`;
  const moveKeyframes = `@keyframes ${id}-move {
    0%   { transform: translate(${startX}px, ${startY}px) scale(0.9); opacity: 0.0; }
    8%   { opacity: 1.0; }
    90%  { transform: translate(${endX}px, ${endY}px) scale(1.0); opacity: 1.0; }
    100% { transform: translate(${endX}px, ${endY}px) scale(0.85); opacity: 0.0; }
  }`;
  const dustKeyframes = `@keyframes ${id}-dust {
    0%   { transform: translate(${endX}px, ${endY}px) scale(0.2); opacity: 0.0; }
    30%  { transform: translate(${endX}px, ${endY}px) scale(1.0); opacity: 0.85; }
    100% { transform: translate(${endX}px, ${endY}px) scale(1.4); opacity: 0.0; }
  }`;
  const dustDelayMs = kind === "instant" ? 0 : dustStartAtMs;
  // 32x32 sprite renders centred on the target point. We pull half its
  // size into negative margins on the inner img so transform: translate
  // coordinates refer to the SPRITE CENTRE, which is what
  // tweenSpec() computes.
  return (
    <>
      <style>{moveKeyframes}</style>
      <style>{dustKeyframes}</style>
      <div
        data-testid={`dispatch-tween-sprite-${cls}`}
        data-tween-id={id}
        data-tween-kind={kind}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          willChange: "transform, opacity",
          animation: `${id}-move ${durationMs}ms ease-out forwards`,
        }}
      >
        <img
          src={spriteSrc}
          alt=""
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            marginLeft: -16,
            marginTop: -16,
            imageRendering: "pixelated",
          }}
        />
      </div>
      <div
        data-testid={`dispatch-tween-dust-${cls}`}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 48,
          height: 48,
          marginLeft: -24,
          marginTop: -24,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(252,211,77,0.85) 0%, rgba(252,211,77,0.0) 70%)",
          willChange: "transform, opacity",
          animation: `${id}-dust 200ms ease-out ${dustDelayMs}ms forwards`,
        }}
      />
    </>
  );
}
