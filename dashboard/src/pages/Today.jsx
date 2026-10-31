import { useApi } from "../hooks/useApi.js";
import { AttentionFeed } from "../components/pages/today/AttentionFeed.jsx";
import { OvernightBanner } from "../components/pages/today/OvernightBanner.jsx";
import { WeekModelMix } from "../components/pages/today/WeekModelMix.jsx";
import { StuckItems } from "../components/pages/today/StuckItems.jsx";
import { RecentMerges } from "../components/pages/today/RecentMerges.jsx";
import { NewTargetFindings } from "../components/pages/today/NewTargetFindings.jsx";
import { LessonsOvernight } from "../components/pages/today/LessonsOvernight.jsx";
import Versions from "../components/Versions.jsx";

/**
 * Dashboard v2 — `/today` page (issues #616, #617, PRD #615).
 *
 * Slice 1 shipped the OvernightBanner. Slice 2 adds the further sections
 * in the order specified by the PRD:
 *
 *   1. AttentionFeed (issue #4007, ADR-0034 §4/§8 — threshold-crossing feed
 *      in six bucket sections with per-kind action affordances, issue #4628;
 *      renders FIRST: the "what needs me" question owns the page)
 *   2. OvernightBanner (banner — fed by /today/summary)
 *   3. StuckItems
 *   4. RecentMerges
 *   5. NewTargetFindings
 *   6. LessonsOvernight
 *   7. Versions (issue #3681 — the /api/versions panel; lives one level up in
 *      `components/` because the footer VersionBadge shares its formatting seam
 *      and renders on every route, not just Today)
 *
 * The overnight decision-queue panel (PRD #615 slice 2's third section) is
 * REMOVED — ADR-0034 §8.1 superseded it with the bucketed attention feed;
 * every waiting-on-you decision now drains through the feed's waiting-on-you
 * bucket with its typed registry action (issue #4628). The backend route,
 * its aggregator and its projection are all deleted (#5160, #5093).
 *
 * StuckItems and AttentionFeed both poll at 30s on purpose: the server
 * single-flights the issue-label read, so overlapping polls cost one `gh`
 * fetch per label (issue #5093).
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
          Dashboard v2 — attention feed, overnight banner, stuck items, recent merges, target
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

      {/* AttentionFeed is FIRST (ADR-0034 §4): the threshold-crossing feed
          owns the "what needs me" primacy on `/`, ahead of the overnight
          banner. The other sections stay — the full Today-page teardown of
          non-conforming panels belongs to the epic, not this slice. */}
      <AttentionFeed />

      {data && <OvernightBanner summary={data} />}

      {usage && <WeekModelMix usage={usage} />}

      <StuckItems />
      <RecentMerges />
      <NewTargetFindings />
      <LessonsOvernight />
      <Versions />
    </div>
  );
}
