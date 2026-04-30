import { useApi, apiFetch } from "../hooks/useApi.js";
import { useState } from "react";
import StatusBadge from "../components/StatusBadge.jsx";

export default function Proposals() {
  const { data, refresh } = useApi("/proposals", { poll: 15000 });
  const [filter, setFilter] = useState("all");

  const proposals = data || [];
  const filtered = filter === "all" ? proposals : proposals.filter(p => p.status === filter);

  async function handleApprove(id) {
    await apiFetch(`/proposals/${id}/approve`, { method: "POST" });
    refresh();
  }

  async function handleReject(id) {
    await apiFetch(`/proposals/${id}/reject`, { method: "POST" });
    refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Proposals</h1>
        <div className="flex gap-2">
          {["all", "pending", "approved", "rejected"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded transition-colors ${
                filter === f ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {filtered.map((proposal) => (
          <div key={proposal.proposalId || proposal.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-white">{proposal.title}</h3>
                  <StatusBadge status={proposal.status} />
                  {proposal.risk && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      proposal.risk === "high" ? "bg-red-500/20 text-red-400" :
                      proposal.risk === "medium" ? "bg-yellow-500/20 text-yellow-400" :
                      "bg-zinc-700 text-zinc-400"
                    }`}>
                      {proposal.risk} risk
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 font-mono">{proposal.proposalId}</p>
                {proposal.type && (
                  <p className="text-xs text-zinc-500 mt-1">
                    Type: {proposal.type}
                    {proposal.targetFile && <span className="ml-2 text-zinc-600">→ {proposal.targetFile}</span>}
                  </p>
                )}
                {proposal.impact && (
                  <p className="text-xs text-zinc-400 mt-2">{proposal.impact}</p>
                )}
                {proposal.diff && (
                  <p className="text-xs text-zinc-500 mt-1 italic">{proposal.diff}</p>
                )}
                {proposal.applied && (
                  <p className={`text-xs mt-1 ${proposal.applied === "true" ? "text-emerald-400" : "text-zinc-500"}`}>
                    {proposal.applied === "true" ? "Applied" : "Not applied"}{proposal.applicationNote ? ` — ${proposal.applicationNote}` : ""}
                  </p>
                )}
              </div>
              {proposal.status === "pending" && (
                <div className="flex gap-2 ml-4">
                  <button
                    onClick={() => handleApprove(proposal.proposalId || proposal.id)}
                    className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(proposal.proposalId || proposal.id)}
                    className="text-xs px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-sm text-zinc-600">No {filter === "all" ? "" : filter} proposals</p>
          </div>
        )}
      </div>
    </div>
  );
}
