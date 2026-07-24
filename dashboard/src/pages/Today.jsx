import { useApi } from "../hooks/useApi.js";
import { OvernightBanner } from "../components/pages/today/OvernightBanner.jsx";
import { WeekModelMix } from "../components/pages/today/WeekModelMix.jsx";
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
 * the slower-moving merges section). The "this week so far" model-mix and
 * per-skill cross-tab sections (WeekModelMix + its SkillModelCrossTab /
 * DispatchKindSplit / WoWTrendCell sub-components) also live there.
 */

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
