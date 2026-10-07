/**
 * turn-snapshot/hydra-http.ts — `TurnSnapshotHttp`, the injected adapter the
 * Turn Snapshot collectors read the orchestrator's own HTTP API through
 * (ADR-0043 Decision 1: "plus the hydra HTTP client").
 *
 * Semantics are `hydra raw GET <path>` captured by `$(… 2>/dev/null || true)`,
 * which is what the strangled bash read (bin/hydra `_get`): GET
 * `${HYDRA_BASE_URL:-http://localhost:4000}/api<path>`; a non-2xx status, an
 * HTML body, or a transport failure is an EMPTY read; trailing newlines are
 * stripped. The data plane being down must never crash a turn (Decision 2),
 * so `get` never throws.
 */

export interface TurnSnapshotHttp {
  /** The response body of `GET /api<path>`, or `""` when the read failed. */
  get(path: string): Promise<string>;
}

const DEFAULT_BASE_URL = "http://localhost:4000";
const HTTP_TIMEOUT_MS = 30_000;
const HTML_PREFIXES = ["<!DOCTYPE", "<!doctype", "<html", "<HTML"];

export interface TurnSnapshotHttpOptions {
  /** Defaults to `HYDRA_BASE_URL`, else `http://localhost:4000` (bin/hydra's default). */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The production adapter over `fetch`. */
export function createTurnSnapshotHttp(opts: TurnSnapshotHttpOptions = {}): TurnSnapshotHttp {
  const baseUrl = opts.baseUrl ?? (process.env.HYDRA_BASE_URL || DEFAULT_BASE_URL);
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async get(path) {
      try {
        const res = await doFetch(`${baseUrl}/api${path}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        const body = await res.text();
        if (!res.ok) return "";
        if (HTML_PREFIXES.some((p) => body.startsWith(p))) return "";
        return body.replace(/\n+$/, "");
      } catch (err) {
        /* intentional: an unreachable data plane is an empty read (the bash `2>/dev/null || true`); the collector notes the degraded board read */
        void err;
        return "";
      }
    },
  };
}
