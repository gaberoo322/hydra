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

/**
 * useServerConfirmedWrite — the write-side twin of useApi, concentrating
 * ADR-0034 §7's server-confirmed-action rule (issue #4335, design-concept
 * d4003bea): POST the write, re-GET, and flip displayed state only once the
 * read confirms it — never optimistic, failures always surfaced.
 *
 * The hook owns exactly `pending` and `error`, never a displayed value —
 * pages keep deriving those from the read hook's `data`, which is what makes
 * the action confirmed rather than optimistic. `write` resolves a result
 * object (`{ ok: true, res }` / `{ ok: false, error }`) so callers decide
 * how to report failures; a rejected POST surfaces its message in `error`
 * and leaves the displayed state exactly where it was.
 */
export function useServerConfirmedWrite(refresh) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const write = useCallback(
    async (path, body) => {
      setPending(true);
      setError(null);
      try {
        const res = await apiFetch(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        // SERVER-CONFIRMED: the follow-up read must land before this call
        // resolves ok — the page flips displayed state from that read,
        // never from the write's own success.
        await refresh();
        return { ok: true, res };
      } catch (err) {
        /* intentional: surfaced, not silent — the rejection reaches the page
           twice (the error state the rows render + the { ok: false, error }
           result), matching the read hook's contract; no console spam. */
        const message = err?.message || String(err);
        setError(message);
        return { ok: false, error: message };
      } finally {
        setPending(false);
      }
    },
    // `refresh` is useApi's stable useCallback ([path, skip]) — depending on
    // it directly, not the per-render hook object, keeps `write` stable too.
    [refresh],
  );

  return { pending, error, write };
}
