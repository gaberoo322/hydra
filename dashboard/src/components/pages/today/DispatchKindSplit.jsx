import { CROSS_TAB_FAMILIES } from "./cross-tab-families.js";

/**
 * The three dispatch kinds (issue #2403), in precedence/render order, with
 * short human labels for the kind-split row. Mirrors `DISPATCH_KINDS` in
 * `src/cost/transcript-scan.ts`.
 */
const DISPATCH_KINDS = ["autopilot-dispatched", "operator-invoked", "interactive"];
const DISPATCH_KIND_LABELS = {
  "autopilot-dispatched": "autopilot",
  "operator-invoked": "operator",
  interactive: "interactive",
};

/**
 * Attribution coverage % + the 3-way dispatch-kind token split (issue #2403).
 *
 * Reads `attributedPercent` (the inverse of the interactive-residual share) and
 * `byDispatchKind` (per-kind × per-family RAW token totals) from `/api/usage`.
 * Renders the coverage headline plus one chip per kind showing that kind's
 * share of total tokens. Raw token counts only — matching the cross-tab's
 * read-only posture. Renders nothing when the split is absent or empty.
 */
export function DispatchKindSplit({ byDispatchKind, attributedPercent }) {
  if (!byDispatchKind) return null;

  const kindTotal = (kind) => {
    const row = byDispatchKind[kind];
    if (!row) return 0;
    return CROSS_TAB_FAMILIES.reduce((acc, f) => acc + (row[f]?.total ?? 0), 0);
  };
  const totals = DISPATCH_KINDS.map((k) => [k, kindTotal(k)]);
  const grand = totals.reduce((acc, [, t]) => acc + t, 0);
  if (grand <= 0) return null;

  const coverage = typeof attributedPercent === "number" ? attributedPercent : 0;
  const coverageColor =
    coverage >= 80 ? "text-emerald-400" : coverage >= 50 ? "text-amber-400" : "text-zinc-400";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="text-zinc-500 uppercase tracking-wide">Attribution coverage</span>
      <span className={`font-semibold ${coverageColor}`}>{coverage.toFixed(1)}%</span>
      <span className="text-zinc-600">·</span>
      {totals.map(([kind, t]) => {
        const share = Math.round((t / grand) * 100);
        return (
          <span key={kind} className="text-zinc-400 font-mono">
            {DISPATCH_KIND_LABELS[kind]} {share}%
          </span>
        );
      })}
    </div>
  );
}
