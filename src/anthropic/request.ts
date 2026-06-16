/**
 * anthropic/request.ts — the single private request primitive behind the
 * **Anthropic Request Adapter** seam (issue #1959).
 *
 * The SIXTH boundary Seam, sibling to the **OpenViking Request Adapter**
 * (`src/knowledge-base/ov-request.ts`) and the **OAuth Usage Adapter**
 * (`src/cost/oauth-usage.ts`) — also over `fetch()`, not `node:child_process`.
 * Each boundary Seam owns its OWN transport primitive; this one is deliberately
 * NOT collapsed onto the OV/OAuth fetch Seams (different host, different auth
 * header, different error-mode prose — CONTEXT.md, Anthropic Request Adapter).
 *
 * Why one primitive
 * -----------------
 * Before this seam the full Anthropic Messages API client lived inline in
 * `defaultLlmClient` (`src/autopilot/recommendation-engine.ts`): URL
 * construction, the `anthropic-version` header, API-key resolution from
 * `ANTHROPIC_API_KEY`, the raw `fetch` call, non-2xx classification, JSON parse
 * isolation, token-usage extraction, and per-call USD cost accounting — all
 * boundary concerns entangled with the engine's turn-gating logic, and (the
 * timeout gap this seam closes) with NO `AbortSignal` on the `fetch`, so a hung
 * Anthropic connection could hold the consumer loop indefinitely. This module
 * concentrates the base-URL constant, the version header, the API-key
 * resolution, the `AbortSignal.timeout()` discipline, the three external-request
 * error modes, and the USD cost derivation in one place. `defaultLlmClient`
 * becomes a thin wrapper: call the adapter, map its typed result to `LlmResult`,
 * read cost from the adapter's `cost_usd`.
 *
 * Never throws
 * ------------
 * Per CLAUDE.md (this is an external-request boundary on the same footing as the
 * OpenViking / OAuth-usage fetch Seams), the primitive returns a discriminated
 * `AnthropicResult` (`{ok:true; ...} | {ok:false; code}`). The `anthropic-*`
 * `code` literals live on the `HydraErrorCode` union in `src/errors.ts` as
 * RESULT-OBJECT literals — there is deliberately no thrown subclass; the seam
 * returns, it does not raise. Callers discriminate on `code`, never on
 * `error.message`. The recommendation engine maps a failure arm to a no-op
 * (`null` LlmResult) exactly as the inline closure did, preserving the
 * "transient failure does not pause the engine" contract.
 */

import type { HydraErrorCode } from "../errors.ts";

/** The subset of `HydraErrorCode` the Anthropic Request Adapter can return. */
export type AnthropicErrorCode = Extract<HydraErrorCode, `anthropic-${string}`>;

/** The Anthropic Messages API endpoint — the single owner of this constant. */
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** The `anthropic-version` header value sent on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Default abort timeout (ms) for an Anthropic Messages request. */
const ANTHROPIC_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Token usage extracted from a successful Anthropic Messages response. Both
 * fields default to 0 when the response omits a `usage` block so cost
 * derivation is always well-defined.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * The discriminated result every Anthropic Request Adapter call returns.
 *
 * `ok:true` carries the first text block (`text`), the typed `usage`, and the
 * derived per-call `cost_usd` (computed once, here, from `usage` and the
 * per-model rates — so `LlmResult.cost_usd` reads from one authoritative source
 * rather than inline arithmetic in the engine closure). `ok:false` carries a
 * machine-readable `code` (an `anthropic-*` literal). Callers discriminate on
 * `code`, NOT on prose.
 */
export type AnthropicResult =
  | { ok: true; text: string; usage: AnthropicUsage; cost_usd: number }
  | { ok: false; code: AnthropicErrorCode };

/**
 * Type guard narrowing an `AnthropicResult` to its failure arm.
 *
 * The orchestrator's `tsconfig.json` runs `strict: false` (no
 * `strictNullChecks`), so TypeScript cannot discriminate a union on a boolean
 * `ok` field via plain `if (!result.ok)` control-flow narrowing. These guards
 * give callers reliable narrowing regardless of the strictness setting —
 * mirroring `isOvFailure`/`isOvOk` (OpenViking Request Adapter).
 */
export function isAnthropicFailure(
  result: AnthropicResult,
): result is { ok: false; code: AnthropicErrorCode } {
  return result.ok === false;
}

/** Type guard narrowing an `AnthropicResult` to its success arm. See {@link isAnthropicFailure}. */
export function isAnthropicOk(
  result: AnthropicResult,
): result is { ok: true; text: string; usage: AnthropicUsage; cost_usd: number } {
  return result.ok === true;
}

