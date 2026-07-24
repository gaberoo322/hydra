import { useState, useMemo } from "react";
import LocalTimestamp from "./LocalTimestamp.jsx";
import { formatTokens } from "../lib/autopilot-format.js";

// Slice 2 of epic #496 (issue #498) — the filterable turn-by-turn timeline.
// Extracted from dashboard/src/pages/Autopilot.jsx (issue #3589) into its own
// focused module together with the TurnRow + ActionRow rows it owns. Behavior
// is identical to the inline originals.

function ActionRow({ action }) {
  const type = action?.type || "(unknown)";
  if (type === "dispatch") {
    const slot = action.slot || action.class || "—";
    const skill = action.skill || "—";
    const anchor = action.prompt_args?.anchor || action.anchor || "—";
    const reason = action.reason || "";
    const outcome = action.outcome;
    // Slice 4 (#500) stamped `worktreeBranch` on dispatch actions for the
    // "Watch stream" cross-link to the legacy AgentStream page. That page
    // was retired in slice 6 of the v2 swap (issue #621); the branch is
    // still surfaced as plain text below so operators can correlate by
    // grep. The `/api/agents/stream` resolver itself is retained pending a
    // follow-up that re-homes the correlation feature.
    const branch =
      action.worktreeBranch || action.worktree_branch || action.branch ||
      outcome?.worktreeBranch || outcome?.worktree_branch || null;
    return (
      <div className="border-l-2 border-emerald-600/50 pl-3 py-1.5 text-xs space-y-1">
        <div className="text-emerald-300 font-mono">
          dispatch:{slot} <span className="text-zinc-400">→ {skill}</span>
        </div>
        <div className="text-zinc-400 truncate" title={anchor}>anchor: <span className="font-mono">{anchor}</span></div>
        {reason && <div className="text-zinc-500 italic">{reason}</div>}
        {outcome ? (
          <div className="text-[11px] text-zinc-400 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>status: <span className={outcome.status === "merged" ? "text-emerald-400" : outcome.status === "failed" ? "text-red-400" : "text-zinc-300"}>{outcome.status}</span></span>
            {outcome.prNumber && (
              <span>
                PR{" "}
                <a href={`https://github.com/gaberoo322/hydra/pull/${outcome.prNumber}`} className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">
                  #{outcome.prNumber}
                </a>
              </span>
            )}
            {outcome.filesChanged && <span>files: {outcome.filesChanged}</span>}
          </div>
        ) : (
          <div className="text-[11px] text-zinc-600 italic">outcome: pending</div>
        )}
        {branch && (
          <div className="text-[11px] text-zinc-500 font-mono">
            branch: {branch}
          </div>
        )}
      </div>
    );
  }
  // Non-dispatch action — raw payload row.
  return (
    <div className="border-l-2 border-zinc-700 pl-3 py-1.5 text-xs space-y-0.5">
      <div className="text-zinc-300 font-mono">{type}</div>
      {action.reason && <div className="text-zinc-500 italic">{action.reason}</div>}
      <pre className="text-[10px] text-zinc-500 font-mono whitespace-pre-wrap break-all">
        {(() => {
          const { type: _t, reason: _r, outcome: _o, ...rest } = action;
          const compact = JSON.stringify(rest);
          return compact === "{}" ? null : compact;
        })()}
      </pre>
    </div>
  );
}

function TurnRow({ turn, expandedDefault }) {
  const [expanded, setExpanded] = useState(expandedDefault);
  const actions = Array.isArray(turn.actions) ? turn.actions : [];
  const typeSummary = actions.map((a) => a.type).slice(0, 5).join(", ");
  const tokensFmt = formatTokens(turn.tokens_after || 0);
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/30">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-mono text-zinc-200">Turn {turn.turn_n}</span>
          <LocalTimestamp ts={turn.epoch} className="text-xs text-zinc-500 font-mono" />
          <span className="text-xs text-zinc-400 truncate">
            {actions.length} {actions.length === 1 ? "action" : "actions"}
            {typeSummary ? `: ${typeSummary}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-zinc-500 font-mono">tokens {tokensFmt}</span>
          <span className="text-zinc-500 text-xs">{expanded ? "▾" : "▸"}</span>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {actions.length === 0 ? (
            <div className="text-xs text-zinc-600 italic px-3 py-2">(no actions)</div>
          ) : (
            actions.map((a, i) => <ActionRow key={i} action={a} />)
          )}
          {Array.isArray(turn.reasons) && turn.reasons.length > 0 && (
            <div className="text-[11px] text-zinc-500 italic px-3 pt-1 border-t border-zinc-800/60">
              {turn.reasons.join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TurnTimeline({ turns }) {
  const [filter, setFilter] = useState("all");
  const allTypes = useMemo(() => {
    const types = new Set();
    for (const t of turns) {
      if (Array.isArray(t.actions)) {
        for (const a of t.actions) {
          if (a?.type) types.add(a.type);
        }
      }
    }
    return Array.from(types).sort();
  }, [turns]);

  const filteredTurns = useMemo(() => {
    if (filter === "all") return turns;
    return turns.filter((t) =>
      Array.isArray(t.actions) && t.actions.some((a) => a?.type === filter),
    );
  }, [turns, filter]);

  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Turn timeline</h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          showing {filteredTurns.length} of {turns.length}
        </span>
      </div>
      {allTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`text-[11px] px-2 py-0.5 rounded-full border ${filter === "all" ? "border-emerald-500/50 bg-emerald-900/20 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-600"}`}
          >
            all
          </button>
          {allTypes.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilter(t)}
              className={`text-[11px] px-2 py-0.5 rounded-full border font-mono ${filter === t ? "border-emerald-500/50 bg-emerald-900/20 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-600"}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {filteredTurns.length === 0 ? (
          <div className="text-sm text-zinc-500 italic">No turns recorded yet for this run.</div>
        ) : (
          filteredTurns.map((turn, idx) => (
            // Most-recent 10 expanded by default; older collapsed.
            <TurnRow key={turn.turn_n} turn={turn} expandedDefault={idx < 10} />
          ))
        )}
      </div>
    </div>
  );
}
