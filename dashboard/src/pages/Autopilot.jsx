import { useState, useMemo, useEffect, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";

// Slice 1 of epic #496 — "Is it alive?" header strip.
// Slice 2 of epic #496 (issue #498) — pipeline snapshot + turn timeline.
// Slice 3 of epic #496 (issue #499) — "Why did that crash?" log tail + journal.
// Slice 4 of epic #496 (issue #500) — previous runs + token budget +
// cross-links (the USD cost breakdown was retired in #1651).
// Dashboard v2 atomic swap (issue #621) removed the LIVE list
// route at `/autopilot`; the live view now lives on the Now page. Only the
// per-run DETAIL route at `/autopilot/:runId` remains — one-shot fetch of
// /api/autopilot/runs/:runId, frozen (non-polling) mode.

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const STATUS_STYLES = {
  running: { label: "RUNNING", bg: "bg-emerald-500/15", border: "border-emerald-500/40", text: "text-emerald-300", dot: "bg-emerald-400" },
  wedge:   { label: "RUNNING — WEDGE LIKELY", bg: "bg-amber-500/15", border: "border-amber-500/40", text: "text-amber-300", dot: "bg-amber-400" },
  ended:   { label: "ENDED",   bg: "bg-zinc-500/15", border: "border-zinc-500/40", text: "text-zinc-300", dot: "bg-zinc-400" },
  killed:  { label: "KILLED",  bg: "bg-red-500/15",   border: "border-red-500/40",   text: "text-red-300",   dot: "bg-red-400" },
};

// The dispatch-class alphabet drives the pipeline-snapshot grid layout. It is
// owned by the Dispatch-Class Taxonomy (scripts/autopilot/classes.json) and
// served by GET /api/taxonomy/classes (issue #2524). The constants below are
// now only the BUILT-IN FALLBACK used until the fetch lands (or if the endpoint
// is unreachable) — `useTaxonomy()` substitutes the live alphabet at runtime so
// adding/retiring a class no longer requires editing this file.
const FALLBACK_PIPELINE_SLOTS = ["dev_orch", "qa_orch", "research_orch", "dev_target", "qa_target", "research_target"];
const FALLBACK_SIGNAL_CLASSES = ["health", "sweep_orch", "sweep_target", "discover_orch", "discover_target"];
const FALLBACK_SIGNAL_COOLDOWN_SEC = {
  health: 0,
  sweep_orch: 900,
  sweep_target: 900,
  discover_orch: 1800,
  discover_target: 1800,
};

/**
 * Fetch the live dispatch-class alphabet from GET /api/taxonomy/classes,
 * falling back to the built-in constants until the fetch resolves or if the
 * endpoint is unreachable / degraded. Never throws — a failed or degraded
 * response keeps the built-in defaults so the page renders regardless (the
 * load-bearing tolerate-unreachable-endpoint invariant from issue #2524).
 */
function useTaxonomy() {
  const [taxonomy, setTaxonomy] = useState({
    pipelineSlots: FALLBACK_PIPELINE_SLOTS,
    signalClasses: FALLBACK_SIGNAL_CLASSES,
    signalCooldowns: FALLBACK_SIGNAL_COOLDOWN_SEC,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/taxonomy/classes`);
        if (!res.ok) return; // keep fallback
        const body = await res.json();
        if (cancelled || !body || body.degraded) return; // keep fallback
        const pipelineSlots = Array.isArray(body.pipelineSlots) && body.pipelineSlots.length > 0
          ? body.pipelineSlots : FALLBACK_PIPELINE_SLOTS;
        const signalClasses = Array.isArray(body.signalClasses) && body.signalClasses.length > 0
          ? body.signalClasses : FALLBACK_SIGNAL_CLASSES;
        const signalCooldowns = body.signalCooldowns && typeof body.signalCooldowns === "object"
          ? body.signalCooldowns : FALLBACK_SIGNAL_COOLDOWN_SEC;
        setTaxonomy({ pipelineSlots, signalClasses, signalCooldowns });
      } catch {
        // Unreachable endpoint — keep the built-in fallback alphabet.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return taxonomy;
}

function statusKey(run) {
  if (!run) return "ended";
  if (run.status === "running" && run.wedge_likely) return "wedge";
  if (run.status === "running") return "running";
  if (run.status === "killed") return "killed";
  return "ended";
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatClockTime(epoch) {
  if (!Number.isFinite(epoch) || epoch <= 0) return "—";
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString();
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function StatusPill({ run }) {
  const key = statusKey(run);
  const style = STATUS_STYLES[key];
  let label = style.label;
  if (key === "ended" && run?.term_reason) label = `ENDED: ${run.term_reason}`;
  if (key === "killed" && run?.term_reason) label = `KILLED: ${run.term_reason}`;
  const tooltip = key === "wedge"
    ? `Heartbeat age: ${formatElapsed(run.age_s)} (threshold 10m)`
    : undefined;
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border ${style.bg} ${style.border} ${style.text} text-sm font-semibold`}
      title={tooltip}
    >
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      {label}
    </div>
  );
}

function MetaCell({ label, value, mono = false }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`text-sm text-zinc-200 ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

function BudgetBar({ label, current, max, formatValue }) {
  const safeMax = Number(max) || 0;
  const safeCurrent = Number(current) || 0;
  const pct = safeMax > 0 ? Math.min(100, (safeCurrent / safeMax) * 100) : 0;
  const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500";
  const fmt = formatValue || ((n) => String(n));
  return (
    <div>
      <div className="flex justify-between items-baseline text-xs text-zinc-400 mb-1">
        <span>{label}</span>
        <span className="font-mono text-zinc-300">
          {fmt(safeCurrent)} / {fmt(safeMax)}
        </span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function truncId(id) {
  if (!id) return "—";
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Slice 2 — Pipeline snapshot (6 slots + 5 signal cooldowns)
// ---------------------------------------------------------------------------

function PipelineSlot({ name, occupant, nowEpoch }) {
  const isEmpty = !occupant;
  if (isEmpty) {
    return (
      <div className="border border-dashed border-zinc-700 rounded-md p-3 bg-zinc-900/30">
        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">{name}</div>
        <div className="text-xs text-zinc-600 italic">empty</div>
      </div>
    );
  }
  // occupant shape from state.slots — best-effort field extraction; the slot
  // value is opaque to the dashboard (decide.py stamps {skill, branch,
  // claimed_epoch, anchor, ...} but the precise field names aren't pinned).
  const subagent = occupant.skill || occupant.subagent || occupant.type || "(claimed)";
  const branch = occupant.branch || occupant.worktreeBranch || occupant.worktree_branch || null;
  const claimedEpoch = Number(occupant.claimed_epoch || occupant.claimedAt || 0);
  const ageS = claimedEpoch > 0 && nowEpoch > 0 ? Math.max(0, nowEpoch - claimedEpoch) : null;
  const prNumber = occupant.pr_number || occupant.prNumber || null;
  return (
    <div className="border border-emerald-700/40 rounded-md p-3 bg-emerald-900/10">
      <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-1">{name}</div>
      <div className="text-sm font-semibold text-zinc-100 truncate" title={subagent}>{subagent}</div>
      {branch && (
        <div className="text-xs font-mono text-zinc-400 truncate" title={branch}>{branch}</div>
      )}
      <div className="text-[11px] text-zinc-500 mt-1">
        {ageS !== null ? `age ${formatElapsed(ageS)}` : "—"}
        {prNumber ? <> · <a href={`https://github.com/gaberoo322/hydra/pull/${prNumber}`} className="text-emerald-400 hover:underline" target="_blank" rel="noreferrer">PR #{prNumber}</a></> : null}
      </div>
    </div>
  );
}

