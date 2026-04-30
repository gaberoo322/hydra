import { useState, useEffect, useCallback } from "react";
import { useToast } from "../hooks/useToast.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

const PROJECTS = [
  { key: "hydra", label: "Hydra" },
  { key: "hydra-betting", label: "Hydra Betting" },
];

function getToken() {
  return sessionStorage.getItem("hydra_env_token") || "";
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

export default function EnvVars() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tokenInput, setTokenInput] = useState("");
  const [authError, setAuthError] = useState("");

  const [project, setProject] = useState("hydra");
  const [vars, setVars] = useState([]);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(new Set());

  // Add/edit form
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editMode, setEditMode] = useState(null); // null | "add" | "edit"
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState(null);

  const toast = useToast();

  async function handleAuth(e) {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/env/hydra`, {
        headers: { Authorization: `Bearer ${tokenInput}` },
      });
      if (res.status === 401) {
        setAuthError("Invalid token");
        return;
      }
      sessionStorage.setItem("hydra_env_token", tokenInput);
      setAuthed(true);
      setAuthError("");
    } catch {
      setAuthError("Connection failed");
    }
  }

  const loadVars = useCallback(async (reveal = false) => {
    setLoading(true);
    try {
      const qs = reveal ? "?reveal=true" : "";
      const res = await fetch(`${API_BASE}/env/${project}${qs}`, {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        sessionStorage.removeItem("hydra_env_token");
        setAuthed(false);
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      setVars(await res.json());
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [project, toast]);

  useEffect(() => {
    if (authed) {
      setRevealed(new Set());
      loadVars(false);
    }
  }, [authed, loadVars]);

  async function revealKey(key) {
    if (revealed.has(key)) {
      setRevealed(prev => { const n = new Set(prev); n.delete(key); return n; });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/env/${project}?reveal=true`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to reveal");
      const all = await res.json();
      const found = all.find(v => v.key === key);
      if (found) {
        setVars(prev => prev.map(v => v.key === key ? { ...v, value: found.value } : v));
        setRevealed(prev => new Set(prev).add(key));
      }
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function startEdit(key, value) {
    setEditMode("edit");
    setEditKey(key);
    // Fetch revealed value for editing
    fetch(`${API_BASE}/env/${project}?reveal=true`, { headers: authHeaders() })
      .then(r => r.json())
      .then(all => {
        const found = all.find(v => v.key === key);
        setEditValue(found ? found.value : value);
      })
      .catch(() => setEditValue(value));
  }

  function startAdd() {
    setEditMode("add");
    setEditKey("");
    setEditValue("");
  }

  function cancelEdit() {
    setEditMode(null);
    setEditKey("");
    setEditValue("");
  }

  async function handleSave() {
    if (!editKey.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/env/${project}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ key: editKey.trim(), value: editValue }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status}`);
      }
      const result = await res.json();
      toast(`${editKey} ${result.action}`);
      cancelEdit();
      loadVars(false);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`${API_BASE}/env/${project}/${deleteTarget}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status}`);
      }
      toast(`${deleteTarget} deleted`);
      setDeleteTarget(null);
      loadVars(false);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // Auth gate
  if (!authed) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <form onSubmit={handleAuth} className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-xl font-bold text-white">Environment Variables</h1>
            <p className="text-sm text-zinc-500 mt-1">Enter your admin token to continue</p>
          </div>
          <input
            type="password"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            placeholder="CRON_SECRET"
            autoFocus
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          {authError && <p className="text-xs text-red-400">{authError}</p>}
          <button
            type="submit"
            className="w-full text-sm px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Environment Variables</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={startAdd}
            disabled={editMode === "add"}
            className="text-xs px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
          >
            + Add Variable
          </button>
          <button
            onClick={() => { sessionStorage.removeItem("hydra_env_token"); setAuthed(false); }}
            className="text-xs px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors"
          >
            Lock
          </button>
        </div>
      </div>

      {/* Project tabs */}
      <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
        {PROJECTS.map(p => (
          <button
            key={p.key}
            onClick={() => setProject(p.key)}
            className={`flex-1 text-sm py-2 rounded transition-colors ${
              project === p.key
                ? "bg-zinc-800 text-white font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Add/Edit form */}
      {editMode && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <p className="text-sm font-medium text-zinc-300">
            {editMode === "add" ? "Add Variable" : `Edit: ${editKey}`}
          </p>
          <div className="flex gap-3">
            <input
              value={editKey}
              onChange={e => setEditKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              placeholder="KEY_NAME"
              disabled={editMode === "edit"}
              className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:text-zinc-500"
            />
            <input
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              placeholder="value"
              className="flex-[2] px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={cancelEdit}
              className="text-xs px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !editKey.trim()}
              className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Variable table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 animate-pulse bg-zinc-800/30" />
        ) : vars.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-600">No variables found</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">Key</th>
                <th className="text-left px-4 py-3 font-medium">Value</th>
                <th className="text-right px-4 py-3 font-medium w-36">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vars.map(v => (
                <tr key={v.key} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-zinc-200">{v.key}</td>
                  <td className="px-4 py-3 font-mono text-zinc-400 max-w-md truncate">
                    {v.value}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => revealKey(v.key)}
                      className="text-xs px-2 py-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {revealed.has(v.key) ? "Hide" : "Reveal"}
                    </button>
                    <button
                      onClick={() => startEdit(v.key, v.value)}
                      className="text-xs px-2 py-1 text-blue-500 hover:text-blue-400 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteTarget(v.key)}
                      className="text-xs px-2 py-1 text-red-500 hover:text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-zinc-600">
        {vars.length} variable{vars.length !== 1 ? "s" : ""} in {PROJECTS.find(p => p.key === project)?.label}.
        Changes require a service restart to take effect.
      </p>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Variable"
        message={`Remove ${deleteTarget} from ${project}? This cannot be undone. You may need to restart services afterward.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
