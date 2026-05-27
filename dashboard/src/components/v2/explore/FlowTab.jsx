import { useState } from "react";
import { useApi } from "../../../hooks/useApi.js";
import { TabShell } from "./TabShell.jsx";

const WINDOWS = ["1d", "3d", "7d", "14d", "30d"];

export function FlowTab() {
  const [window, setWindow] = useState("7d");
  const { data, error, loading } = useApi(`/v2/explore/flow?window=${window}`, {
    poll: 60_000,
  });
  const rows = data?.byClass ?? [];
  const totals = data?.totals ?? { added: 0, closed: 0, blocked: 0 };
  const empty = !loading && !error && rows.length === 0;

  const subtitle = `Per-class issue flow over last ${data?.windowDays ?? 7}d. Blocked is a snapshot.`;

  const actions = (
    <select
      value={window}
      onChange={(e) => setWindow(e.target.value)}
      className="text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200"
      aria-label="Flow window"
    >
      {WINDOWS.map((w) => (
        <option key={w} value={w}>
          last {w}
        </option>
      ))}
    </select>
  );

  return (
    <TabShell
      title="Flow"
      subtitle={subtitle}
      loading={loading}
      error={error}
      empty={empty}
      emptyMessage="No backlog flow recorded in this window."
      actions={actions}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
            <th className="py-2 pr-4 font-normal">Class</th>
            <th className="py-2 pr-4 font-normal text-right">Added</th>
            <th className="py-2 pr-4 font-normal text-right">Closed</th>
            <th className="py-2 pr-4 font-normal text-right">Blocked (now)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-700/50">
          {rows.map((r) => (
            <tr key={r.class}>
              <td className="py-1.5 pr-4 font-mono text-zinc-200">{r.class}</td>
              <td className="py-1.5 pr-4 text-right text-emerald-300 font-mono">{r.added}</td>
              <td className="py-1.5 pr-4 text-right text-sky-300 font-mono">{r.closed}</td>
              <td className="py-1.5 pr-4 text-right text-amber-300 font-mono">{r.blocked}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-zinc-700 text-zinc-300">
            <td className="py-2 pr-4 font-semibold text-xs uppercase tracking-wide">Total</td>
            <td className="py-2 pr-4 text-right font-mono">{totals.added}</td>
            <td className="py-2 pr-4 text-right font-mono">{totals.closed}</td>
            <td className="py-2 pr-4 text-right font-mono">{totals.blocked}</td>
          </tr>
        </tfoot>
      </table>
    </TabShell>
  );
}
