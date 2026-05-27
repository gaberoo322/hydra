/**
 * Tiny inline SVG sparkline — used by the OutcomeCards, CalibrationTrend,
 * LessonsTrend, and SubscriptionQuotaTrend sections. Pure presentational:
 * takes a list of `{t, v}` points and renders a polyline scaled to its
 * width/height. Renders gracefully with 0 or 1 points (single dot for
 * one point, nothing for zero).
 *
 * Why hand-rolled SVG rather than a chart lib: the orchestrator carries
 * zero runtime chart dependencies, and the v2 page only needs
 * trend-shape glances — not interactive zoom/legend/etc. A 40-line
 * helper is cheaper than a kbyte-heavy chart package for this surface.
 */
export function Sparkline({ points = [], width = 160, height = 36, stroke = "#a78bfa", fill = "transparent" }) {
  const xs = Array.isArray(points) ? points : [];
  if (xs.length === 0) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <text x={4} y={height / 2 + 4} fill="#52525b" fontSize="10">
          no data
        </text>
      </svg>
    );
  }
  if (xs.length === 1) {
    const cx = width / 2;
    const cy = height / 2;
    return (
      <svg width={width} height={height} aria-hidden="true">
        <circle cx={cx} cy={cy} r={3} fill={stroke} />
        <text x={cx + 6} y={cy + 4} fill="#71717a" fontSize="10">
          {formatV(xs[0].v)}
        </text>
      </svg>
    );
  }
  const vs = xs.map((p) => Number(p.v) || 0);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const range = max - min || 1;
  const stepX = xs.length > 1 ? width / (xs.length - 1) : 0;
  const d = xs
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((Number(p.v) - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} stroke={stroke} fill={fill} strokeWidth={1.5} />
    </svg>
  );
}

function formatV(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(2);
}
