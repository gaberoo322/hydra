import { DispatchKindSplit } from "./DispatchKindSplit.jsx";
import { WoWTrendCell } from "./WoWTrendCell.jsx";
import { CROSS_TAB_FAMILIES } from "./cross-tab-families.js";

/**
 * Expandable per-skill × per-model token cross-tab (issue #693), with a
 * week-over-week per-skill trend column (issue #2404).
 *
 * Reads `bySkillByModel` + `bySkillWoW` from `/api/usage` and renders one row
 * per dispatching skill, one column per model family, a per-skill row total,
 * and the WoW trend of that total vs the immediately-prior stored Weekly Usage
 * Snapshot. Sessions with no dispatch-registry entry appear under the
 * `interactive`/`unattributed` row. Raw token counts only — no quota-weight, no
 * spend figures — matching the tracker's read-only posture. Auto-EXPANDED when
 * populated (issue #2404) so the per-skill trend is visible at a glance rather
 * than hidden behind a collapsed disclosure.
 */
export function SkillModelCrossTab({ bySkillByModel, bySkillWoW, byDispatchKind, attributedPercent }) {
  if (!bySkillByModel) return null;
  const skills = Object.keys(bySkillByModel).sort();
  if (skills.length === 0) return null;

  const rowTotal = (row) =>
    CROSS_TAB_FAMILIES.reduce((acc, f) => acc + (row[f]?.total ?? 0), 0);

  // Sort skills by descending total so the heaviest consumer is on top.
  skills.sort((a, b) => rowTotal(bySkillByModel[b]) - rowTotal(bySkillByModel[a]));

  const wow = bySkillWoW ?? {};

  return (
    <details className="mt-3 group" open>
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-400 hover:text-zinc-200 select-none">
        Per-skill breakdown ({skills.length})
      </summary>
      <DispatchKindSplit
        byDispatchKind={byDispatchKind}
        attributedPercent={attributedPercent}
      />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm text-right tabular-nums">
          <thead>
            <tr className="text-zinc-500 border-b border-zinc-700">
              <th className="text-left font-medium py-1 pr-3">Skill</th>
              {CROSS_TAB_FAMILIES.map((f) => (
                <th key={f} className="font-medium py-1 px-3">
                  {f}
                </th>
              ))}
              <th className="font-medium py-1 px-3">total</th>
              <th className="font-medium py-1 pl-3">wow</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => {
              const row = bySkillByModel[skill];
              return (
                <tr key={skill} className="border-b border-zinc-800/60">
                  <td className="text-left text-zinc-300 py-1 pr-3 font-mono">{skill}</td>
                  {CROSS_TAB_FAMILIES.map((f) => (
                    <td key={f} className="text-zinc-400 py-1 px-3">
                      {(row[f]?.total ?? 0).toLocaleString()}
                    </td>
                  ))}
                  <td className="text-zinc-200 py-1 px-3 font-semibold">
                    {rowTotal(row).toLocaleString()}
                  </td>
                  <td className="py-1 pl-3 font-medium">
                    <WoWTrendCell entry={wow[skill]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
