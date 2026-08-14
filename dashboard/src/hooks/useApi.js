import { useState, useEffect, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

export function useApi(path, { poll = 0, skip = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!skip);

  const refresh = useCallback(async () => {
    if (skip) return;
    try {
      setLoading(true);
      const result = await apiFetch(path);
      setData(result);
      setError(null);
    } catch (err) {
      // Trust contract (ADR-0034 §5.1, issue #4006): a failed refresh sets the
      // error but deliberately does NOT clear `data` — the last good payload is
      // retained so usePageItems can surface it as STALE context rather than
      // blanking the panel. Do not add a `setData(null)` here: that would turn
      // a transient refresh failure into a confident-looking empty state, the
      // exact failure mode the trust contract exists to prevent.
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [path, skip]);

  useEffect(() => {
    refresh();
    if (poll > 0 && !skip) {
      const interval = setInterval(refresh, poll);
      return () => clearInterval(interval);
    }
  }, [refresh, poll, skip]);

  return { data, error, loading, refresh };
}
