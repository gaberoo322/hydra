import { useEffect } from "react";
import { StatusPill, MetaCell, BudgetBar } from "./AutopilotAtoms.jsx";
import PipelineSnapshot from "./PipelineSnapshot.jsx";
import TurnTimeline from "./TurnTimeline.jsx";
import LogsSection from "./LogsSection.jsx";
import LocalTimestamp from "./LocalTimestamp.jsx";
import { statusKey, formatElapsed, formatTokens, truncId } from "../lib/autopilot-format.js";
import { classifyRunOutcome, findFailingTurn } from "./pages/runs/runs-state.js";

// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589). The
// four-section run view (header + pipeline + timeline + logs) plus the
// TokenBudget subsection it owns. Behavior is identical to the inline
// originals.
//
// Issue #4009 (ADR-0034 §2, the /runs forensics spine) adds one OPTIONAL,
// backward-compatible prop: `focusFailingTurn`. When true and the run's
// outcome is failure, the failing turn renders EXPANDED in a landing panel
// above the timeline and scrolls into view on mount — the GitHub-Actions
// affordance ("failed steps auto-expand; no hunt-for-the-red-thing").
// Existing callers that omit the prop see byte-identical output.

// ---------------------------------------------------------------------------
// Failing-turn landing panel (issue #4009 — INV-4, the failed step
// auto-expands). The turn the operator must see first, rendered expanded
// (its failed dispatch actions with slot/skill/anchor attribution) and
// scrolled into view on mount, so opening a failed run lands on the failure
// rather than on a summary.
// ---------------------------------------------------------------------------

function FailingActionRow({ action }) {
  const slot = action.slot || action.class || "—";
  const skill = action.skill || "—";
  const anchor = action.prompt_args?.anchor || action.anchor || null;
  const outcomeStatus = action.outcome?.status || "unknown";
  const prNumber = action.outcome?.prNumber || null;
  return (
    <div className="border-l-2 border-red-500/60 pl-3 py-1.5 text-xs space-y-1" data-testid="failing-action-row">
      <div className="text-red-300 font-mono">
        dispatch:{slot} <span className="text-zinc-400">→ {skill}</span>
      </div>
      {/* Attribution: the anchor this dispatch was fired at. A missing
          anchor is shown as unattributed, never guessed (INV-8). */}
      <div className="text-zinc-400 truncate" title={anchor || undefined}>
        anchor:{" "}
        {anchor ? (
          <span className="font-mono">{anchor}</span>
        ) : (
          <span className="uppercase tracking-wide text-amber-400/80">unattributed</span>
        )}
      </div>
      {action.reason && <div className="text-zinc-500 italic">{action.reason}</div>}
      <div className="text-[11px] text-zinc-400 flex flex-wrap gap-x-3">
        <span>
          status: <span className="text-red-400">{outcomeStatus}</span>
        </span>
        {prNumber && (
          <span>
            PR{" "}
            <a
              href={`https://github.com/gaberoo322/hydra/pull/${prNumber}`}
              className="text-blue-400 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              #{prNumber}
            </a>
          </span>
        )}
      </div>
    </div>
  );
}

function FailingTurnPanel({ turn }) {
  // Auto-focus on mount: the panel IS the landing target (INV-4 — "opens on
  // the failing turn, not on a summary"). No dependency array noise: run the
  // scroll exactly once when the panel mounts.
  useEffect(() => {
    const el = document.getElementById("failing-turn");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, []);

  const actions = Array.isArray(turn.actions) ? turn.actions : [];
  return (
    <div
      id="failing-turn"
      data-testid="failing-turn-panel"
      className="border border-red-500/40 rounded-lg p-5 bg-red-950/20 space-y-3"
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-red-300">
          Failing turn — Turn {turn.turn_n}
        </h2>
        <LocalTimestamp ts={turn.epoch} className="text-xs text-zinc-400 font-mono" />
      </div>
      <div className="space-y-2">
        {actions.length === 0 ? (
          <div className="text-xs text-zinc-500 italic">(no actions recorded on this turn)</div>
        ) : (
          actions.map((a, i) => <FailingActionRow key={i} action={a} />)
        )}
      </div>
      {Array.isArray(turn.reasons) && turn.reasons.length > 0 && (
        <div className="text-[11px] text-zinc-500 italic pt-1 border-t border-red-500/20">
          {turn.reasons.join(" · ")}
        </div>
      )}
      <p className="text-[11px] text-zinc-500">
        The full turn timeline (all turns, filterable) follows below.
      </p>
    </div>
  );
}

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

export default function RunView({ run, turns, mode, focusFailingTurn = false }) {
  const limits = run.limits || {};
  const tokenBudget = Number(limits.token_budget) || 0;
  const wallClockMax = Number(limits.wall_clock_max_sec) || 0;
  const idleDrainMax = Number(limits.idle_drain_turns) || 0;
  const key = statusKey(run);
  const latestTurn = turns[0] || null;
  const isLive = mode === "live";
  // INV-4: only a FAILED run gets a failing-turn landing target. The
  // derivation is pure (runs-state.js) and returns null for anything else,
  // so the prop is a no-op on healthy runs and absent on legacy callers.
  const runFailed =
    classifyRunOutcome(run.status, run.exit_code ?? null, run.term_reason ?? null) === "failure";
  const failingTurn = focusFailingTurn ? findFailingTurn(turns, runFailed) : null;

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

      {failingTurn && <FailingTurnPanel turn={failingTurn} />}

      <TurnTimeline turns={turns} />

      <LogsSection runId={run.run_id} />
    </>
  );
}
