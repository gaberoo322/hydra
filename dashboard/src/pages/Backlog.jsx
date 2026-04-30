import { useApi, apiFetch } from "../hooks/useApi.js";
import { useState, useEffect, useCallback } from "react";
import { useToast } from "../hooks/useToast.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const LANE_COLORS = {
  triage: "border-amber-500/50",
  backlog: "border-zinc-700",
  queued: "border-blue-500/50",
  blocked: "border-yellow-500/50",
  inProgress: "border-purple-500/50",
  done: "border-emerald-500/50",
};

const LANE_LABELS = {
  triage: "Triage",
  backlog: "Backlog",
  queued: "Queued",
  blocked: "Blocked",
  inProgress: "In Progress",
  done: "Done",
};

const LANE_KEYS = Object.keys(LANE_LABELS);

const PRIORITY_LABELS = { 0: "None", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
const PRIORITY_COLORS = {
  1: "bg-red-400",
  2: "bg-orange-400",
  3: "bg-yellow-400",
  4: "bg-blue-400",
};
const PRIORITY_TEXT_COLORS = {
  1: "text-red-400",
  2: "text-orange-400",
  3: "text-yellow-400",
  4: "text-blue-400",
  0: "text-zinc-500",
};
const ESTIMATE_LABELS = { 1: "XS", 2: "S", 3: "M", 5: "L", 8: "XL" };

const LABEL_COLORS = [
  "bg-blue-500/20 text-blue-300",
  "bg-purple-500/20 text-purple-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-amber-500/20 text-amber-300",
  "bg-pink-500/20 text-pink-300",
  "bg-cyan-500/20 text-cyan-300",
];

function labelColor(label) {
  let hash = 0;
  for (const ch of label) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length];
}

