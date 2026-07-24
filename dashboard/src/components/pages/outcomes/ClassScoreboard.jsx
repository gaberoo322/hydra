import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

/**
 * ClassScoreboard — per-class yield scoreboard weighted-quota column (issue #3551).
 *
 * Reads `GET /api/autopilot/class-stats` and surfaces the **Quota Weight** cost
 * axis (spec #3547, keystone #3548, per-merge #3549) where the operator already
 * reviews weekly outcomes: for every dev-role class it shows the total
 * `weightedQuota` burned over the scoreboard window and the
 * `weightedQuotaPerMerge` — the true weighted-quota cost of one shipped PR,
 * which makes an Opus-over-huge-context class visible as cost-ineffective even
 * when its raw `tokensPerMerge` looks ordinary.
 *
 * This panel is READ-ONLY and shadow-mode: it reports what each class costs; it
 * never changes what autopilot dispatches (the verdict/dampener in
 * `class-stats-math.ts` is the sibling shadow-mode surface, #3550). The `verdict`
 * string is rendered verbatim so a new cost verdict introduced by #3550 appears
 * here without a dashboard change.
 *
 * Null-vs-zero discipline (#3549 invariant, issue AC #2): a missing / null
 * `weightedQuota` or `weightedQuotaPerMerge` renders as an explicit "—", NEVER as
 * `0` — the scoreboard uses `null` to mean "no data / can't divide" (a class
 * below the min-sample floor, a class with no merges, or a class with no
 * weighted-quota breakdown), which is categorically different from a real zero.
 *
 * Producer-role classes score on their β attribution, not weighted-quota; they
 * carry a null weighted-quota, so this panel lists only classes that have a
 * weighted-quota figure to report — the dev classes the cost axis is about.
 * Polls every 5min to match the Outcomes page cadence.
 */

// Weighted-quota units are already large (weight-scaled token sums), so reuse the
// tok-style compaction the sibling cost panels use, but label the unit "qw" to
// keep it distinct from raw token counts (Quota Weight, not tokens).
function fmtQuota(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return String(n);
}

// Null-vs-zero: only a finite number renders; null/undefined → "—".
function quotaCell(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${fmtQuota(value)} qw` : "—";
}

// Colour the verdict so an expensive/unhealthy class stands out. Unknown /
// future verdict strings fall through to a neutral tone (forward-compatible with
// the #3550 cost verdict, which this panel does not hard-code).
function verdictText(verdict) {
  switch (verdict) {
    case "healthy":
      return "text-emerald-300";
    case "insufficient-sample":
    case "not-scored":
      return "text-zinc-500";
    default:
      // Any non-healthy scored verdict (e.g. an expensive cost verdict) → amber.
      return "text-amber-300";
  }
}

function fmtWindow(windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const days = Math.round(windowMs / 86_400_000);
  return `trailing ${days}d`;
}

export function ClassScoreboard() {
  const { data, error, loading } = useApi(`/autopilot/class-stats`, {
    poll: 5 * 60_000,
  });

  const scoreboard = data?.scoreboard || null;
  const classes = Array.isArray(scoreboard?.classes) ? scoreboard.classes : [];

  // Only classes that actually carry a weighted-quota figure are the cost axis's
  // subject (dev classes). A null weightedQuota means "not a weighted-quota
  // scored class" — omit it rather than render a row of "—" for every column.
  const rows = classes
    .filter(
      (c) =>
        typeof c?.weightedQuota === "number" && Number.isFinite(c.weightedQuota),
    )
    .sort((a, b) => (b.weightedQuota || 0) - (a.weightedQuota || 0));

  const windowLabel = fmtWindow(scoreboard?.windowMs);

  return (
    <Section
      title="Class scoreboard — quota weight"
      subtitle="Per-class Quota-Weight burn from the yield scoreboard: total weighted quota and weighted-quota-per-merge for dev classes. Shadow-mode — reports cost, actuates nothing."
      right={windowLabel}
      loading={loading}
      error={error}
      empty={!loading && !error && rows.length === 0}
      emptyMessage="No class has a weighted-quota figure yet (all below the min-sample floor)."
    >
      {rows.length > 0 && (
        <div className="space-y-2">
          {/* Column header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 text-[10px] uppercase tracking-wide text-zinc-500">
            <span>Class</span>
            <span className="text-right">Weighted quota</span>
            <span className="text-right">Qw / merge</span>
            <span className="text-right">Verdict</span>
          </div>

          {rows.map((c) => (
            <div
              key={c.className}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-2"
            >
              <span className="text-sm font-mono text-zinc-100 truncate">
                {c.className}
              </span>
              <span className="text-sm font-mono text-sky-300 text-right">
                {quotaCell(c.weightedQuota)}
              </span>
              <span className="text-sm font-mono text-sky-300 text-right">
                {quotaCell(c.weightedQuotaPerMerge)}
              </span>
              <span
                className={`text-xs font-mono text-right ${verdictText(c.verdict)}`}
              >
                {c.verdict || "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
