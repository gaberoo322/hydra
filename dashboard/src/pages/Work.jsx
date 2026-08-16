import { BoardState } from "../components/pages/work/BoardState.jsx";
import { AnchorRationale } from "../components/pages/work/AnchorRationale.jsx";

/**
 * Dashboard v3 — `/work` page (issue #4010, ADR-0034 §2; slice "epsilon" of
 * the cockpit epic #4005).
 *
 * The one question: *what is queued, what is next, and why that?* The board
 * counts + the ready-for-agent queue (with the issue-lifecycle actions
 * ADR-0034 §7 assigns this page), plus the anchor-distribution rationale
 * explaining the autopilot's lane balance. This is the ONLY cockpit page
 * that acts on the board — /health brakes, /builder reviews, /runs audits,
 * /work decides.
 *
 * Anti-scope (ADR-0034 §2): no run history, no failure detail — /runs owns
 * forensics. Nothing here renders a cycle's failure output.
 *
 * Every panel rides the trust seam (#4006/#4007 usePageItems + Section
 * contract): unproven renders UNKNOWN, aged renders stale with an amber
 * as-of, and the as-of age is always visible.
 */
export default function Work() {
  return (
    <div className="max-w-5xl space-y-4" data-testid="work-page">
      <div>
        <h1 className="text-2xl font-bold">Work</h1>
        <p className="text-sm text-zinc-400">
          What is queued, what is next, and why that — the board, the
          ready-for-agent queue, and the autopilot&apos;s lane balance.
        </p>
      </div>
      <BoardState />
      <AnchorRationale />
    </div>
  );
}
