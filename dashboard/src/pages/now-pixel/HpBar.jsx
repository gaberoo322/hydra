/**
 * HpBar — shared HP bar for subagent sprites + the trainer card.
 *
 * Slice 6 of /now-pixel (#642, #648). The bar is purely presentational;
 * color + flashing decisions live in deriveHp / deriveExp so tests pin
 * the boundary.
 *
 * Props:
 *   percent      — number 0..100
 *   color        — "green" | "yellow" | "red" | "grey"
 *   flashing     — boolean
 *   width/height — px, defaults match the slice-3 service bar widths
 *   label        — optional text rendered above the bar
 */
const COLOR_TO_HEX = {
  green: "#22c55e",
  yellow: "#facc15",
  red: "#dc2626",
  grey: "#71717a",
};

export default function HpBar({
  percent,
  color = "green",
  flashing = false,
  width = 64,
  height = 4,
  label = null,
}) {
  const fill = Math.min(100, Math.max(0, Number(percent) || 0));
  const hex = COLOR_TO_HEX[color] ?? COLOR_TO_HEX.grey;
  return (
    <div style={{ width, display: "inline-block" }}>
      {label && (
        <div className="text-[8px] uppercase text-zinc-500" style={{ lineHeight: 1 }}>
          {label}
        </div>
      )}
      <div
        style={{
          width,
          height,
          background: "#1f1f23",
          borderRadius: 2,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          className={flashing ? "hp-bar-flash" : ""}
          style={{
            width: `${fill}%`,
            height: "100%",
            background: hex,
            transition: "width 200ms ease-out, background 200ms",
          }}
        />
      </div>
      <style>{`
        @keyframes hp-bar-flash-kf {
          0%   { opacity: 1; }
          50%  { opacity: 0.3; }
          100% { opacity: 1; }
        }
        .hp-bar-flash {
          animation: hp-bar-flash-kf 500ms ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
