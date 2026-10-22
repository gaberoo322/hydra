import { formatElapsed } from "../lib/autopilot-format.js";
import { useTaxonomy } from "../hooks/useTaxonomy.js";

// Slice 2 of epic #496 (issue #498) — pipeline snapshot (the taxonomy's
// pipeline slots + signal last-fired ages). Extracted from
// dashboard/src/pages/Autopilot.jsx (issue #3589) into its own focused module
// together with the PipelineSlot + SignalChip atoms it owns.
//
// Issue #4637: this is a HISTORICAL run view (/runs/:runId). It no longer
// derives a live cooldown on the client (that was a re-derived value the view
// could not decompose honestly — live cooldown is /work's class-state panel's
// job), and it renders an UNKNOWN placeholder rather than a fabricated grid
// until useTaxonomy reports the live alphabet `ready`.

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

// Renders only the OBSERVED last-fired age from the turn's signals_snapshot
// ("never" when 0/absent) — no cooldown derivation (issue #4637).
function SignalChip({ cls, epoch, nowEpoch }) {
  const e = Number(epoch || 0);
  const fired = e > 0;
  const ageStr = fired ? formatElapsed(Math.max(0, nowEpoch - e)) : "never";
  const baseStyle = fired
    ? "border-emerald-500/30 bg-emerald-900/10 text-emerald-300"
    : "border-zinc-700 bg-zinc-900/30 text-zinc-400";
  return (
    <div className={`border ${baseStyle} rounded-md px-2 py-1.5 text-xs flex items-center gap-2`}>
      <span className="font-mono">{cls}</span>
      <span className="text-[10px] text-zinc-500">·</span>
      <span className="text-[11px]">{ageStr}</span>
    </div>
  );
}

export default function PipelineSnapshot({ run, latestTurn }) {
  // Prefer the snapshot from the latest turn row; fall back to the empty case.
  const slots = latestTurn?.slots_snapshot || {};
  const signals = latestTurn?.signals_snapshot || {};
  const nowEpoch = Math.floor(Date.now() / 1000);
  // Live dispatch-class alphabet (issue #2524). No fallback alphabet
  // (issue #4637): until the hook reports `ready`, render the panel shell with
  // an UNKNOWN placeholder — never a fabricated grid or "slots filled: 0/N".
  const { taxonomy, status } = useTaxonomy();
  if (status !== "ready" || !taxonomy) {
    return (
      <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/40 space-y-4" data-testid="pipeline-snapshot-unknown">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-zinc-100">Pipeline snapshot</h2>
        </div>
        <div className="text-sm text-zinc-400">
          {status === "loading"
            ? "UNKNOWN — loading the dispatch-class alphabet…"
            : "UNKNOWN — the dispatch-class alphabet (GET /api/taxonomy/classes) is unavailable, so the slot grid cannot be laid out."}
        </div>
      </div>
    );
  }
  const { pipelineSlots, signalClasses } = taxonomy;
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
            <SignalChip key={cls} cls={cls} epoch={signals[cls]} nowEpoch={nowEpoch} />
          ))}
        </div>
      </div>
    </div>
  );
}
