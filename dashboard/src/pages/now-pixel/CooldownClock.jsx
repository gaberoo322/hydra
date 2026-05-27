/**
 * CooldownClock — ⏳ overlay on signal-class sprites in sleeping state.
 *
 * Slice 6 of /now-pixel (#642, #648). Shows time-until-next-eligible-fire
 * computed by deriveCooldown(). Hidden when the class is ready to fire
 * (cooldown elapsed) or is the always-allowed health class.
 *
 * Pure render — derive happens upstream; this component just formats the
 * remaining seconds compactly (≤60s → "Ns", ≤59m → "Nm", else "Hh Mm").
 */

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function CooldownClock({ secondsRemaining, ready, totalSeconds }) {
  if (ready || totalSeconds <= 0) return null;
  const txt = formatRemaining(secondsRemaining);
  return (
    <span
      data-testid="cooldown-clock"
      style={{
        position: "absolute",
        bottom: 0,
        right: 0,
        display: "flex",
        alignItems: "center",
        gap: 2,
        background: "rgba(0,0,0,0.7)",
        borderRadius: 4,
        padding: "1px 3px",
        fontSize: 9,
        color: "#fde68a",
        fontFamily: "monospace",
        pointerEvents: "none",
      }}
      title={`Cooldown — ${txt} until next fire (${totalSeconds}s total)`}
    >
      <span style={{ fontSize: 10 }}>⏳</span>
      <span>{txt}</span>
    </span>
  );
}
