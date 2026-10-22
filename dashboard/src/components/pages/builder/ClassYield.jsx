import { useApi } from "../../../hooks/useApi.js";
import { derivePageStatus } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import { formatTokens } from "../../../lib/autopilot-format.js";

/**
 * ClassYield — /builder's per-class yield view (issue #4637, ADR-0034 §9.2).
 *
 * The weekly question for each autopilot dispatch class: *is it paying for
 * itself?* Reads the per-class yield scoreboard + the shadow-mode dampener
 * plan from GET /api/autopilot/class-stats (memoised 10 minutes server-side),
 * one row per class in the scoreboard's own order.
 *
 * Trust contract (ADR-0034 §5): status derives through derivePageStatus with
 * itemsLen = scoreboard.classes.length and a 1-day freshness budget (/builder
 * is the day tier) — a failed fetch or missing generatedAt renders UNKNOWN,
 * an aged scoreboard renders stale, and the as-of is always visible.
 * Derived values decompose (§5.3): every verdict cell shows the inputs that
 * produced it — dispatches vs the min-sample floor, the merge rate or β, and
 * the window.
 *
 * Anti-scope (ADR-0034 §2): read-only — no writes, no action controls.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function pct(rate) {
  return typeof rate === "number" ? `${Math.round(rate * 100)}%` : "—";
}

function windowLabel(windowMs) {
  if (typeof windowMs !== "number" || windowMs <= 0) return "window UNKNOWN";
  const days = windowMs / DAY_MS;
  return Number.isInteger(days) ? `${days}d window` : `${Math.round(windowMs / 3_600_000)}h window`;
}

function betaLabel(stat) {
  if (stat.role !== "producer") return "—";
  if (stat.betaSuspect === true) {
    return typeof stat.beta === "number" ? `β ${stat.beta.toFixed(3)} (suspect)` : "β suspect";
  }
  return typeof stat.beta === "number" ? `β ${stat.beta.toFixed(3)}` : "—";
}

/** The inputs that produced a verdict — rendered beside it (§5.3). */
function verdictInputs(stat, scoreboard) {
  const parts = [`${stat.dispatches} dispatches vs min ${scoreboard.minSample}`];
  if (stat.role === "dev") {
    parts.push(
      typeof stat.mergeRate === "number"
        ? `merge ${pct(stat.mergeRate)} (${stat.mergedCount ?? "—"} of ${stat.dispatches})`
        : "merge rate —",
    );
  } else if (stat.role === "producer") {
    parts.push(betaLabel(stat));
  } else {
    parts.push("not a yield-scored role");
  }
  parts.push(windowLabel(scoreboard.windowMs));
  return parts.join(" · ");
}

const VERDICT_STYLE = {
  healthy: "text-emerald-300",
  underperforming: "text-amber-300",
  expensive: "text-amber-300",
  "insufficient-sample": "text-zinc-400",
  "not-scored": "text-zinc-500",
};

export function ClassYield() {
  const { data, error, loading } = useApi("/autopilot/class-stats", { poll: 600_000 });
  const scoreboard = data?.scoreboard ?? null;
  const classes = Array.isArray(scoreboard?.classes) ? scoreboard.classes : [];
  const status = derivePageStatus({
    data,
    error,
    loading,
    itemsLen: classes.length,
    freshnessMs: DAY_MS,
  });

  const shadowByClass = new Map(
    (Array.isArray(data?.shadow?.verdicts) ? data.shadow.verdicts : []).map((v) => [v.className, v]),
  );

  return (
    <Section
      title="Class yield"
      subtitle="Per dispatch class: dispatches, merge rate or β, cost per merge, the verdict and the shadow-mode cadence multiplier a live dampener would apply."
      count={classes.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="The scoreboard carries no classes."
    >
      <div className="overflow-x-auto">
        <table data-testid="class-yield-table" className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
              <th className="py-2 pr-3 font-normal">Class</th>
              <th className="py-2 pr-3 font-normal">Role</th>
              <th className="py-2 pr-3 font-normal text-right">Dispatches</th>
              <th className="py-2 pr-3 font-normal text-right">Merge rate</th>
              <th className="py-2 pr-3 font-normal text-right">Tokens / merge</th>
              <th className="py-2 pr-3 font-normal text-right">Weighted quota / merge</th>
              <th className="py-2 pr-3 font-normal">β</th>
              <th className="py-2 pr-3 font-normal">Verdict (inputs)</th>
              <th className="py-2 pr-3 font-normal text-right">Shadow ×</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-700/50">
            {classes.map((stat) => {
              const shadow = shadowByClass.get(stat.className);
              return (
                <tr key={stat.className} data-testid={`class-yield-row-${stat.className}`} className="align-top">
                  <td className="py-1.5 pr-3 font-mono text-zinc-100">{stat.className}</td>
                  <td className="py-1.5 pr-3 text-zinc-400">{stat.role}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{stat.dispatches}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{pct(stat.mergeRate)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{formatTokens(stat.tokensPerMerge)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">
                    {formatTokens(stat.weightedQuotaPerMerge)}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-400">{betaLabel(stat)}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`font-mono ${VERDICT_STYLE[stat.verdict] ?? "text-zinc-300"}`}>{stat.verdict}</span>
                    {scoreboard && (
                      <span className="block text-[11px] text-zinc-500">{verdictInputs(stat, scoreboard)}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">
                    {shadow ? (
                      <span title={shadow.reprobeAt ? `re-probe at ${new Date(shadow.reprobeAt).toISOString()}` : undefined}>
                        {shadow.multiplier.toFixed(1)}×
                      </span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
