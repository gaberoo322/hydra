/**
 * turn-snapshot/hydra-http.ts — `TurnSnapshotHydraHttp`, the injected hydra
 * HTTP client the Turn Snapshot collectors read the data plane through
 * (ADR-0043 Decision 1; slice 5, #4933).
 *
 * Same semantics as the `hydra raw GET <path>` the strangled bash called
 * (bin/hydra's `_get`): `GET <base>/api<path>`, where the base is
 * `HYDRA_BASE_URL` (default `http://localhost:4000`); a non-2xx status, a body
 * that opens like an HTML page (`<!DOCTYPE`, `<!doctype`, `<html`, `<HTML` —
 * an Express 404 or a proxy page), or a transport error is a FAILED read.
 * A successful read hands back the body text verbatim. The collectors map a
 * failed read to an explicit degraded field — never a silent default.
 *
 * Tests inject a fake {@link HttpTransport}; no network, no service.
 */

/** One hydra HTTP read: the body on success, or why it failed. */
export type HydraHttpRead = { readonly kind: "ok"; readonly body: string } | { readonly kind: "failed"; readonly reason: string };

/** The data-plane reads the passthrough collectors need. */
export interface TurnSnapshotHydraHttp {
  /** `GET /api<path>` with `hydra raw GET` failure semantics. */
  get(path: string): Promise<HydraHttpRead>;
}

/** The raw HTTP GET under the client: resolves with status + body, rejects on a transport error. */
export type HttpTransport = (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

export const DEFAULT_HYDRA_BASE_URL = "http://localhost:4000";

/**
 * Per-request timeout. `hydra raw` (curl without `--max-time`) had none; a
 * hung data plane then wedged the whole turn. 60s keeps every healthy read
 * (the slowest, `/usage`, is well under a second) and turns a hang into the
 * collector's degraded fallback instead.
 */
export const HYDRA_HTTP_TIMEOUT_MS = 60_000;

const HTML_PREFIXES = ["<!DOCTYPE", "<!doctype", "<html", "<HTML"];

/** The default transport: global `fetch` with an abort timeout. */
export const fetchTransport: HttpTransport = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
};

export interface TurnSnapshotHydraHttpOptions {
  /** `HYDRA_BASE_URL`; empty/undefined → {@link DEFAULT_HYDRA_BASE_URL} (bash `${VAR:-default}`). */
  baseUrl?: string;
  transport?: HttpTransport;
  timeoutMs?: number;
}

export function createTurnSnapshotHydraHttp(opts: TurnSnapshotHydraHttpOptions = {}): TurnSnapshotHydraHttp {
  const base = opts.baseUrl ? opts.baseUrl : DEFAULT_HYDRA_BASE_URL;
  const transport = opts.transport ?? fetchTransport;
  const timeoutMs = opts.timeoutMs ?? HYDRA_HTTP_TIMEOUT_MS;
  return {
    async get(path) {
      let res: { status: number; body: string };
      try {
        res = await transport(`${base}/api${path}`, timeoutMs);
      } catch (err) {
        /* intentional: a transport error IS the failed read — the collector renders it as its degraded fallback */
        return { kind: "failed", reason: `transport: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (res.status < 200 || res.status > 299) return { kind: "failed", reason: `http-${res.status}` };
      if (HTML_PREFIXES.some((p) => res.body.startsWith(p))) return { kind: "failed", reason: "html-body" };
      return { kind: "ok", body: res.body };
    },
  };
}
