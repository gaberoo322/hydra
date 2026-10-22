import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";

/**
 * FeedCalibration — the /builder "Feed calibration" panel (issue #4634,
 * design-concept a7e7fedb INV-2/4/5; ADR-0034 §8.4 / §9.4).
 *
 * Homes GET /attention/counts: one row per attention-feed admission line with
 * its rolling-window dispositions {surfaced, notAProblem, handledElsewhere,
 * later, resolved} and the server's calibration verdict + `because`.
 *
 * Derived-value rule (ADR-0034 §5.3): the verdict is a DERIVED value, so the
 * row renders the server's `because` string VERBATIM as its decomposition.
 * This panel never recomputes the ratio / minimum-episode / window constants —
 * they live in src/attention-calibration.ts and reach the client only through
 * `because` and `windowDays`.
 *
 * Ordering: miscalibrated → calibrated → insufficient-data, stable within a
 * group (the server's drain order is kept inside each group).
 *
 * Trust (ADR-0034 §5): rides usePageItems on a ~1-day budget. The `lines`
 * array is fixed-length (one row per admission line), so an empty array is a
 * malformed payload, not an asserted zero — it renders UNKNOWN.
 *
 * Read-only: /builder carries no action controls (ADR-0034 §2).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const VERDICT_RANK = { miscalibrated: 0, calibrated: 1, "insufficient-data": 2 };

const VERDICT_CHIP = {
  miscalibrated: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  calibrated: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  "insufficient-data": "bg-zinc-700/40 text-zinc-400 border-zinc-600",
};

/** Miscalibrated first; Array.prototype.sort is stable, so drain order holds within a group. */
function sortByVerdict(lines) {
  const rank = (v) => (v in VERDICT_RANK ? VERDICT_RANK[v] : 3);
  return [...lines].sort((a, b) => rank(a?.verdict) - rank(b?.verdict));
}

export function FeedCalibration() {
  const { items, data, status, error } = usePageItems("/attention/counts", {
    itemsKey: "lines",
    freshnessMs: DAY_MS,
    poll: 5 * 60_000,
  });

  // A fixed-length lines array that comes back empty asserts nothing.
  const unknown = status === "loading" || status === "unknown" || status === "empty";
  const stale = status === "stale";
  const lines = sortByVerdict(items);
  const windowDays = typeof data?.windowDays === "number" ? data.windowDays : null;

  return (
    <Section
      title="Feed calibration"
      subtitle={`Attention-feed admission lines, miscalibrated first — each verdict shows the server's own because${
        windowDays !== null ? ` (rolling ${windowDays}d window)` : ""
      }.`}
      count={unknown ? undefined : lines.length}
      error={unknown ? error : null}
      unknown={unknown}
      stale={stale}
      generatedAt={data?.generatedAt}
    >
      <div className="overflow-x-auto" data-testid="feed-calibration">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-500 text-[10px] uppercase tracking-widest border-b border-zinc-800">
              <th className="text-left py-2 pr-3 font-semibold">Admission line</th>
              <th className="text-left py-2 pr-3 font-semibold">Verdict</th>
              <th className="text-right py-2 pr-3 font-semibold">Surfaced</th>
              <th className="text-right py-2 pr-3 font-semibold">Not a problem</th>
              <th className="text-right py-2 pr-3 font-semibold">Handled elsewhere</th>
              <th className="text-right py-2 pr-3 font-semibold">Later</th>
              <th className="text-right py-2 pr-3 font-semibold">Resolved</th>
              <th className="text-left py-2 pr-1 font-semibold">Because</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} className="border-b border-zinc-800/40" data-testid="feed-calibration-row">
                <td className="py-1.5 pr-3 font-mono text-zinc-200">{line.key}</td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                      VERDICT_CHIP[line.verdict] ?? VERDICT_CHIP["insufficient-data"]
                    }`}
                  >
                    {line.verdict ?? "UNKNOWN"}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{line.surfaced}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-300">{line.notAProblem}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-400">{line.handledElsewhere}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-400">{line.later}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-zinc-400">{line.resolved}</td>
                {/* §5.3: the verdict's decomposition, verbatim from the server. */}
                <td className="py-1.5 pr-1 font-mono text-[11px] text-zinc-500">{line.because}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
