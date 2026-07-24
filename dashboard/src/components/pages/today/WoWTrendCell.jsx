/**
 * Render a single skill's week-over-week trend cell (issue #2404).
 *
 * `entry` is `bySkillWoW[skill] = {current, prior, deltaPct}`. A null/absent
 * entry or a null `deltaPct` (no prior snapshot, or "new this week") renders a
 * muted "new"; otherwise an up/down arrow + signed percentage, green when the
 * skill's burn fell week-over-week, amber when it rose.
 */
export function WoWTrendCell({ entry }) {
  if (!entry || entry.deltaPct === null || entry.deltaPct === undefined) {
    return <span className="text-zinc-600">new</span>;
  }
  const pct = entry.deltaPct;
  const up = pct > 0;
  const flat = Math.abs(pct) < 0.05;
  const color = flat ? "text-zinc-500" : up ? "text-amber-400" : "text-emerald-400";
  const arrow = flat ? "→" : up ? "▲" : "▼";
  const sign = up ? "+" : "";
  return (
    <span className={color}>
      {arrow} {sign}
      {pct.toFixed(1)}%
    </span>
  );
}
