import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";

export default function AgentStream({ ws }) {
  const [events, setEvents] = useState([]);
  const [activeAgents, setActiveAgents] = useState({});
  const bottomRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Slice 4 (issue #500) — `?agent=<worktreeBranch>` scopes the stream to one
  // subagent. Linked from the autopilot turn-timeline "Watch stream" button.
  // When absent the view shows the full unscoped stream (baseline behaviour).
  const [searchParams] = useSearchParams();
  const agentFilter = searchParams.get("agent");

  useEffect(() => {
    return ws.subscribe("agent:stream", (data) => {
      const evt = data.event || {};
      const agent = data.agent || "unknown";
      const text = evt.item?.text || evt.message || "";

      // Slice 4 filter — when `?agent=` is set, only retain events whose
      // agent label matches the filter (matched against the agent name OR
      // its worktree branch label, since the WS frame's `agent` field can
      // carry either depending on which event source emits it).
      if (agentFilter && agent !== agentFilter && data.worktreeBranch !== agentFilter) {
        return;
      }

      // Track active agents
      setActiveAgents((prev) => {
        const next = { ...prev };
        if (evt.type === "thread.started" || evt.type === "turn.started") {
          next[agent] = { status: "running", startedAt: data.timestamp, taskId: data.taskId };
        } else if (evt.type === "turn.completed" || evt.type === "item.completed") {
          if (next[agent]) next[agent] = { ...next[agent], status: "done" };
        }
        return next;
      });

      // Only show meaningful events
      if (evt.type === "item.completed" && text) {
        setEvents((prev) => [...prev, {
          agent,
          taskId: data.taskId,
          text: text.slice(0, 2000),
          timestamp: data.timestamp,
          type: "output",
        }].slice(-200));
      } else if (evt.type === "turn.completed" && evt.usage) {
        setEvents((prev) => [...prev, {
          agent,
          taskId: data.taskId,
          text: `${evt.usage.input_tokens?.toLocaleString() || 0} in / ${evt.usage.output_tokens?.toLocaleString() || 0} out tokens`,
          timestamp: data.timestamp,
          type: "usage",
        }].slice(-200));
      } else if (evt.type === "error") {
        setEvents((prev) => [...prev, {
          agent,
          taskId: data.taskId,
          text: evt.message || JSON.stringify(evt).slice(0, 500),
          timestamp: data.timestamp,
          type: "error",
        }].slice(-200));
      }
    });
  }, [ws, agentFilter]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, autoScroll]);

  const agentColor = (name) => {
    const colors = {
      "domain-researcher": "text-blue-400",
      "technical-researcher": "text-purple-400",
      "market-researcher": "text-amber-400",
      "research-strategist": "text-emerald-400",
      "director": "text-emerald-400",
      "planner": "text-cyan-400",
      "skeptic": "text-red-400",
      "executor": "text-orange-400",
      "fixer": "text-yellow-400",
      "meta": "text-zinc-400",
    };
    return colors[name] || "text-zinc-400";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold">Agent Activity</h1>
          {agentFilter && (
            <span className="text-xs font-mono px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300">
              filtered: {agentFilter}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded"
            />
            Auto-scroll
          </label>
          <button
            onClick={() => setEvents([])}
            className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Active agents */}
      {Object.keys(activeAgents).length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {Object.entries(activeAgents).map(([name, info]) => (
            <div
              key={name}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border ${
                info.status === "running"
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-zinc-700 bg-zinc-800/50"
              }`}
            >
              {info.status === "running" && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              )}
              <span className={agentColor(name)}>{name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Event stream */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 max-h-[calc(100vh-200px)] overflow-y-auto font-mono text-sm">
        {events.length === 0 && (
          <p className="text-zinc-600 text-center py-8">
            Waiting for agent activity... Start a cycle or research run to see output here.
          </p>
        )}
        {events.map((evt, i) => (
          <div key={i} className={`py-2 ${i > 0 ? "border-t border-zinc-800/50" : ""}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`font-semibold ${agentColor(evt.agent)}`}>{evt.agent}</span>
              {evt.type === "error" && <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">error</span>}
              {evt.type === "usage" && <span className="text-xs px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded">tokens</span>}
              <span className="text-[10px] text-zinc-700 ml-auto">
                {evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : ""}
              </span>
            </div>
            <div className={`text-xs leading-relaxed whitespace-pre-wrap ${
              evt.type === "error" ? "text-red-300" :
              evt.type === "usage" ? "text-zinc-500" :
              "text-zinc-300"
            }`}>
              {evt.text}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
