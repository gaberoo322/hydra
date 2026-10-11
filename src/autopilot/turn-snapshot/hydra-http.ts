/**
 * turn-snapshot/hydra-http.ts — `TurnSnapshotHydra`, the ONE injected hydra
 * HTTP client the Turn Snapshot collectors read the data plane through
 * (ADR-0043 Decision 1: the gh port "plus the hydra HTTP client"). Unified
 * across slices 2 (#4930), 3 (#4931), 4 (#4932) and 5 (#4933) — one
 * transport, one failure model, one exported name set.
 *
 * Wire semantics are the `hydra raw GET <path>` the strangled bash called
 * (bin/hydra's `_get`, a curl without `-L`): `GET <base>/api<path>`, where the
 * base is `HYDRA_BASE_URL` (default `http://localhost:4000`); redirects are
 * NOT followed. A non-2xx status, a body that opens like an HTML page
 * (`<!DOCTYPE`, `<!doctype`, `<html`, `<HTML` — an Express 404 or a proxy
 * page), or a transport error / timeout is a FAILED read. A successful
 * {@link TurnSnapshotHydra.get} hands back the body VERBATIM — exactly what
 * `_get` printed (minus the newline its `printf '%s\n'` appends): an empty 2xx
 * body is an `ok` read of `""` (`_get` exits 0 printing nothing), and
 * trailing newlines are kept, because the slice-5 passthroughs printed the
 * body as-is (`hydra raw GET … || echo default`) and their goldens pin both
 * cases. Collectors that captured the read with `$(...)` and treated an empty
 * capture as a failure apply that themselves: the board-state methods below
 * strip trailing newlines and fail an empty body (`empty-body`), and the
 * slot-events collector strips its own capture. The autopilot keeps deciding
 * while the data plane is down (Decision 2), so nothing here throws: a down
 * service is a `failed` read the collector renders as its explicit degraded
 * field.
 *
 * Shape: a generic {@link TurnSnapshotHydra.get} (slice 5's passthrough
 * reads) PLUS one typed method per read with its own projection —
 * {@link TurnSnapshotHydra.orchBoardState} (slice 2),
 * {@link TurnSnapshotHydra.targetBoardState} (slice 4's Target board read) and
 * {@link TurnSnapshotHydra.designConceptBody} (slice 3, a `curl -sf
 * --max-time 3` projection: non-2xx / transport failure ⇒ `""`, and a 2xx
 * HTML body still counts, exactly as that curl did). Tests inject a fake
 * {@link HydraTransport}; no network, no service.
 */

/** One hydra HTTP read: the body on success, or why it failed. */
export type HydraRead = { readonly kind: "ok"; readonly body: string } | { readonly kind: "failed"; readonly reason: string };