export default function Backlog() {
  const { data, loading, refresh } = useApi("/backlog", { poll: 10000 });
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const toast = useToast();
  const lanes = data || {};

  // Find the selected item across all lanes
  const selectedItem = selectedItemId
    ? LANE_KEYS.reduce((found, lane) => found || (lanes[lane] || []).find(i => i.id === selectedItemId), null)
    : null;
  const selectedLane = selectedItem
    ? LANE_KEYS.find(lane => (lanes[lane] || []).some(i => i.id === selectedItemId))
    : null;

  async function handleAddItem(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const result = await apiFetch("/backlog/enhance", {
        method: "POST",
        body: JSON.stringify({ text: title.trim() }),
      });
      setTitle("");
      if (result.enhanced) {
        toast(`Added: ${result.enhanced.title}`);
      } else {
        toast("Item added");
      }
      refresh();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMove(id, lane) {
    try {
      await apiFetch(`/backlog/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ lane }),
      });
      if (id === selectedItemId) setSelectedItemId(null);
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleApprove(id) {
    try {
      await apiFetch(`/backlog/${id}/approve`, { method: "POST" });
      toast("Approved → Backlog");
      if (id === selectedItemId) setSelectedItemId(null);
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleSaveEdit(id, updates) {
    try {
      await apiFetch(`/backlog/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
      toast("Updated");
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await apiFetch(`/backlog/${deleteTarget}`, { method: "DELETE" });
      toast("Item deleted");
      if (deleteTarget === selectedItemId) setSelectedItemId(null);
      refresh();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setDeleteTarget(null);
    }
  }

  if (loading && !data) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Backlog</h1>

      {/* Add item form */}
      <form onSubmit={handleAddItem} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Describe what you want done..."
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors shrink-0"
          >
            {submitting ? "Enhancing..." : "Add"}
          </button>
        </div>
        {submitting && (
          <p className="mt-2 text-xs text-zinc-500 animate-pulse">Agent is structuring your item with title, description, priority, labels, and acceptance criteria...</p>
        )}
      </form>

      {/* Kanban board */}
      <div className="grid grid-cols-1 lg:grid-cols-6 gap-4">
        {LANE_KEYS.map((key) => {
          const items = lanes[key] || [];
          return (
            <div key={key} className={`bg-zinc-900 border-t-2 ${LANE_COLORS[key]} rounded-lg p-3`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-400">{LANE_LABELS[key]}</h3>
                <span className="text-xs text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map((item, i) => (
                  <BacklogCard
                    key={item.id || i}
                    item={item}
                    currentLane={key}
                    onMove={handleMove}
                    onApprove={handleApprove}
                    onDelete={() => setDeleteTarget(item.id)}
                    onSelect={() => setSelectedItemId(selectedItemId === item.id ? null : item.id)}
                    isSelected={selectedItemId === item.id}
                  />
                ))}
                {items.length === 0 && (
                  <p className="text-xs text-zinc-700 py-4 text-center">Empty</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail sidebar */}
      {selectedItem && (
        <ItemSidebar
          item={selectedItem}
          lane={selectedLane}
          onClose={() => setSelectedItemId(null)}
          onSave={handleSaveEdit}
          onMove={handleMove}
          onApprove={handleApprove}
          onDelete={(id) => { setSelectedItemId(null); setDeleteTarget(id); }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget != null}
        title="Delete Item"
        message="Remove this item from the backlog? This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function BacklogCard({ item, currentLane, onMove, onApprove, onDelete, onSelect, isSelected }) {
  const [showActions, setShowActions] = useState(false);
  const title = typeof item === "string" ? item : item.title || item;
  const priorityVal = item.priority || 0;
  const estimateVal = item.estimate;

  return (
    <div
      className={`bg-zinc-800/60 rounded p-2.5 text-xs group relative cursor-pointer transition-colors ${isSelected ? "ring-1 ring-emerald-500/50 bg-zinc-800" : "hover:bg-zinc-800/80"}`}
      onClick={onSelect}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Priority + Title row */}
      <div className="flex items-start gap-1.5">
        {priorityVal > 0 && (
          <span
            className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[priorityVal] || ""} shrink-0 mt-1`}
            title={PRIORITY_LABELS[priorityVal]}
          />
        )}
        <p className="text-zinc-200 font-medium leading-snug flex-1">{title}</p>
        {estimateVal && ESTIMATE_LABELS[estimateVal] && (
          <span className="bg-zinc-700/50 text-zinc-400 px-1 py-0.5 rounded text-[10px] shrink-0">
            {ESTIMATE_LABELS[estimateVal]}
          </span>
        )}
      </div>

      {/* Labels */}
      {item.labels?.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {item.labels.map((l, i) => (
            <span key={i} className={`px-1.5 py-0.5 rounded text-[10px] ${labelColor(l)}`}>
              {l}
            </span>
          ))}
        </div>
      )}

      {/* Tags (legacy) */}
      {item.tags?.length > 0 && !item.labels?.length && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {item.tags.map((tag, i) => (
            <span key={i} className="bg-zinc-700/50 text-zinc-400 px-1.5 py-0.5 rounded text-[10px]">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Hover actions */}
      {showActions && item.id && (
        <div className="absolute top-1 right-1 flex gap-1 animate-fade-in" onClick={(e) => e.stopPropagation()}>
          {currentLane === "triage" ? (
            <>
              <button onClick={() => onApprove(item.id)} title="Approve → Backlog" className="bg-emerald-900/50 hover:bg-emerald-800/50 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] transition-colors">Approve</button>
              <button onClick={() => onDelete()} title="Reject" className="bg-red-900/50 hover:bg-red-800/50 text-red-400 px-1.5 py-0.5 rounded text-[10px] transition-colors">Reject</button>
            </>
          ) : (
            <button onClick={() => onDelete()} title="Delete" className="bg-red-900/50 hover:bg-red-800/50 text-red-400 px-1.5 py-0.5 rounded text-[10px] transition-colors">Del</button>
          )}
        </div>
      )}
    </div>
  );
}

function ItemSidebar({ item, lane, onClose, onSave, onMove, onApprove, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [priority, setPriority] = useState(item.priority ?? 0);
  const [description, setDescription] = useState(item.description || "");
  const [estimate, setEstimate] = useState(item.estimate ?? "");
  const [labelInput, setLabelInput] = useState("");
  const [labels, setLabels] = useState(item.labels || []);
  const [saving, setSaving] = useState(false);

  // Sync when item changes
  useEffect(() => {
    setPriority(item.priority ?? 0);
    setDescription(item.description || "");
    setEstimate(item.estimate ?? "");
    setLabels(item.labels || []);
    setEditing(false);
  }, [item.id]);

  // Escape to close
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  function handleLabelKeyDown(e) {
    if (e.key === "Enter" && labelInput.trim()) {
      e.preventDefault();
      if (!labels.includes(labelInput.trim())) setLabels([...labels, labelInput.trim()]);
      setLabelInput("");
    }
  }

  async function handleSave() {
    setSaving(true);
    await onSave(item.id, {
      priority: Number(priority) || 0,
      description: description.trim(),
      estimate: estimate ? Number(estimate) : null,
      labels,
    });
    setSaving(false);
    setEditing(false);
  }

  const meta = item.meta || {};
  const priorityVal = item.priority || 0;
  const otherLanes = LANE_KEYS.filter(l => l !== lane && l !== "triage");

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 z-50 w-[460px] h-full bg-zinc-900 border-l border-zinc-800 shadow-2xl overflow-y-auto animate-slide-in">
        {/* Header */}
        <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {priorityVal > 0 && (
              <span className={`w-2.5 h-2.5 rounded-full ${PRIORITY_COLORS[priorityVal]} shrink-0`} />
            )}
            <span className={`text-[10px] px-2 py-0.5 rounded border ${LANE_COLORS[lane]} bg-zinc-800`}>
              {LANE_LABELS[lane]}
            </span>
            {item.id && (
              <span className="text-[10px] text-zinc-600 font-mono">{item.id}</span>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none">&times;</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Title */}
          <h2 className="text-lg font-semibold text-white leading-snug">{item.title}</h2>

          {/* Properties */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Priority</p>
              {editing ? (
                <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-zinc-500">
                  {Object.entries(PRIORITY_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              ) : (
                <p className={`text-sm font-medium ${PRIORITY_TEXT_COLORS[priorityVal] || "text-zinc-500"}`}>{PRIORITY_LABELS[priorityVal]}</p>
              )}
            </div>
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Estimate</p>
              {editing ? (
                <select value={estimate} onChange={(e) => setEstimate(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-zinc-500">
                  <option value="">None</option>
                  {Object.entries(ESTIMATE_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-zinc-300">{(item.estimate && ESTIMATE_LABELS[item.estimate]) || "—"}</p>
              )}
            </div>
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Source</p>
              <p className="text-sm text-zinc-300">{meta.source || "—"}</p>
            </div>
          </div>

          {/* Labels */}
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Labels</p>
            {editing ? (
              <div>
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={handleLabelKeyDown}
                  placeholder="Type + Enter to add"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                />
                {labels.length > 0 && (
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {labels.map((l) => (
                      <button key={l} onClick={() => setLabels(labels.filter(x => x !== l))} className={`px-2 py-0.5 rounded text-xs ${labelColor(l)} hover:opacity-70`}>
                        {l} &times;
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex gap-1.5 flex-wrap">
                {(item.labels || []).length > 0
                  ? item.labels.map((l, i) => <span key={i} className={`px-2 py-0.5 rounded text-xs ${labelColor(l)}`}>{l}</span>)
                  : <span className="text-xs text-zinc-600">None</span>}
              </div>
            )}
          </div>

          {/* Description */}
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Description</p>
            {editing ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none font-mono leading-relaxed"
              />
            ) : (
              <div className="bg-zinc-800/50 rounded-lg px-4 py-3 text-sm text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap min-h-[80px]">
                {item.description || <span className="text-zinc-600 italic">No description</span>}
              </div>
            )}
          </div>

          {/* Meta details */}
          {(meta.score || meta.confidence || meta.complexity || meta.addedAt) && (
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Details</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {meta.score != null && (
                  <div className="flex justify-between bg-zinc-800/50 rounded px-3 py-1.5">
                    <span className="text-zinc-500">Score</span>
                    <span className="text-zinc-300">{meta.score}</span>
                  </div>
                )}
                {meta.confidence && (
                  <div className="flex justify-between bg-zinc-800/50 rounded px-3 py-1.5">
                    <span className="text-zinc-500">Confidence</span>
                    <span className="text-zinc-300">{meta.confidence}</span>
                  </div>
                )}
                {meta.complexity && (
                  <div className="flex justify-between bg-zinc-800/50 rounded px-3 py-1.5">
                    <span className="text-zinc-500">Complexity</span>
                    <span className="text-zinc-300">{meta.complexity}</span>
                  </div>
                )}
                {meta.addedAt && (
                  <div className="flex justify-between bg-zinc-800/50 rounded px-3 py-1.5">
                    <span className="text-zinc-500">Added</span>
                    <span className="text-zinc-300">{meta.addedAt}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Edit / Save toggle */}
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white rounded transition-colors"
                >
                  {saving ? "Saving..." : "Save Changes"}
                </button>
                <button onClick={() => { setEditing(false); setPriority(item.priority ?? 0); setDescription(item.description || ""); setEstimate(item.estimate ?? ""); setLabels(item.labels || []); }} className="text-xs px-3 py-2 text-zinc-400 hover:text-zinc-200 transition-colors">
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)} className="text-xs px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors border border-zinc-700">
                Edit
              </button>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-zinc-800" />

          {/* Actions */}
          <div className="space-y-2">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Actions</p>

            {lane === "triage" && (
              <div className="flex gap-2">
                <button
                  onClick={() => onApprove(item.id)}
                  className="flex-1 text-xs px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors"
                >
                  Approve → Backlog
                </button>
                <button
                  onClick={() => onDelete(item.id)}
                  className="text-xs px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 rounded transition-colors"
                >
                  Reject
                </button>
              </div>
            )}

            {lane !== "triage" && (
              <div className="flex gap-2 flex-wrap">
                {otherLanes.map((target) => (
                  <button
                    key={target}
                    onClick={() => onMove(item.id, target)}
                    className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors border border-zinc-700"
                  >
                    → {LANE_LABELS[target]}
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={() => onDelete(item.id)}
              className="text-xs px-3 py-1.5 text-red-400 hover:text-red-300 transition-colors"
            >
              Delete item
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Backlog</h1>
      <div className="grid grid-cols-1 lg:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 h-48 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
