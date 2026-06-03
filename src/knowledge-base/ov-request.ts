/**
 * knowledge-base/ov-request.ts — the single private request primitive behind the
 * **OpenViking Request Adapter** seam (issue #954).
 *
 * The fourth boundary Seam, sibling to the **GitHub CLI Adapter**
 * (`src/github/*`, gh/git process) and the **Host-Probe Adapter**
 * (`src/host-probe/*`, df/free/systemctl process) — but over `fetch()`, not
 * `node:child_process`. Each boundary Seam owns its OWN transport primitive;
 * this one is deliberately NOT collapsed onto the two process Seams (different
 * transport, different error modes — CONTEXT.md, OpenViking Request Adapter).
 *
 * Why one primitive
 * -----------------
 * Before this seam ~8 raw `fetch(\`${OV_URL}/api/v1/...\`)` calls lived inline
 * across `ov-search.ts`, `ov-upload.ts`, `skill-registration.ts`,
 * `api/openviking.ts`, `api/health.ts`, and `redis/work-queue.ts` — each
 * re-deriving the URL join, the auth headers (`OPENVIKING_HEADERS` vs an inline
 * `{"Content-Type","X-Api-Key"}` literal), the `AbortSignal` timeout discipline
 * (5000ms in one place, NONE in `api/openviking.ts`), the `!res.ok` error mode,
 * and the `res.json()` shape unwrap. Worse, `api/health.ts` hardcoded
 * `http://localhost:1933/...`, so a non-default `OPENVIKING_URL` silently made
 * the health probe lie (the same #231-class drift the shared `ov-config.ts`
 * default fixed once for the key). This module concentrates the base-URL
 * resolution (always from `OPENVIKING_URL` via `ov-config.ts`, never a hardcoded
 * literal), the auth headers, the timeout discipline, and the four
 * external-request error modes in one place.
 *
 * Never throws
 * ------------
 * Per CLAUDE.md (this is an external-request boundary on the same footing as the
 * gh/git and df/free/systemctl seams), the primitive returns a discriminated
 * `OvResult<T>` (`{ok:true; data} | {ok:false; code}`). The `ov-*` `code`
 * literals live on the `HydraErrorCode` union in `src/errors.ts` as
 * RESULT-OBJECT literals — there is deliberately no thrown subclass; the seam
 * returns, it does not raise. Callers discriminate on `code`, never on
 * `error.message`. Domain behaviour (search metrics + fallback, upload
 * temp_path unwrap, work-queue tag filter + fire-and-forget) stays with the
 * reader; the primitive owns ONLY URL-join + headers + timeout +
 * error-classification + JSON/text unwrap.
 */

import { OPENVIKING_URL, OPENVIKING_HEADERS, OPENVIKING_API_KEY } from "./ov-config.ts";
import type { HydraErrorCode } from "../errors.ts";

/** The subset of `HydraErrorCode` the OpenViking Request Adapter can return. */
export type OvErrorCode = Extract<HydraErrorCode, `ov-${string}`>;

/**
 * The discriminated result every OpenViking Request Adapter accessor returns.
 *
 * `ok:true` carries the typed `data` (already JSON-parsed unless a text/raw mode
 * was requested). `ok:false` carries a machine-readable `code` (an `ov-*`
 * literal from `HydraErrorCode`). Callers discriminate on `code`, NOT on prose.
 *
 * The failure arm also carries an OPTIONAL `body` — the raw non-2xx response
 * text — set only for the `ov-non-2xx` code. It exists so a reader whose domain
 * logic must classify OpenViking's error prose (e.g. `ov-upload.ts` distinguishes
 * "file exists"/"point lock" transient conflicts from real failures) can do so
 * without re-spelling a `fetch`. Callers still discriminate on `code`; `body` is
 * a debugging/classification aid, never the discriminator.
 */
export type OvResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: OvErrorCode; body?: string };