/** Per-read options for {@link TurnSnapshotHydra.get}. */
export interface HydraGetOptions {
  /** Per-call timeout; defaults to {@link HYDRA_HTTP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The data-plane reads the Turn Snapshot collectors need. */
export interface TurnSnapshotHydra {
  /** `GET /api<path>` with `hydra raw GET` failure semantics; the body verbatim (an empty 2xx body is `ok ""`). */
  get(path: string, opts?: HydraGetOptions): Promise<HydraRead>;
  /** `GET /api/autopilot/board-state` — the orch board counts + glm_withheld (slice 2); `$(...)`-captured, so trailing newlines are stripped and an empty body is `failed: empty-body`. */
  orchBoardState(): Promise<HydraRead>;
  /** `GET /api/autopilot/board-state?scope=target` — the Target board counts (slice 4); same budget and failure rules. */
  targetBoardState(): Promise<HydraRead>;
  /**
   * The design-concept artifact body for `issue-<N>` (slice 3's grill probe),
   * or `""` when the read failed, timed out or was not 2xx (a 404 = no
   * artifact) — the `curl -sf --max-time 3 … || true` projection.
   */
  designConceptBody(issue: number): Promise<string>;
}

/** The raw HTTP GET under the client: resolves with status + body, rejects on a transport error. */
export type HydraTransport = (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

export const DEFAULT_HYDRA_BASE_URL = "http://localhost:4000";

/**
 * Default per-request timeout. `hydra raw` (curl without `--max-time`) had
 * none; a hung data plane then wedged the whole turn. 60s keeps every healthy
 * read and turns a hang into the collector's degraded fallback instead.
 */
export const HYDRA_HTTP_TIMEOUT_MS = 60_000;
/** The board-state reads' budget, orch and Target (one local read; generous so a busy service is not misread as down). */
export const BOARD_STATE_TIMEOUT_MS = 30_000;
/** `curl --max-time 3` — the design-concept probe's budget per anchor. */
export const DESIGN_CONCEPT_TIMEOUT_MS = 3_000;

const HTML_PREFIXES = ["<!DOCTYPE", "<!doctype", "<html", "<HTML"];

/** The default transport: global `fetch`, no redirect following (curl without `-L`), with an abort timeout. */
export const fetchTransport: HydraTransport = async (url, timeoutMs) => {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
};

/** `$(...)` semantics: strip every trailing newline. */
const stripTrailingNewlines = (s: string) => s.replace(/\n+$/, "");

export interface TurnSnapshotHydraOptions {
  /** `HYDRA_BASE_URL`; empty/undefined → {@link DEFAULT_HYDRA_BASE_URL} (bash `${VAR:-default}`). */
  baseUrl?: string;
  transport?: HydraTransport;
  /** Default timeout for {@link TurnSnapshotHydra.get}. */
  timeoutMs?: number;
}

/** The production client over `fetch`; the base URL defaults to `HYDRA_BASE_URL`. */
export function createTurnSnapshotHydra(opts: TurnSnapshotHydraOptions = {}): TurnSnapshotHydra {
  const baseUrl = opts.baseUrl !== undefined ? opts.baseUrl : process.env.HYDRA_BASE_URL;
  const base = baseUrl ? baseUrl : DEFAULT_HYDRA_BASE_URL;
  const transport = opts.transport ?? fetchTransport;
  const defaultTimeout = opts.timeoutMs ?? HYDRA_HTTP_TIMEOUT_MS;

  /** The raw call: never throws; a transport error is reported as `null` plus its reason. */
  const call = async (path: string, timeoutMs: number): Promise<{ status: number; body: string } | { error: string }> => {
    try {
      return await transport(`${base}/api${path}`, timeoutMs);
    } catch (err) {
      /* intentional: a transport error IS the failed read — returned as data, rendered by the collector as its degraded fallback */
      return { error: `transport: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const get = async (path: string, getOpts: HydraGetOptions = {}): Promise<HydraRead> => {
    const res = await call(path, getOpts.timeoutMs ?? defaultTimeout);
    if ("error" in res) return { kind: "failed", reason: res.error };
    if (res.status < 200 || res.status > 299) return { kind: "failed", reason: `http-${res.status}` };
    if (HTML_PREFIXES.some((p) => res.body.startsWith(p))) return { kind: "failed", reason: "html-body" };
    return { kind: "ok", body: res.body };
  };

  /** A `$(hydra raw GET …)` capture: trailing newlines stripped, and an empty capture is a failed read. */
  const captured = async (path: string, getOpts: HydraGetOptions): Promise<HydraRead> => {
    const read = await get(path, getOpts);
    if (read.kind === "failed") return read;
    const body = stripTrailingNewlines(read.body);
    return body === "" ? { kind: "failed", reason: "empty-body" } : { kind: "ok", body };
  };

  return {
    get,
    orchBoardState: () => captured("/autopilot/board-state", { timeoutMs: BOARD_STATE_TIMEOUT_MS }),
    targetBoardState: () => captured("/autopilot/board-state?scope=target", { timeoutMs: BOARD_STATE_TIMEOUT_MS }),
    async designConceptBody(issue) {
      const res = await call(`/design-concepts/issue-${issue}`, DESIGN_CONCEPT_TIMEOUT_MS);
      if ("error" in res || res.status < 200 || res.status > 299) return "";
      return stripTrailingNewlines(res.body);
    },
  };
}
