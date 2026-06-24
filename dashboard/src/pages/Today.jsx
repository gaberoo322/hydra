import { useApi } from "../hooks/useApi.js";
import { OperatorDecisionQueue } from "../components/pages/today/OperatorDecisionQueue.jsx";
import { StuckItems } from "../components/pages/today/StuckItems.jsx";
import { RecentMerges } from "../components/pages/today/RecentMerges.jsx";
import { NewTargetFindings } from "../components/pages/today/NewTargetFindings.jsx";
import { LessonsOvernight } from "../components/pages/today/LessonsOvernight.jsx";

/**
 * Dashboard v2 — `/today` page (issues #616, #617, PRD #615).
 *
 * Slice 1 shipped the OvernightBanner. Slice 2 adds five more sections
 * in the order specified by the PRD:
 *
 *   1. OvernightBanner (banner — fed by /today/summary)
 *   2. OperatorDecisionQueue
 *   3. StuckItems
 *   4. RecentMerges
 *   5. NewTargetFindings
 *   6. LessonsOvernight
 *
 * Each section lives in `dashboard/src/components/pages/today/` and owns
 * its own poll cadence (30s for the operator-attention sections, 60s for
 * the slower-moving merges section).
 */

const HEADROOM_STYLES = {
  green: {
    chip: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30",
    dot: "bg-emerald-400",
    label: "Headroom: clear",
  },
  yellow: {
    chip: "bg-yellow-500/10 text-yellow-300 border border-yellow-500/30",
    dot: "bg-yellow-400",
    label: "Headroom: on pace",
  },
  red: {
    chip: "bg-red-500/10 text-red-300 border border-red-500/30",
    dot: "bg-red-400 animate-pulse",
    label: "Headroom: over budget",
  },
  unknown: {
    chip: "bg-zinc-500/10 text-zinc-300 border border-zinc-500/30",
    dot: "bg-zinc-400",
    label: "Headroom: uncalibrated",
  },
};