/**
 * Type guard narrowing an `OvResult<T>` to its failure arm.
 *
 * The orchestrator's `tsconfig.json` runs `strict: false` (no `strictNullChecks`),
 * so TypeScript cannot discriminate a union on a boolean `ok` field via plain
 * `if (!result.ok)` control-flow narrowing. These guards give callers reliable
 * narrowing regardless of the strictness setting — mirroring `isProbeFailure`/
 * `isProbeOk` (Host-Probe Adapter) and `isGhFailure`/`isGhOk` (GitHub CLI Adapter).
 */
export function isOvFailure<T>(
  result: OvResult<T>,
): result is { ok: false; code: OvErrorCode } {
  return result.ok === false;
}

/** Type guard narrowing an `OvResult<T>` to its success arm. See {@link isOvFailure}. */
export function isOvOk<T>(result: OvResult<T>): result is { ok: true; data: T } {
  return result.ok === true;
}

/**
 * Resolve the OpenViking base URL — the single owner of base-URL resolution.
 * ALWAYS flows from `OPENVIKING_URL` (via `ov-config.ts`); a hardcoded
 * `localhost:1933` literal must never appear at a call site again (the
 * #231-class lie this seam closes structurally).
 */
export function ovBaseUrl(): string {
  return OPENVIKING_URL;
}

/** Default timeouts, matching the per-call-site values preserved 1:1 across the migration. */
export const OV_DEFAULT_TIMEOUT_MS = 10_000; // ovFetch's historical POST default

/** How the success body should be unwrapped. `"json"` parses; `"text"` reads text; `"none"` ignores it. */
type ParseMode = "json" | "text" | "none";

export interface OvRequestOptions {
  /** Abort timeout in ms. Each reader passes its historical value verbatim. */
  timeout?: number;
  /**
   * Extra headers merged on top of the standard auth headers. Used by the
   * multipart path to DROP the JSON `Content-Type` (FormData sets its own
   * boundary), via `headers: { "Content-Type": undefined }`-style override at
   * the helper layer — see {@link ovUpload}.
   */
  headers?: Record<string, string>;
  /** How to unwrap the success body. Defaults to `"json"`. */
  parse?: ParseMode;
}

/**
 * Map a thrown fetch error onto an `ov-*` failure code. `AbortSignal.timeout`
 * rejects with a `TimeoutError` (name) / `AbortError`, which we classify as
 * `ov-timeout`; anything else at the transport layer (DNS, ECONNREFUSED,
 * service down) is `ov-service-down`.
 */
function classifyThrown(err: any): OvErrorCode {
  const name = err?.name;
  if (name === "TimeoutError" || name === "AbortError") return "ov-timeout";
  return "ov-service-down";
}

/**
 * The private request primitive. NOT meant to be called past the seam directly —
 * the typed readers (`trackedOvSearch`, the upload/skill helpers, the
 * work-queue dedup, the `/health` probes) are its only callers and layer their
 * own domain behaviour on top. Never throws; surfaces everything via
 * {@link OvResult}.
 *
 * Owns, in one place:
 *   - base-URL resolution ({@link ovBaseUrl}) + path join,
 *   - the auth headers (`OPENVIKING_HEADERS`, or a body-shape-specific override),
 *   - the `AbortSignal.timeout` discipline,
 *   - the four external-request error modes:
 *       ov-service-down   — transport failed (DNS/ECONNREFUSED/network),
 *       ov-non-2xx        — the request reached OV but `!res.ok`,
 *       ov-malformed-json — a 2xx body failed to `JSON.parse`,
 *       ov-timeout        — the AbortSignal fired.
 *   - the JSON/text/raw success unwrap.
 *
 * `init.body` and `init.method` are passed through verbatim so a reader controls
 * the wire shape (POST JSON string, POST FormData, GET liveness) while the
 * primitive owns everything around it.
 */
