import { BoardState } from "../components/pages/work/BoardState.jsx";
import { AnchorRationale } from "../components/pages/work/AnchorRationale.jsx";

/**
 * /work — the queue page (issue #4010, dashboard v3 slice, ADR-0034 §3):
 * "what is queued, what is next, and why that?"
 *
 * Two surfaces, both on the #4006/#4007 trust seam (usePageItems + Section,
 * ADR-0034 §5):
 *
 *   BoardState — lane counts + the ready-for-agent queue, each excluded row
 *   annotated with WHY it is not dispatchable (target-backlog routing,
 *   drainer-owned, open strict blocker), plus the issue-lifecycle actions
 *   (ADR-0034 §7: promote is confirm-first and double-refused server-side;
 *   relabel/close/reopen are immediate and verified post-write).
 *
 *   AnchorRationale — the anchor-distribution projection as the why-that
 *   explanation: which priority lanes the autopilot actually served over
 *   the recent window.
 *
 * Anti-scope (issue #4010 / ADR-0034 §2): no run history, no failure
 * detail — /runs owns forensics.
 */
export default function Work() {
  return (
    <div className="space-y-5" data-testid="work-page">
      <div>
        <h1 className="text-2xl font-bold">Work</h1>
        <p className="text-sm text-zinc-400">
          What is queued, what is next, and why that? — board state, the ready-for-agent
          queue, and the anchor distribution behind it. Failure forensics live on Runs.
        </p>
      </div>
      <BoardState />
      <AnchorRationale />
    </div>
  );
}
