import { useApi } from "../../../hooks/useApi.js";
import { TabShell } from "./TabShell.jsx";

function SeverityChip({ severity }) {
  const cls =
    severity === "reinforce"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
      : "bg-amber-500/10 text-amber-300 border-amber-500/30";
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}>
      {severity}
    </span>
  );
}

function CandidateRow({ p }) {
  return (
    <li className="py-1.5 flex items-center gap-2">
      <span className="text-xs text-zinc-500 shrink-0 w-28 truncate">{p.skill}</span>
      <span className="flex-1 min-w-0 text-sm text-zinc-100 truncate" title={p.cue}>
        {p.cue}
      </span>
      <SeverityChip severity={p.severity} />
      <span className="text-xs text-amber-300 shrink-0 font-mono">
        {p.hitCount}/{p.hitCount + p.hitsToPromotion}
      </span>
    </li>
  );
}

function SkillGroup({ group }) {
  return (
    <div className="bg-zinc-900/30 rounded border border-zinc-700/50 p-3">
      <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
        {group.skill}
        <span className="ml-2 text-zinc-600">({group.patterns.length})</span>
      </h3>
      <ul className="divide-y divide-zinc-800/60">
        {group.patterns.map((p) => (
          <li key={`${group.skill}-${p.cue}`} className="py-1 flex items-center gap-2">
            <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate" title={p.cue}>
              {p.cue}
            </span>
            <SeverityChip severity={p.severity} />
            {p.promoted && (
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded border bg-violet-500/10 text-violet-300 border-violet-500/30">
                promoted
              </span>
            )}
            <span className="text-xs text-zinc-400 shrink-0 font-mono">{p.hitCount}x</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * FrictionTab — three sub-sections:
 *   1. Hero list: threshold candidates (closest to promotion).
 *   2. Recent meta-friction issues (escalated friction).
 *   3. Full grouped table by skill.
 */
export function FrictionTab() {
  const { data, error, loading } = useApi("/v2/explore/friction", { poll: 60_000 });

  const candidates = data?.thresholdCandidates ?? [];
  const meta = data?.recentMetaFrictionIssues ?? [];
  const groups = data?.bySkill ?? [];
  const empty = !loading && !error && groups.length === 0 && meta.length === 0;

  const subtitle = data
    ? `Hits-to-promotion = ${data.promotionThreshold}. Meta-friction issues from last ${data.windowHours}h.`
    : "Soft friction subagents are working around.";

  return (
    <TabShell title="Friction" subtitle={subtitle} loading={loading} error={error} empty={empty} emptyMessage="No friction patterns recorded yet.">
      {candidates.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
            Near promotion ({candidates.length})
          </h3>
          <ul className="divide-y divide-zinc-700/50">
            {candidates.map((p) => (
              <CandidateRow key={`${p.skill}-${p.cue}`} p={p} />
            ))}
          </ul>
        </div>
      )}

      {meta.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
            Recent meta-friction issues ({meta.length})
          </h3>
          <ul className="divide-y divide-zinc-700/50">
            {meta.map((m) => (
              <li key={`meta-${m.number}`} className="py-1.5 flex items-center gap-3">
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 min-w-0 text-sm text-zinc-100 hover:text-amber-300 truncate"
                >
                  <span className="text-zinc-500 mr-1">#{m.number}</span>
                  {m.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
            By skill ({groups.length})
          </h3>
          <div className="space-y-3">
            {groups.map((g) => (
              <SkillGroup key={g.skill} group={g} />
            ))}
          </div>
        </div>
      )}
    </TabShell>
  );
}
