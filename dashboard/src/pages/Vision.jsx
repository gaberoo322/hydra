import { useState, useEffect } from "react";
import { useToast } from "../hooks/useToast.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export default function Vision() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const toast = useToast();

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/config/direction/vision`);
        if (res.ok) {
          setContent(await res.text());
        } else {
          setContent("# Vision\n\nDescribe what you want to build.\n\n# Focus\n\n- \n\n# Constraints\n\n- \n\n# Never\n\n- \n");
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
      const res = await fetch(`${API_BASE}/config/direction/vision`, {
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

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Vision</h1>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 animate-pulse h-96" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Vision</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Your high-level direction. The Director agent uses this + codebase analysis + web research to set priorities.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs text-yellow-400">Unsaved</span>}
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded-lg transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          className="w-full h-[calc(100vh-220px)] bg-transparent text-sm text-zinc-200 font-mono p-4 resize-none focus:outline-none leading-relaxed"
          spellCheck={false}
          placeholder="# Vision&#10;&#10;Describe what you want to build..."
        />
      </div>
    </div>
  );
}
