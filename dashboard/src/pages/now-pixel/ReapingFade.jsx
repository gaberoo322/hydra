import { useEffect, useRef } from "react";
import {
  REAPING_DURATION_MS,
  statusToIcon,
  normaliseReapStatus,
} from "./reaping-fade.ts";

/**
 * ReapingFade — 800ms fade-out wrapper for a soon-to-unmount sprite.
 *
 * Issue #661, follow-up to /now-pixel slice 6 (#648). When a pipeline
 * slot transitions from occupied → null, the HabitatGrid keeps the last
 * sprite mounted inside a <ReapingFade /> for REAPING_DURATION_MS (800ms),
 * during which:
 *
 *   - children opacity tweens from 1 → 0
 *   - a status-icon overlay (✨ / ✗ / 💤) is rendered on top
 *
 * After the duration elapses the consumer's `onComplete` callback fires
 * and the parent fully unmounts the slot.
 *
 * The status comes from the last `subagent_stop` slot-event payload we
 * saw for the class — see useSpriteAnimations.lastReapStatus.
 */
export default function ReapingFade({
  status = "other",
  onComplete,
  children,
}) {
  const timerRef = useRef(null);
  const normalised = normaliseReapStatus(status);
  const icon = statusToIcon(normalised);

  useEffect(() => {
    if (typeof onComplete !== "function") return undefined;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onComplete();
    }, REAPING_DURATION_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [onComplete]);

  return (
    <div
      data-testid="reaping-fade"
      data-reap-status={normalised}
      style={{
        position: "relative",
        // The opacity tween: we start at 1 and let CSS animate to 0
        // over REAPING_DURATION_MS. Using a key'd inline animation
        // keeps us off of an external CSS file (the rest of /now-pixel
        // mixes Tailwind + inline styles the same way).
        animation: `now-pixel-reaping-fade ${REAPING_DURATION_MS}ms ease-out forwards`,
        // Pointer events off — the slot is going away, hover shouldn't
        // re-anchor on it mid-fade.
        pointerEvents: "none",
      }}
    >
      {/* Inline keyframes so we don't need a global stylesheet. */}
      <style>{`
        @keyframes now-pixel-reaping-fade {
          0%   { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
      {children}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          color: icon.color,
          textShadow: "0 0 4px rgba(0,0,0,0.8)",
          fontWeight: "bold",
          // The icon itself stays opaque for the first half of the fade,
          // then fades with the sprite — visually we want the status read
          // even after the sprite has dimmed.
          pointerEvents: "none",
        }}
      >
        {icon.glyph}
      </span>
    </div>
  );
}
