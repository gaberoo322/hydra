/**
 * Dashboard v2 — `/outcomes` page (issue #619, PRD #615 slice 4).
 *
 * Strategic-review surface: "did the system get better this week?"
 * Six 7-day-trend sections, each polling every 5min (slow cadence
 * because this is a weekly-review surface, not live monitoring):
 *
 *   1. OutcomeCards            — per-outcome trend + delta vs baseline
 *   2. BuilderHealth           — Builder-Health Scorecard (issue #732): the
 *                               builder-side counterpart to OutcomeCards —
 *                               autonomy rate, time-to-merge, self-improvement
 *                               share, rework, scope-violations, learning.
 *   3. CacheEconomics          — point-in-time cache-hit ratio (5h / 7d)
 *   4. CostByClass             — per-class token-spend share today (issue #1439)
 *   5. LessonsTrend            — promotion rate + top friction + meta count
 *   6. SubscriptionQuotaTrend  — % burned + headroom
 *
 * NB: the CalibrationTrend panel (tier + cost accuracy) was removed in
 * issue #2876 — its `/outcomes/calibration` endpoint always returned empty
 * sparklines (the backing lane lost its writer in ADR-0016).
 *
 * NB: the page deliberately does NOT reference `/api/stuckness` or any
 * stuckness-detector surface — that subsystem was retired by ADR-0010.
 */
import { OutcomeCards } from "../components/pages/outcomes/OutcomeCards.jsx";
import { BuilderHealth } from "../components/pages/outcomes/BuilderHealth.jsx";
import { CacheEconomics } from "../components/pages/outcomes/CacheEconomics.jsx";
import { CostByClass } from "../components/pages/outcomes/CostByClass.jsx";
import { LessonsTrend } from "../components/pages/outcomes/LessonsTrend.jsx";
import { SubscriptionQuotaTrend } from "../components/pages/outcomes/SubscriptionQuotaTrend.jsx";

export default function Outcomes() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Outcomes (v2)</h1>
        <p className="text-sm text-zinc-400">
          Dashboard v2 — 7-day strategic trends. Per-outcome deltas,
          learning-system promotions, and subscription quota burn.
        </p>
      </div>

      <OutcomeCards />
      <BuilderHealth />
      <CacheEconomics />
      <CostByClass />
      <LessonsTrend />
      <SubscriptionQuotaTrend />
    </div>
  );
}
