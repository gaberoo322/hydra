import { useApi, apiFetch } from "../hooks/useApi.js";
import { useEffect } from "react";

const SEVERITY_STYLES = {
  error: "border-red-500/50 bg-red-500/5",
  warning: "border-yellow-500/50 bg-yellow-500/5",
  info: "border-blue-500/50 bg-blue-500/5",
};

const SEVERITY_DOT = {
  error: "bg-red-400",
  warning: "bg-yellow-400",
  info: "bg-blue-400",
};

export default function Alerts({ ws }) {
  const { data, refresh } = useApi("/alerts?limit=50", { poll: 10000 });

  useEffect(() => {
    if (!ws) return;
    return ws.subscribe("*", (event) => {
      // Refresh on any notification event
      if (event.stream === "hydra:notifications") refresh();
    });
  }, [ws, refresh]);

  const alerts = (data || []).filter(a => !a.dismissed);
  const dismissed = (data || []).filter(a => a.dismissed);

  async function handleDismiss(id) {
    await apiFetch(`/alerts/${id}/dismiss`, { method: "POST" });
    refresh();
  }

  async function handleDismissAll() {
    await apiFetch("/alerts/dismiss-all", { method: "POST" });
    refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Alerts</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {alerts.length} active{dismissed.length > 0 ? `, ${dismissed.length} dismissed` : ""}
          </p>
        </div>
        {alerts.length > 0 && (
          <button
            onClick={handleDismissAll}
            className="text-xs px-3 py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
          >
            Dismiss all
          </button>
        )}
      </div>

      {alerts.length === 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
          <p className="text-zinc-600">No active alerts — system is healthy</p>
        </div>
      )}

      <div className="space-y-2">
        {alerts.map((alert) => (
          <div
            key={alert.id}
            className={`border rounded-lg p-4 flex items-start justify-between ${SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.info}`}
          >
            <div className="flex items-start gap-3">
              <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${SEVERITY_DOT[alert.severity] || SEVERITY_DOT.info}`} />
              <div>
                <p className="text-sm text-zinc-200">{alert.message}</p>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-[10px] text-zinc-500 font-mono">{alert.type}</span>
                  <span className="text-[10px] text-zinc-600">
                    {alert.timestamp ? timeAgo(alert.timestamp) : ""}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={() => handleDismiss(alert.id)}
              className="text-xs text-zinc-600 hover:text-zinc-300 px-2 py-1 shrink-0"
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function timeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Export alert count hook for the sidebar badge
export function useAlertCount() {
  const { data } = useApi("/alerts?limit=50", { poll: 10000 });
  return (data || []).filter(a => !a.dismissed).length;
}