function SignalChip({ cls, epoch, nowEpoch, cooldownSec }) {
  const e = Number(epoch || 0);
  const cooldown = Number(cooldownSec) || 0;
  const onCooldown = e > 0 && cooldown > 0 && nowEpoch - e < cooldown;
  // For health (cooldown=0) "active" only means fired within 60s.
  const recentlyFired = e > 0 && (cooldown === 0 ? nowEpoch - e <= 60 : true);
  const ageStr = e > 0 ? formatElapsed(Math.max(0, nowEpoch - e)) : "never";
  const baseStyle = onCooldown
    ? "border-amber-500/40 bg-amber-900/15 text-amber-300"
    : recentlyFired
      ? "border-emerald-500/30 bg-emerald-900/10 text-emerald-300"
      : "border-zinc-700 bg-zinc-900/30 text-zinc-400";
  return (
    <div className={`border ${baseStyle} rounded-md px-2 py-1.5 text-xs flex items-center gap-2`}>
      <span className="font-mono">{cls}</span>
      <span className="text-[10px] text-zinc-500">·</span>
      <span className="text-[11px]">{ageStr}</span>
      {onCooldown && <span className="text-[10px] uppercase tracking-widest">cooldown</span>}
    </div>
  );
}

function PipelineSnapshot({ run, latestTurn }) {
  // Prefer the snapshot from the latest turn row; fall back to the empty case.
  const slots = latestTurn?.slots_snapshot || {};
  const signals = latestTurn?.signals_snapshot || {};
  const nowEpoch = Math.floor(Date.now() / 1000);
  // Live dispatch-class alphabet (issue #2524), with a built-in fallback so the
  // snapshot renders even before the fetch lands or if the endpoint is down.
  const { pipelineSlots, signalClasses, signalCooldowns } = useTaxonomy();
  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Pipeline snapshot</h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          slots filled: {pipelineSlots.filter((s) => slots[s]).length}/{pipelineSlots.length}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {pipelineSlots.map((name) => (
          <PipelineSlot key={name} name={name} occupant={slots[name]} nowEpoch={nowEpoch} />
        ))}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Signals</div>
        <div className="flex flex-wrap gap-2">
          {signalClasses.map((cls) => (
            <SignalChip key={cls} cls={cls} epoch={signals[cls]} nowEpoch={nowEpoch} cooldownSec={signalCooldowns[cls]} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slice 2 — Turn timeline
// ---------------------------------------------------------------------------

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
          <span className="text-xs text-zinc-500 font-mono">{formatClockTime(turn.epoch)}</span>
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

function TurnTimeline({ turns }) {
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

// ---------------------------------------------------------------------------
// Slice 3 — Log tail + systemd journal panel
//
// Two read-only surfaces over the autopilot's runtime logs:
//   - /api/autopilot/runs/:runId/log?tail=N  — tail of the nightly run log
//     (live for the current run, .prev for the immediately prior one).
//   - /api/autopilot/runs/:runId/journal     — systemd journal slice for the
//     run window. One-shot, not polled.
//
// Both return plain text. Panel is collapsed by default to avoid the noisy
// log dump in the operator's face during normal "is it alive?" checks; the
// journal section is a separate one-shot fetch behind its own button so we
// don't spam journalctl on every poll.
// ---------------------------------------------------------------------------

function LogTailPanel({ runId }) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(null);
  const preRef = useRef(null);

  useEffect(() => {
    if (!expanded || !runId) return undefined;
    let cancelled = false;
    const fetchOnce = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/autopilot/runs/${encodeURIComponent(runId)}/log?tail=50`);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (!cancelled) {
            setError(`${res.status}: ${body || res.statusText}`);
            setText("");
          }
          return;
        }
        const body = await res.text();
        if (cancelled) return;
        setSource(res.headers.get("x-autopilot-log-source"));
        setText(body);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [expanded, runId]);

  // Auto-scroll to bottom when text grows.
  useEffect(() => {
    if (expanded && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [expanded, text]);

  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/30">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-mono text-zinc-200">Log tail</span>
          <span className="text-xs text-zinc-500">
            {expanded ? `polling every 5s${source ? ` · source: ${source}` : ""}` : "Show last 50 log lines"}
          </span>
        </div>
        <span className="text-zinc-500 text-xs">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="text-xs text-red-400 font-mono px-1">{error}</div>
          )}
          <pre
            ref={preRef}
            className="text-[11px] font-mono text-zinc-300 bg-zinc-950/60 border border-zinc-800 rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap break-words"
          >
            {text || (loading ? "loading…" : "(no log content)")}
          </pre>
        </div>
      )}
    </div>
  );
}

function JournalPanel({ runId }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const fetchJournal = async () => {
    setLoading(true);
    setError(null);
    setTruncated(false);
    setTimedOut(false);
    try {
      const res = await fetch(`${API_BASE}/autopilot/runs/${encodeURIComponent(runId)}/journal`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setError(`${res.status}: ${body || res.statusText}`);
        setText(null);
        return;
      }
      setTruncated(res.headers.get("x-autopilot-journal-truncated") === "true");
      setTimedOut(res.headers.get("x-autopilot-journal-timed-out") === "true");
      const body = await res.text();
      setText(body);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/30">
      <div className="px-3 py-2 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm font-mono text-zinc-200">systemd journal</span>
          <span className="text-xs text-zinc-500">point-in-time snapshot for this run's window</span>
        </div>
        <button
          type="button"
          onClick={fetchJournal}
          disabled={loading || !runId}
          className="text-[11px] px-2 py-1 rounded border border-zinc-700 hover:border-zinc-500 text-zinc-300 disabled:opacity-50"
        >
          {loading ? "loading…" : text !== null ? "Refresh" : "Open systemd journal"}
        </button>
      </div>
      {(text !== null || error) && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="text-xs text-red-400 font-mono px-1">{error}</div>
          )}
          {(truncated || timedOut) && (
            <div className="text-[11px] text-amber-400 px-1">
              {truncated && "output truncated at 1MB"}
              {truncated && timedOut ? " · " : ""}
              {timedOut && "journalctl exceeded 10s timeout"}
            </div>
          )}
          {text !== null && (
            <pre className="text-[11px] font-mono text-zinc-300 bg-zinc-950/60 border border-zinc-800 rounded p-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">
              {text || "(no journal output for window)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function LogsSection({ runId }) {
  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Why did that crash?</h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">log tail + journal</span>
      </div>
      <JournalPanel runId={runId} />
      <LogTailPanel runId={runId} />
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
// Slice 4 — History table
//
// Last 14 runs from /api/autopilot/runs, polled every 60s. Row click
// navigates to /autopilot/:runId for the detail page. "see cycles" link
// scopes the /metrics view to cycles whose autopilotTurnId starts with
// "<runId>:".
// ---------------------------------------------------------------------------

function StatusPillSmall({ row }) {
  const key = row.status === "running" ? "running" : row.status === "killed" ? "killed" : "ended";
  const style = STATUS_STYLES[key];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${style.bg} ${style.border} ${style.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {(row.status || "ended").toUpperCase()}
    </span>
  );
}

function relativeTime(epoch) {
  if (!Number.isFinite(epoch) || epoch <= 0) return "—";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function HistoryTable() {
  const { data, error, loading } = useApi("/autopilot/runs", { poll: 60000 });
  const runs = Array.isArray(data?.runs) ? data.runs : [];

  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Previous runs</h2>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          last {runs.length} · polls every 60s
        </span>
      </div>
      {loading && !data && (
        <div className="text-sm text-zinc-500">Loading…</div>
      )}
      {error && (
        <div className="text-xs text-red-400 font-mono">{error}</div>
      )}
      {!loading && !error && runs.length === 0 && (
        <div className="text-sm text-zinc-500 italic">
          No previous runs recorded. The first row appears at the next bootstrap.
        </div>
      )}
      {runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 text-[10px] uppercase tracking-widest border-b border-zinc-800">
                <th className="text-left py-2 pr-3 font-semibold">Started</th>
                <th className="text-left py-2 pr-3 font-semibold">Duration</th>
                <th className="text-left py-2 pr-3 font-semibold">Status</th>
                <th className="text-left py-2 pr-3 font-semibold">Term</th>
                <th className="text-left py-2 pr-3 font-semibold">Trigger</th>
                <th className="text-right py-2 pr-3 font-semibold">Turns</th>
                <th className="text-right py-2 pr-3 font-semibold">Disp (M/F)</th>
                <th className="text-right py-2 pr-3 font-semibold">Tokens</th>
                <th className="text-right py-2 pr-1 font-semibold">Cycles</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.run_id}
                  className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors"
                >
                  <td className="py-2 pr-3">
                    <Link
                      to={`/autopilot/${encodeURIComponent(r.run_id)}`}
                      className="text-zinc-300 hover:text-emerald-300"
                      title={r.started}
                    >
                      {relativeTime(r.started_epoch)}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 font-mono text-zinc-400">
                    {r.duration_s !== null && r.duration_s !== undefined ? formatElapsed(r.duration_s) : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusPillSmall row={r} />
                  </td>
                  <td className="py-2 pr-3 text-zinc-400">{r.term_reason || "—"}</td>
                  <td className="py-2 pr-3 text-zinc-400">{r.trigger || "—"}</td>
                  <td className="py-2 pr-3 text-right font-mono text-zinc-300">{r.turns}</td>
                  <td className="py-2 pr-3 text-right font-mono text-zinc-300">
                    {r.dispatches}{" "}
                    <span className="text-[10px] text-zinc-500">
                      ({r.merged_count}/{r.failed_count})
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-zinc-300">
                    {formatTokens(r.total_tokens)}
                  </td>
                  <td className="py-2 pr-1 text-right">
                    <Link
                      to={`/metrics?run=${encodeURIComponent(r.run_id)}`}
                      className="text-[10px] text-blue-400 hover:underline"
                    >
                      see cycles
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

function RunView({ run, turns, mode }) {
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

// ---------------------------------------------------------------------------
// LIVE page mounted at `/autopilot`.
// ---------------------------------------------------------------------------

function AutopilotLive() {
  const { data, error, loading } = useApi("/autopilot/runs/current", { poll: 5000 });

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Autopilot</h1>
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  // 404 (no run yet) bubbles up as `error`. Friendly empty state — but we
  // STILL render the history table below in case prior runs exist with
  // expired live-row TTLs.
  const isNoRun = error && /404|no autopilot runs/i.test(error);

  if (error || !data) {
    return (
      <div className="p-6 space-y-5">
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <h1 className="text-2xl font-bold text-white">Autopilot</h1>
          </div>
          <p className="text-sm text-zinc-500">Header · pipeline · timeline · logs · history.</p>
        </div>
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          {isNoRun ? (
            <>
              <h2 className="text-base font-semibold text-zinc-200 mb-1">No autopilot run recorded yet</h2>
              <p className="text-sm text-zinc-500">
                The first row appears when bootstrap.sh runs at the start of the next
                <code className="mx-1 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-xs">hydra-autopilot</code>
                invocation.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load run</h2>
              <p className="text-sm text-zinc-500 font-mono">{error}</p>
            </>
          )}
        </div>
        <HistoryTable />
      </div>
    );
  }

  const run = data;
  const turns = Array.isArray(run.turns) ? run.turns : [];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-2xl font-bold text-white">Autopilot</h1>
          <span className="text-xs text-zinc-500 font-mono">polls every 5s</span>
        </div>
        <p className="text-sm text-zinc-500">Header · pipeline · timeline · logs · history.</p>
      </div>
      <RunView run={run} turns={turns} mode="live" />
      <HistoryTable />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DETAIL page mounted at `/autopilot/:runId`. One-shot fetch (no polling) —
// the run is terminal by definition. If you land here while a run is still
// going, the data is just a snapshot.
// ---------------------------------------------------------------------------

function AutopilotDetail({ runId }) {
  const { data, error, loading } = useApi(`/autopilot/runs/${encodeURIComponent(runId)}`);

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Autopilot run</h1>
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    const is404 = error && /404|unknown run_id/i.test(error);
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-2">Autopilot run</h1>
        <p className="text-sm text-zinc-500 mb-6">
          <Link to="/now" className="text-blue-400 hover:underline">← Back to Now</Link>
        </p>
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          {is404 ? (
            <>
              <h2 className="text-base font-semibold text-zinc-200 mb-1">Run not found</h2>
              <p className="text-sm text-zinc-500">
                Run <code className="font-mono">{runId}</code> is not in Redis. Records expire after 7 days.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load run</h2>
              <p className="text-sm text-zinc-500 font-mono">{error}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const run = data.run;
  const turns = Array.isArray(data.turns) ? data.turns : [];

  return (
    <div className="p-6 space-y-5">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-2xl font-bold text-white">Autopilot run</h1>
          <Link to="/now" className="text-xs text-blue-400 hover:underline">← Back to Now</Link>
        </div>
        <p className="text-sm text-zinc-500">
          Detail view
        </p>
      </div>
      <RunView run={run} turns={turns} mode="detail" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export is the per-run detail page. The legacy `/autopilot` live
// list route was retired in slice 6 (issue #621); AutopilotLive is kept in
// this file (rather than deleted) because its sub-components (RunView,
// LogsSection, JournalPanel, history table) are still consumed by the
// detail view. If a runId is somehow missing we fall back to AutopilotLive
// for diagnostics, but this path is no longer mounted in App.jsx.
// ---------------------------------------------------------------------------

export default function Autopilot() {
  const params = useParams();
  const runId = params?.runId;
  return runId ? <AutopilotDetail runId={runId} /> : <AutopilotLive />;
}
