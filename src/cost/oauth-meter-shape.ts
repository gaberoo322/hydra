/**
 * src/cost/oauth-meter-shape.ts — the pure **OAuth meter shape** leaf of the
 * **Cost** Module's Subscription Usage Tracker (ADR-0042 Decision 5, issue
 * #4781).
 *
 * Owns the PURE half of the OAuth Usage Adapter's surface: everything about the
 * meter that is vocabulary or math, not I/O — the endpoint constants, the two
 * result-arm type guards, the maximally-defensive response-body parse, and the
 * `Retry-After` parser. Relocated VERBATIM (same bodies, same signatures, same
 * doc-comments) out of `oauth-usage.ts`, which stays the I/O shell around
 * `readOAuthUsage` (credentials read, fetch, AbortSignal, never-throw result
 * contract) and re-exports every symbol below at the old name so no importer
 * changes (the #3513 precedent).
 *
 * WHY A SEPARATE LEAF: `snapshot-assembly.ts` (L3, pure) needs
 * `isOAuthUsageOk` to fold the cached OAuth read, but importing it from
 * `oauth-usage.ts` (L4, I/O) was an UPWARD edge — the pure fold dragged the
 * credentials-file/`node:fs`/fetch closure into its import graph. ADR-0042
 * clears such edges by moving vocabulary DOWN, never by blessing them: the
 * guards and parses are pure, so they live in this L1 leaf next to
 * `token-math.ts` / `token-breakdown.ts` / `types.ts`, and both `oauth-usage.ts`
 * (L4) and `snapshot-assembly.ts` (L3) now import them DOWNWARD.
 *
 * PURE (ADR-0042 Decision 2): no filesystem, no HTTP, no Redis, no
 * `process.env`, no `Date.now()` — the only imports are TYPE-only references to
 * the sibling vocabulary root `./types.ts` (`OAuthUsageData`,
 * `OAuthUsageResult`, and the two window shapes its parse targets), which are
 * fully compile-erased. `parseRetryAfterMs` takes `nowMs` as an argument for
 * exactly this reason.
 */

import type {
  OAuthUsageData,
  OAuthUsageResult,
  OAuthUsageErrorCode,
  OAuthUsageWindow,
  OAuthExtraUsage,
} from "./types.ts";

/** Type guard narrowing an {@link OAuthUsageResult} to its failure arm. */
export function isOAuthUsageFailure(
  result: OAuthUsageResult,
): result is { ok: false; code: OAuthUsageErrorCode; retryAfterMs?: number } {
  return result.ok === false;
}

/** Type guard narrowing an {@link OAuthUsageResult} to its success arm. */
export function isOAuthUsageOk(
  result: OAuthUsageResult,
): result is { ok: true; data: OAuthUsageData } {
  return result.ok === true;
}

/** The authoritative OAuth subscription-usage meter endpoint (issue #1083). */
export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * The beta header the endpoint requires. Probed empirically 2026-06-06;
 * `/api/oauth/usage` was the only candidate of five that returned 200 with the
 * `oauth-2025-04-20` beta flag set alongside the credentials bearer.
 */
export const OAUTH_USAGE_BETA = "oauth-2025-04-20";

/**
 * Coerce a meter `utilization` value to a finite percent in [0, 100], or `null`
 * when absent / non-finite / not a number. CRITICAL: an unparseable utilization
 * returns `null` (=> meter-unavailable => fall back to estimate), NOT 0 — a
 * silent 0 would falsely read as "no usage" and unblock the emergencyStop gate
 * during an outage (issue #1083 defensive-parse invariant).
 */
function coerceUtilization(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // The meter is a 0–100 percent; clamp defensively against an out-of-range
  // server value rather than trusting it blindly.
  return Math.min(100, Math.max(0, value));
}

