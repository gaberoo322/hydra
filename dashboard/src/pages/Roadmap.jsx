import { useState, useEffect, useMemo } from "react";
import { useToast } from "../hooks/useToast.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const STATUS_CONFIG = {
  complete: { label: "Complete", dot: "bg-emerald-400", border: "border-emerald-400/30", text: "text-emerald-400", bg: "bg-emerald-400/10", bar: "bg-emerald-400" },
  active:   { label: "Active",   dot: "bg-blue-400",    border: "border-blue-400/30",    text: "text-blue-400",    bg: "bg-blue-400/10",    bar: "bg-blue-400" },
  planned:  { label: "Planned",  dot: "bg-zinc-500",    border: "border-zinc-700",        text: "text-zinc-400",    bg: "bg-zinc-800",       bar: "bg-zinc-600" },
  blocked:  { label: "Blocked",  dot: "bg-amber-400",   border: "border-amber-400/30",   text: "text-amber-400",   bg: "bg-amber-400/10",   bar: "bg-amber-400" },
};

function parseMilestones(markdown) {
  if (!markdown) return [];
  const sections = markdown.split(/^## /m).filter(Boolean);
  return sections.map((section) => {
    const lines = section.split("\n");
    const title = lines[0].trim();
    let status = "planned";
    let started = null;
    let completed = null;
    let description = "";
    const epics = [];
    let pastMeta = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const statusMatch = line.match(/^status:\s*(\w+)/);
      const startedMatch = line.match(/^started:\s*(.+)/);
      const completedMatch = line.match(/^completed:\s*(.+)/);
      const epicDone = line.match(/^- \[x\]\s+(.+)/);
      const epicTodo = line.match(/^- \[ \]\s+(.+)/);
      const epicBlocked = line.match(/^- \[-\]\s+(.+)/);

      if (statusMatch) { status = statusMatch[1]; continue; }
      if (startedMatch) { started = startedMatch[1].trim(); continue; }
      if (completedMatch) { completed = completedMatch[1].trim(); continue; }
      if (epicDone) { epics.push({ text: epicDone[1], status: "done" }); pastMeta = true; continue; }
      if (epicTodo) { epics.push({ text: epicTodo[1], status: "todo" }); pastMeta = true; continue; }
      if (epicBlocked) { epics.push({ text: epicBlocked[1], status: "blocked" }); pastMeta = true; continue; }
      if (!pastMeta && line.trim() && !line.startsWith("#")) {
        description += (description ? " " : "") + line.trim();
      }
    }

    const doneCount = epics.filter((e) => e.status === "done").length;
    return { title, status, started, completed, description, epics, doneCount };
  });
}

function MilestoneCard({ milestone, isLast }) {
  const [expanded, setExpanded] = useState(milestone.status === "active");
  const config = STATUS_CONFIG[milestone.status] || STATUS_CONFIG.planned;
  const total = milestone.epics.length;
  const pct = total > 0 ? Math.round((milestone.doneCount / total) * 100) : 0;

  return (
    <div className="flex gap-4">
      {/* Timeline spine */}
      <div className="flex flex-col items-center pt-1">
        <div className={`w-3 h-3 rounded-full ${config.dot} ring-4 ring-zinc-950 shrink-0 z-10`} />
        {!isLast && <div className="w-px flex-1 bg-zinc-800 -mt-px" />}
      </div>

      {/* Card */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex-1 mb-6 rounded-lg border ${config.border} ${config.bg} p-4 text-left transition-colors hover:border-zinc-600 cursor-pointer`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-100 leading-tight">{milestone.title}</h3>
            {milestone.description && (
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{milestone.description}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className={`text-[10px] font-medium uppercase tracking-wider ${config.text}`}>
              {config.label}
            </span>
            {milestone.started && (
              <span className="text-[10px] text-zinc-500">
                {milestone.started}{milestone.completed ? ` \u2192 ${milestone.completed}` : " \u2192 now"}
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full ${config.bar} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">
              {milestone.doneCount}/{total}
            </span>
          </div>
        )}

        {/* Expanded epics */}
        {expanded && milestone.epics.length > 0 && (
          <div className="mt-3 pt-3 border-t border-zinc-800/50 space-y-1.5">
            {milestone.epics.map((epic, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {epic.status === "done" && (
                  <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {epic.status === "todo" && (
                  <svg className="w-3.5 h-3.5 text-zinc-600 shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                )}
                {epic.status === "blocked" && (
                  <svg className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M12 3l9.66 16.59a1 1 0 01-.87 1.41H3.21a1 1 0 01-.87-1.41L12 3z" />
                  </svg>
                )}
                <span className={epic.status === "done" ? "text-zinc-300" : epic.status === "blocked" ? "text-amber-300/80" : "text-zinc-500"}>
                  {epic.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </button>
    </div>
  );
}

function StatsBar({ milestones }) {
  const complete = milestones.filter((m) => m.status === "complete").length;
  const active = milestones.filter((m) => m.status === "active").length;
  const planned = milestones.filter((m) => m.status === "planned").length;
  const totalEpics = milestones.reduce((s, m) => s + m.epics.length, 0);
  const doneEpics = milestones.reduce((s, m) => s + m.doneCount, 0);

  return (
    <div className="flex gap-6 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        <span className="text-zinc-400">{complete} complete</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-blue-400" />
        <span className="text-zinc-400">{active} active</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-zinc-500" />
        <span className="text-zinc-400">{planned} planned</span>
      </div>
      <div className="text-zinc-600">|</div>
      <div className="text-zinc-400 tabular-nums">{doneEpics}/{totalEpics} epics shipped</div>
    </div>
  );
}

export default function Roadmap() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const toast = useToast();

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/config/direction/roadmap`);
        if (res.ok) {
          setContent(await res.text());
        } else {
          setContent("# Roadmap\n\n## M1: First Milestone\nstatus: planned\n\n- [ ] First epic\n");
        }
      } catch (err) {
        toast(`Failed to load: ${err.message}`, "error");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [toast]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/config/direction/roadmap`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast("Saved");
      setDirty(false);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  const milestones = useMemo(() => parseMilestones(content), [content]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Roadmap</h1>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 animate-pulse h-96" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Roadmap</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Project milestones and delivery timeline. Parsed from <code className="text-zinc-400">config/direction/roadmap.md</code>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs text-yellow-400">Unsaved</span>}
          {editMode && (
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          )}
          <button
            onClick={() => setEditMode(!editMode)}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
          >
            {editMode ? "Timeline" : "Edit"}
          </button>
        </div>
      </div>

      {editMode ? (
        /* Raw markdown editor (same as Vision.jsx) */
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
            className="w-full h-[calc(100vh-220px)] bg-transparent text-sm text-zinc-200 font-mono p-4 resize-none focus:outline-none leading-relaxed"
            spellCheck={false}
            placeholder="# Roadmap&#10;&#10;## M1: First Milestone&#10;status: planned&#10;&#10;- [ ] First epic"
          />
        </div>
      ) : (
        /* Visual timeline */
        <div className="space-y-6">
          <StatsBar milestones={milestones} />
          <div>
            {milestones.map((m, i) => (
              <MilestoneCard key={i} milestone={m} isLast={i === milestones.length - 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
