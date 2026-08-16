import BoardState from "../components/pages/work/BoardState.jsx";
import AnchorRationale from "../components/pages/work/AnchorRationale.jsx";

/**
 * /work — the backlog journey page (issue #4010, dashboard v3 slice epsilon,
 * ADR-0034 §2): "what is queued, what is next, and why that".
 *
 * The competitor survey (ADR-0034 §1) found no orchestrator anywhere ships
 * this page. Two panels:
 *
 *   BoardState — GET /autopilot/board-state: the lane counts, the
 *   ready-for-agent queue (the dispatchable pool), and the four
 *   issue-lifecycle actions (promote with a confirm step, relabel, close,
 *   reopen) with their VERIFIED results (ADR-0034 §7).
 *
 *   AnchorRationale — GET /metrics/anchor-distribution, surfaced live as the
 *   explanation of what the autopilot has been picking and why.
 *
 * Anti-scope (ADR-0034 §2, mirrored by the issue's own AC): NO run history
 * or failure detail — that belongs on /runs. This page renders nothing
 * per-run.
 */
export default function Work() {
  return (
    <div className="space-y-5" data-testid="work-page">
      <div>
        <h1 className="text-2xl font-bold">Work</h1>
        <p className="text-sm text-zinc-400">
          What is queued, what is next, and why that. Run forensics lives on /runs.
        </p>
      </div>
      <BoardState />
      <AnchorRationale />
    </div>
  );
}