/** Coerce a meter `resets_at` value to an ISO-8601 string, or `null` if unparseable. */
function coerceResetsAt(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Parse a single window object (e.g. `five_hour`) into an {@link OAuthUsageWindow},
 * or `null` when the window is absent or its utilization is unparseable. A
 * window present but with a garbage/missing utilization is treated as
 * meter-unavailable (null), never coerced to a 0 utilization.
 */
function parseWindow(raw: unknown): OAuthUsageWindow | null {
  if (raw === null || typeof raw !== "object") return null;
  const utilization = coerceUtilization((raw as any).utilization);
  if (utilization === null) return null;
  return { utilization, resetsAt: coerceResetsAt((raw as any).resets_at) };
}

/**
 * Parse the meter's `extra_usage` object into {@link OAuthExtraUsage}.
 *
 * Total function — never null. An absent/garbage object yields
 * `{armed: false, usedCredits: null}`, which is the SEMANTICALLY correct
 * reading rather than a mere fail-open: no `extra_usage` object means the
 * account exposes no overage facility, so nothing can bill.
 *
 * `armed` requires `is_enabled === true` AND `user_disabled !== true` — both
 * strict, so any non-boolean garbage in either field reads as not-armed rather
 * than coercing. The two fields are independent: an account can have the
 * facility enabled at the plan level while the user has explicitly turned it
 * off, and only the combination can actually bill.
 */
function parseExtraUsage(raw: unknown): OAuthExtraUsage {
  if (raw === null || typeof raw !== "object") return { armed: false, usedCredits: null };
  const r = raw as Record<string, unknown>;
  const armed = r.is_enabled === true && r.user_disabled !== true;
  const usedCredits =
    typeof r.used_credits === "number" && Number.isFinite(r.used_credits) ? r.used_credits : null;
  return { armed, usedCredits };
}

/**
 * Parse the full OAuth usage response body into {@link OAuthUsageData}, or
 * `null` when either gating window (five_hour / seven_day) is absent or
 * unparseable. The opus/sonnet sub-windows are ignored — the tracker gates only
 * on the two rolling windows plus `extra_usage`. Maximally defensive: a
 * 200-with-garbage body parses to `null`, which the caller classifies as
 * `oauth-usage-parse` (=> fall back to estimate), never as 0% utilization.
 *
 * A malformed `extra_usage` never invalidates an otherwise-good body — the two
 * rolling windows remain the availability contract, and `parseExtraUsage`
 * degrades to not-armed on its own.
 *
 * Exported so the defensive parse is unit-testable without a live endpoint.
 */
export function parseOAuthUsageBody(body: unknown): OAuthUsageData | null {
  if (body === null || typeof body !== "object") return null;
  const fiveHour = parseWindow((body as any).five_hour);
  const sevenDay = parseWindow((body as any).seven_day);
  if (fiveHour === null || sevenDay === null) return null;
  return { fiveHour, sevenDay, extraUsage: parseExtraUsage((body as any).extra_usage) };
}

/**
 * Parse an HTTP `Retry-After` header value into a delay in ms, or `undefined`
 * when the header is absent / unparseable (issue #2666). Accepts both RFC 9110
 * forms:
 *
 *   - delta-seconds (`"120"`)  → 120_000 ms
 *   - HTTP-date               → `Date.parse(value) - nowMs` (a past date → 0)
 *
 * The result is clamped to `[0, ceilingMs]` so a hostile/buggy header cannot
 * park the meter for hours — the ceiling is the maxStale window, past which the
 * cadence layer would have fallen to the estimate anyway. Pure (nowMs +
 * ceilingMs injected) so it is unit-testable without a live clock. Exported for
 * direct unit test.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number,
  ceilingMs: number,
): number | undefined {
  if (typeof headerValue !== "string") return undefined;
  const value = headerValue.trim();
  if (value === "") return undefined;
  let delayMs: number;
  if (/^\d+$/.test(value)) {
    delayMs = Number(value) * 1000;
  } else if (/^[+-]?\d+$/.test(value)) {
    // An integer-like string that is NOT plain digits (e.g. "-5", "+30") is
    // invalid delta-seconds per RFC 9110 — reject it rather than letting
    // Date.parse misread it as a year (Date.parse("-5") → year -5, a past
    // date, which would wrongly clamp to "retry now").
    return undefined;
  } else {
    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs)) return undefined;
    delayMs = dateMs - nowMs;
  }
  if (!Number.isFinite(delayMs)) return undefined;
  return Math.min(Math.max(delayMs, 0), ceilingMs);
}
