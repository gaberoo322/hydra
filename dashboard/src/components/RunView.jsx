import { StatusPill, MetaCell, BudgetBar } from "./AutopilotAtoms.jsx";
import PipelineSnapshot from "./PipelineSnapshot.jsx";
import TurnTimeline from "./TurnTimeline.jsx";
import LogsSection from "./LogsSection.jsx";
import { statusKey, formatElapsed, formatTokens, truncId } from "../lib/autopilot-format.js";

// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589). The
// four-section run view (header + pipeline + timeline + logs) plus the
// TokenBudget subsection it owns. Behavior is identical to the inline
// originals.

// ---------------------------------------------------------------------------
// Token budget subsection
//
// The two-line USD cost summary that used to live here rendered a writer-less
// plane ($0.00 forever — retired in #1651). Spend truth under the
// subscription is tokens, so this renders the run's cumulative tokens
// against its token budget.
// ---------------------------------------------------------------------------

function TokenBudget({ run }) {
  const tokens = Number(run.cumulative_tokens || 0);
  const limits = run.limits || {};
  const tokenBudget = Number(limits.token_budget) || 0;
  return (
    <div className="pt-3 border-t border-zinc-800/60">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-zinc-500 uppercase tracking-widest text-[10px]">Tokens</span>
        <span className="text-zinc-200">
          <span className="font-mono">{tokens.toLocaleString()}</span>{" "}
          <span className="text-zinc-500">/ {tokenBudget.toLocaleString()} budget (subscription-billed)</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared render for the four-section "run view" (header + pipeline + timeline
// + logs). Used by both the LIVE page (mode="live") and the DETAIL page
// (mode="detail"). The only difference between modes is that the live header
// renders the wedge badge + budget bars dynamically, while detail freezes
// everything to the run's final state.
// ---------------------------------------------------------------------------

export default function RunView({ run, turns, mode }) {
  const limits = run.limits || {};
  const tokenBudget = Number(limits.token_budget) || 0;
  const wallClockMax = Number(limits.wall_clock_max_sec) || 0;
  const idleDrainMax = Number(limits.idle_drain_turns) || 0;
  const key = statusKey(run);
  const latestTurn = turns[0] || null;
  const isLive = mode === "live";

  return (
    <>
      <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Detail mode: never show WEDGE LIKELY (terminal runs cannot wedge). */}
          <StatusPill run={isLive ? run : { ...run, wedge_likely: false }} />
          <span className="text-xs text-zinc-500 font-mono" title={run.run_id}>
            run_id: {truncId(run.run_id)}
          </span>
          {!isLive && (
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">
              static · no polling
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <MetaCell label="Started" value={run.started} mono />
          <MetaCell label="Elapsed" value={formatElapsed(run.elapsed_s)} />
          <MetaCell
            label="PID"
            value={
              isLive && key === "running"
                ? `${run.pid} ${run.pid_alive ? "(alive)" : "(dead)"}`
                : String(run.pid || "—")
            }
            mono
          />
          <MetaCell label="Trigger" value={run.trigger} />
          <MetaCell label="Term reason" value={run.term_reason || "—"} />
          <MetaCell label="Heartbeat age" value={formatElapsed(run.age_s)} />
        </div>

        <div className="space-y-3">
          <BudgetBar
            label="Tokens"
            current={run.cumulative_tokens}
            max={tokenBudget}
            formatValue={(n) => n.toLocaleString()}
          />
          <BudgetBar
            label="Wall clock (s)"
            current={run.elapsed_s}
            max={wallClockMax}
            formatValue={(n) => `${n}s`}
          />
          <BudgetBar
            label="Idle turns"
            current={run.idle_turns}
            max={idleDrainMax}
            formatValue={(n) => String(n)}
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1 border-t border-zinc-800/60">
          <MetaCell label="Turns" value={String(run.turns || 0)} mono />
          <MetaCell label="Dispatches" value={String(run.dispatches || 0)} mono />
          <MetaCell label="Cum. tokens" value={formatTokens(run.cumulative_tokens || 0)} mono />
          <MetaCell label="Idle turns" value={String(run.idle_turns || 0)} mono />
        </div>

        <TokenBudget run={run} />
      </div>

      <PipelineSnapshot run={run} latestTurn={latestTurn} />

      <TurnTimeline turns={turns} />

      <LogsSection runId={run.run_id} />
    </>
  );
}
