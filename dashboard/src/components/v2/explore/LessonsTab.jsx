import { useState, useMemo } from "react";
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

export function LessonsTab() {
  const [skillFilter, setSkillFilter] = useState("");
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (skillFilter) params.set("skill", skillFilter);
    const q = params.toString();
    return q ? `/v2/explore/lessons?${q}` : "/v2/explore/lessons";
  }, [skillFilter]);

  const { data, error, loading } = useApi(path, { poll: 60_000 });
  const lessons = data?.lessons ?? [];
  const empty = !loading && !error && lessons.length === 0;

  const subtitle = data
    ? `Promoted lessons across every skill. Sorted by firing frequency. Promotion threshold = ${data.promotionThreshold} hits.`
    : "Promoted lessons across every skill.";

  const actions = (
    <input
      type="text"
      value={skillFilter}
      onChange={(e) => setSkillFilter(e.target.value.trim())}
      placeholder="filter by skill"
      className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 w-44"
      aria-label="Filter lessons by skill"
    />
  );

  return (
    <TabShell
      title="Lessons"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage={skillFilter ? "No promoted lessons match that skill." : "No promoted lessons yet."}
      actions={actions}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
            <th className="py-2 pr-4 font-normal">Skill</th>
            <th className="py-2 pr-4 font-normal">Cue</th>
            <th className="py-2 pr-4 font-normal text-right">Hits</th>
            <th className="py-2 pr-4 font-normal text-right">Since promotion</th>
            <th className="py-2 pr-4 font-normal">Promoted</th>
            <th className="py-2 pr-4 font-normal">Severity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-700/50">
          {lessons.map((l) => (
            <tr
              key={`${l.skill}-${l.cue}`}
              className={l.demoted ? "opacity-60" : ""}
            >
              <td className="py-1.5 pr-4 font-mono text-zinc-300">{l.skill}</td>
              <td className="py-1.5 pr-4 text-zinc-100">{l.cue}</td>
              <td className="py-1.5 pr-4 text-right font-mono text-zinc-200">{l.hitCount}</td>
              <td className="py-1.5 pr-4 text-right font-mono text-zinc-300">
                {l.postPromotionHits ?? "—"}
              </td>
              <td className="py-1.5 pr-4 text-xs text-zinc-500">{l.promotedAt || "—"}</td>
              <td className="py-1.5 pr-4">
                <SeverityChip severity={l.severity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TabShell>
  );
}
