import { useEffect, useState } from "react";
import { apiFetch } from "../hooks/useApi.js";
import { useToast } from "../hooks/useToast.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const SECTIONS = [
  { key: "agents", label: "Agents" },
  { key: "feedback", label: "Feedback" },
  { key: "direction", label: "Direction" },
  { key: "research", label: "Research" },
];

export default function Config() {
  const [section, setSection] = useState("agents");
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const toast = useToast();

  // Load file list when section changes
  useEffect(() => {
    setSelectedFile(null);
    setContent("");
    setDirty(false);
    apiFetch(`/config/${section}`)
      .then((data) => setFiles(Array.isArray(data) ? data : []))
      .catch(() => setFiles([]));
  }, [section]);

  // Load file content when selection changes
  useEffect(() => {
    if (!selectedFile) return;
    setLoading(true);
    setDirty(false);
    fetch(`${API_BASE}/config/${section}/${selectedFile}`)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((text) => setContent(text))
      .catch((err) => toast(`Failed to load: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  }, [section, selectedFile, toast]);

  async function handleSave() {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await apiFetch(`/config/${section}/${selectedFile}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      toast("Saved");
      setDirty(false);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Configuration</h1>
        {selectedFile && (
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-yellow-400">Unsaved</span>}
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`flex-1 text-sm py-2 rounded transition-colors ${
              section === s.key
                ? "bg-zinc-800 text-white font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Two-column: file list + editor */}
      <div className="flex gap-4 min-h-[calc(100vh-260px)]">
        {/* File list */}
        <div className="w-48 shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg p-2 space-y-0.5">
          {files.map((name) => (
            <button
              key={name}
              onClick={() => setSelectedFile(name)}
              className={`w-full text-left text-sm px-3 py-2 rounded transition-colors ${
                selectedFile === name
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              {name}
            </button>
          ))}
          {files.length === 0 && (
            <p className="text-xs text-zinc-600 px-3 py-4 text-center">No files</p>
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-4 animate-pulse h-full bg-zinc-800/30" />
          ) : selectedFile ? (
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              className="w-full h-full bg-transparent text-sm text-zinc-200 font-mono p-4 resize-none focus:outline-none leading-relaxed"
              spellCheck={false}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-zinc-600">
              Select a file to edit
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