export async function ovRequest<T = any>(
  path: string,
  init: { method?: string; body?: BodyInit | null } = {},
  opts: OvRequestOptions = {},
): Promise<OvResult<T>> {
  const url = `${ovBaseUrl()}${path}`;
  const timeout = opts.timeout ?? OV_DEFAULT_TIMEOUT_MS;
  const parse: ParseMode = opts.parse ?? "json";

  // Merge auth headers with any per-call override. An override value of
  // `undefined` deletes that header (the multipart path drops Content-Type so
  // FormData can set its own multipart boundary). Build a plain record then
  // strip undefined keys so `fetch` never sees an `undefined` value.
  const merged: Record<string, any> = { ...OPENVIKING_HEADERS, ...(opts.headers ?? {}) };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) headers[k] = v as string;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body ?? undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err: any) {
    const code = classifyThrown(err);
    console.error(`[ov-request] ${path} ${code}: ${err?.message ?? err}`);
    return { ok: false, code };
  }

  if (!res.ok) {
    // Fail loud: capture a snippet of the body so a 4xx/5xx is debuggable from
    // logs alone, exactly as the inline `!res.ok` arms used to. The full text is
    // also returned on the failure arm (`body`) for the rare reader whose domain
    // logic classifies OV's error prose (ov-upload's transient-conflict path).
    const text = await res.text().catch(() => "");
    console.error(`[ov-request] ${path} ov-non-2xx: ${res.status} ${text.slice(0, 200)}`);
    return { ok: false, code: "ov-non-2xx", body: text };
  }

  if (parse === "none") {
    return { ok: true, data: undefined as unknown as T };
  }
  if (parse === "text") {
    const text = await res.text().catch(() => "");
    return { ok: true, data: text as unknown as T };
  }
  // parse === "json"
  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err: any) {
    console.error(`[ov-request] ${path} ov-malformed-json: ${err?.message ?? err}`);
    return { ok: false, code: "ov-malformed-json" };
  }
}

/**
 * JSON-body request mode — POST a JSON object to an OV path. Serializes the body
 * with the standard JSON `Content-Type` auth headers. The canonical shape behind
 * `/search/find`, `/sessions`, `/sessions/.../messages`, `/skills`, and the
 * temp_upload `add-resource` step.
 */
export async function ovPostJson<T = any>(
  path: string,
  body: unknown,
  opts: OvRequestOptions = {},
): Promise<OvResult<T>> {
  return ovRequest<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
}

/**
 * Multipart request mode — POST a `FormData` body (file upload). DROPS the JSON
 * `Content-Type` header so the `fetch` runtime sets the `multipart/form-data`
 * boundary itself; keeps the `X-Api-Key` auth. The shape behind
 * `/resources/temp_upload`.
 */
export async function ovPostForm<T = any>(
  path: string,
  form: FormData,
  opts: OvRequestOptions = {},
): Promise<OvResult<T>> {
  return ovRequest<T>(
    path,
    { method: "POST", body: form },
    {
      ...opts,
      // Override Content-Type to undefined → stripped in ovRequest → FormData
      // sets the multipart boundary. Auth (X-Api-Key) is preserved.
      headers: { ...(opts.headers ?? {}), "Content-Type": undefined as unknown as string },
    },
  );
}

/**
 * Liveness/health GET mode — a bare `GET <path>` whose only signal is whether
 * the request reached OV and returned 2xx. The body is ignored (`parse:"none"`).
 * The shape behind the `/health` liveness probes in `api/health.ts`.
 *
 * Returns `{ok:true}` when OV answered 2xx, `{ok:false; code}` otherwise — the
 * caller maps that to its `status:"running"|"failed"` wire shape.
 */
export async function ovHealthGet(
  path: string,
  opts: OvRequestOptions = {},
): Promise<OvResult<void>> {
  return ovRequest<void>(path, { method: "GET" }, { ...opts, parse: "none" });
}

/** Re-export the API key for the rare caller that still needs the raw header value (none today). */
export { OPENVIKING_API_KEY };
