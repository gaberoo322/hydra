/**
 * Dashboard v2 — `/v2/outcomes` page (issue #619, PRD #615 slice 4).
 *
 * Strategic-review surface: "did the system get better this week?"
 * Four 7-day-trend sections, each polling every 5min (slow cadence
 * because this is a weekly-review surface, not live monitoring):
 *
 *   1. OutcomeCards            — per-outcome trend + delta vs baseline
 *   2. CalibrationTrend        — tier + cost accuracy time series
 *   3. LessonsTrend            — promotion rate + top friction + meta count
 *   4. SubscriptionQuotaTrend  — % burned + headroom
 *
 * NB: the page deliberately does NOT reference `/api/stuckness` or any
 * stuckness-detector surface — that subsystem was retired by ADR-0010.
 */
import { OutcomeCards } from "../../components/v2/outcomes/OutcomeCards.jsx";
import { CalibrationTrend } from "../../components/v2/outcomes/CalibrationTrend.jsx";
import { LessonsTrend } from "../../components/v2/outcomes/LessonsTrend.jsx";
import { SubscriptionQuotaTrend } from "../../components/v2/outcomes/SubscriptionQuotaTrend.jsx";

export default function Outcomes() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Outcomes (v2)</h1>
        <p className="text-sm text-zinc-400">
          Dashboard v2 — 7-day strategic trends. Per-outcome deltas, calibration
          accuracy, learning-system promotions, and subscription quota burn.
        </p>
      </div>

      <OutcomeCards />
      <CalibrationTrend />
      <LessonsTrend />
      <SubscriptionQuotaTrend />
    </div>
  );
}