/**
 * Per-million-token USD cost rates for a model. The engine supplies the rates
 * for the model it calls (haiku today); the adapter owns the arithmetic so the
 * derivation lives at the boundary, not threaded inline through the engine.
 */
export interface AnthropicCostRates {
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
}

/** Derive the per-call USD cost from token usage and per-model rates. */
export function deriveCostUsd(usage: AnthropicUsage, rates: AnthropicCostRates): number {
  return (
    (usage.input_tokens / 1_000_000) * rates.input_per_mtok_usd +
    (usage.output_tokens / 1_000_000) * rates.output_per_mtok_usd
  );
}

/**
 * Extract the first `text` content block from an Anthropic Messages response
 * payload. Returns "" when the payload has no usable text block — the engine's
 * `parseLlmResponse` already treats an empty body as zero recommendations.
 */
export function extractFirstTextBlock(payload: any): string {
  if (!payload || !Array.isArray(payload.content)) return "";
  for (const block of payload.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

/**
 * Map a thrown fetch error onto an `anthropic-*` failure code.
 * `AbortSignal.timeout` rejects with a `TimeoutError`/`AbortError` (name),
 * which we classify as `anthropic-timeout`; anything else at the transport layer
 * (DNS, ECONNREFUSED, offline) is `anthropic-network-error`.
 */
function classifyThrown(err: any): AnthropicErrorCode {
  const name = err?.name;
  if (name === "TimeoutError" || name === "AbortError") return "anthropic-timeout";
  return "anthropic-network-error";
}

export interface AnthropicRequestOptions {
  /** API key — defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Injectable `fetch` — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort timeout in ms. Defaults to {@link ANTHROPIC_DEFAULT_TIMEOUT_MS}. */
  timeout?: number;
  /** Per-model USD cost rates used to derive `cost_usd` from `usage`. */
  costRates: AnthropicCostRates;
}

/**
 * The Anthropic Messages API request body. `model` + `max_tokens` + `messages`
 * is the minimal shape the recommendation engine sends; the adapter passes it
 * through verbatim so a caller controls the wire shape while the primitive owns
 * everything around it (URL, version header, auth, timeout, classification).
 */
export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: string }>;
}

/**
 * The single Anthropic Messages API request primitive. NOT meant to be called
 * past the seam directly — `defaultLlmClient` (and any future Anthropic caller)
 * is its caller and layers its own domain behaviour (prompt building, response
 * parsing into typed recommendations) on top. Never throws; surfaces everything
 * via {@link AnthropicResult}.
 *
 * Owns, in one place:
 *   - the base URL ({@link ANTHROPIC_MESSAGES_URL}) + version header,
 *   - API-key resolution (`opts.apiKey` ?? `ANTHROPIC_API_KEY`),
 *   - the `AbortSignal.timeout` discipline (the gap the inline client had),
 *   - the three external-request error modes:
 *       anthropic-non-2xx        — the request reached the API but `!res.ok`,
 *       anthropic-malformed-json — a 2xx body failed to `JSON.parse`,
 *       anthropic-network-error  — transport failed (DNS/ECONNREFUSED/network),
 *       anthropic-timeout        — the AbortSignal fired,
 *   - token-usage extraction + USD cost derivation ({@link deriveCostUsd}).
 *
 * Returns `{ok:false; code:"anthropic-no-api-key"}` when no key is configured —
 * the caller maps that to the same inert no-op the inline closure used (so the
 * engine stays silent until the operator opts in by setting the key).
 */
export async function anthropicMessages(
  body: AnthropicMessagesRequest,
  opts: AnthropicRequestOptions,
): Promise<AnthropicResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, code: "anthropic-no-api-key" };
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    console.error("[anthropic-request] no fetch available; request inert");
    return { ok: false, code: "anthropic-network-error" };
  }
  const timeout = opts.timeout ?? ANTHROPIC_DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err: any) {
    const code = classifyThrown(err);
    console.error(`[anthropic-request] ${code}: ${err?.message ?? err}`);
    return { ok: false, code };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[anthropic-request] anthropic-non-2xx ${res.status}: ${detail.slice(0, 200)}`,
    );
    return { ok: false, code: "anthropic-non-2xx" };
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch (err: any) {
    console.error(`[anthropic-request] anthropic-malformed-json: ${err?.message ?? err}`);
    return { ok: false, code: "anthropic-malformed-json" };
  }

  const text = extractFirstTextBlock(payload);
  const usage: AnthropicUsage = {
    input_tokens: Number(payload?.usage?.input_tokens || 0),
    output_tokens: Number(payload?.usage?.output_tokens || 0),
  };
  const cost_usd = deriveCostUsd(usage, opts.costRates);

  return { ok: true, text, usage, cost_usd };
}
