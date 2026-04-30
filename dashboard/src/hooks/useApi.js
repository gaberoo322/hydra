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