function formatMoney(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * "This week so far" per-model mix line (issue #691).
 *
 * Reads `byModel` (7d window) from `/api/usage` and renders the opus /
 * sonnet / haiku share of total tokens as a headline. The percentages are
 * derived in the view from `byModel[f].total / tokensLast7d.total` so the
 * tracker stays raw-counts-only. When quota-weight calibration is absent we
 * render a neutral chip instead of fabricating numbers — the share math
 * itself does not need calibration, but the chip signals the operator that
 * the weighted Quota-Weight burn figure isn't available yet.
 */
function WeekModelMix({ usage }) {
  const byModel = usage?.byModel;
  const total = usage?.tokensLast7d?.total ?? 0;

  if (!byModel) return null;

  const pct = (family) => {
    if (total <= 0) return 0;
    return Math.round(((byModel[family]?.total ?? 0) / total) * 100);
  };

  const calibrated = Boolean(usage?.quotaWeightCalibrated);
  const hasUnknown = (byModel.unknown?.total ?? 0) > 0;
  // The quota weights only shape the *estimate* fallback figure; under the
  // OAuth meter the authoritative percentage comes straight from the OAuth
  // usage read, so calibration has no effect and the loud "needs calibration"
  // banner is a false alarm (issue #2405). Suppress it under `oauth` (including
  // a served-stale last-good, which is still `usageSource === "oauth"`) and
  // show a quiet explained state; only surface the loud banner when the
  // transcript estimate is the active source AND the weights are uncalibrated.
  const isOauthSource = usage?.usageSource === "oauth";

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">
            This week so far
          </h2>
          {total > 0 ? (
            <p className="text-lg font-semibold text-zinc-100">
              {pct("opus")}% opus
              <span className="text-zinc-500 mx-2">/</span>
              {pct("sonnet")}% sonnet
              <span className="text-zinc-500 mx-2">/</span>
              {pct("haiku")}% haiku
              {hasUnknown && (
                <>
                  <span className="text-zinc-500 mx-2">/</span>
                  {pct("unknown")}% unknown
                </>
              )}
            </p>
          ) : (
            <p className="text-lg font-semibold text-zinc-500">No tokens recorded yet</p>
          )}
        </div>
        {!calibrated &&
          (isOauthSource ? (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs whitespace-nowrap bg-zinc-700/20 text-zinc-500 border border-zinc-700/40"
              title="Quota percentages come from the OAuth usage meter, so quota weights don't affect them — calibration isn't needed."
            >
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
              Quota weights inactive under OAuth meter
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap bg-zinc-500/10 text-zinc-300 border border-zinc-500/30">
              <span className="w-2 h-2 rounded-full bg-zinc-400" />
              Quota-weight calibration needed
            </div>
          ))}
      </div>
      <SkillModelCrossTab
        bySkillByModel={usage?.bySkillByModel}
        bySkillWoW={usage?.bySkillWoW}
        byDispatchKind={usage?.byDispatchKind}
        attributedPercent={usage?.attributedPercent}
      />
    </div>
  );
}

const CROSS_TAB_FAMILIES = ["opus", "sonnet", "haiku", "unknown"];

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
function DispatchKindSplit({ byDispatchKind, attributedPercent }) {
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

/**
 * Render a single skill's week-over-week trend cell (issue #2404).
 *
 * `entry` is `bySkillWoW[skill] = {current, prior, deltaPct}`. A null/absent
 * entry or a null `deltaPct` (no prior snapshot, or "new this week") renders a
 * muted "new"; otherwise an up/down arrow + signed percentage, green when the
 * skill's burn fell week-over-week, amber when it rose.
 */
function WoWTrendCell({ entry }) {
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

/**
 * Expandable per-skill × per-model token cross-tab (issue #693), with a
 * week-over-week per-skill trend column (issue #2404).
 *
 * Reads `bySkillByModel` + `bySkillWoW` from `/api/usage` and renders one row
 * per dispatching skill, one column per model family, a per-skill row total,
 * and the WoW trend of that total vs the immediately-prior stored Weekly Usage
 * Snapshot. Sessions with no dispatch-registry entry appear under the
 * `interactive`/`unattributed` row. Raw token counts only — no quota-weight, no
 * spend figures — matching the tracker's read-only posture. Auto-EXPANDED when
 * populated (issue #2404) so the per-skill trend is visible at a glance rather
 * than hidden behind a collapsed disclosure.
 */
function SkillModelCrossTab({ bySkillByModel, bySkillWoW, byDispatchKind, attributedPercent }) {
  if (!bySkillByModel) return null;
  const skills = Object.keys(bySkillByModel).sort();
  if (skills.length === 0) return null;

  const rowTotal = (row) =>
    CROSS_TAB_FAMILIES.reduce((acc, f) => acc + (row[f]?.total ?? 0), 0);

  // Sort skills by descending total so the heaviest consumer is on top.
  skills.sort((a, b) => rowTotal(bySkillByModel[b]) - rowTotal(bySkillByModel[a]));

  const wow = bySkillWoW ?? {};

  return (
    <details className="mt-3 group" open>
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-400 hover:text-zinc-200 select-none">
        Per-skill breakdown ({skills.length})
      </summary>
      <DispatchKindSplit
        byDispatchKind={byDispatchKind}
        attributedPercent={attributedPercent}
      />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm text-right tabular-nums">
          <thead>
            <tr className="text-zinc-500 border-b border-zinc-700">
              <th className="text-left font-medium py-1 pr-3">Skill</th>
              {CROSS_TAB_FAMILIES.map((f) => (
                <th key={f} className="font-medium py-1 px-3">
                  {f}
                </th>
              ))}
              <th className="font-medium py-1 px-3">total</th>
              <th className="font-medium py-1 pl-3">wow</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => {
              const row = bySkillByModel[skill];
              return (
                <tr key={skill} className="border-b border-zinc-800/60">
                  <td className="text-left text-zinc-300 py-1 pr-3 font-mono">{skill}</td>
                  {CROSS_TAB_FAMILIES.map((f) => (
                    <td key={f} className="text-zinc-400 py-1 px-3">
                      {(row[f]?.total ?? 0).toLocaleString()}
                    </td>
                  ))}
                  <td className="text-zinc-200 py-1 px-3 font-semibold">
                    {rowTotal(row).toLocaleString()}
                  </td>
                  <td className="py-1 pl-3 font-medium">
                    <WoWTrendCell entry={wow[skill]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function OvernightBanner({ summary }) {
  const headroomStyle = HEADROOM_STYLES[summary?.headroom || "unknown"];
  const merges = summary?.mergeCount ?? 0;
  const runs = summary?.runCount ?? 0;
  const cost = summary?.costSpent ?? 0;
  const issues = summary?.issuesOpened ?? 0;
  const hours = summary?.windowHours ?? 12;

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">
            Since you were gone — last {hours}h
          </h2>
          <p className="text-2xl font-semibold text-zinc-100">
            {merges} {merges === 1 ? "PR" : "PRs"} merged
            <span className="text-zinc-500 mx-2">·</span>
            {runs} autopilot {runs === 1 ? "run" : "runs"}
            <span className="text-zinc-500 mx-2">·</span>
            {formatMoney(cost)} spent
            <span className="text-zinc-500 mx-2">·</span>
            {issues} {issues === 1 ? "issue" : "issues"} opened
          </p>
        </div>
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap ${headroomStyle.chip}`}
        >
          <span className={`w-2 h-2 rounded-full ${headroomStyle.dot}`} />
          {headroomStyle.label}
        </div>
      </div>
      {summary?.generatedAt && (
        <p className="text-xs text-zinc-500">
          Updated {new Date(summary.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

export default function Today() {
  const { data, error, loading } = useApi("/today/summary", { poll: 60_000 });
  const { data: usage } = useApi("/usage", { poll: 60_000 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Today</h1>
        <p className="text-sm text-zinc-400">
          Dashboard v2 — overnight banner, decision queue, stuck items, recent merges, target
          findings, and overnight lessons.
        </p>
      </div>

      {loading && !data && (
        <div className="bg-zinc-800/30 rounded-lg animate-pulse h-32" />
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg p-4">
          <div className="font-semibold mb-1">Couldn't load overnight summary</div>
          <div className="text-sm font-mono break-all">{error}</div>
        </div>
      )}

      {data && <OvernightBanner summary={data} />}

      {usage && <WeekModelMix usage={usage} />}

      <OperatorDecisionQueue />
      <StuckItems />
      <RecentMerges />
      <NewTargetFindings />
      <LessonsOvernight />
    </div>
  );
}
