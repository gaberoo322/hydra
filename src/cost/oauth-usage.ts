/**
 * src/cost/oauth-usage.ts — the **OAuth Usage Adapter** seam (issue #1083).
 *
 * The authoritative server-side subscription-usage meter — the same source
 * Claude Code's `/usage` slash command reads. Before this seam the
 * **Subscription Usage Tracker** (`./usage-tracker.ts`) could only *estimate*
 * utilization: sum tokens from local `~/.claude/projects/*.jsonl` transcripts
 * and divide by a hand-calibrated quota denominator. That estimate read ~2x
 * wrong and swung week-to-week with the cache-hit mix (issue #1083). This
 * Adapter reads the real number instead.
 *
 * It is the FIFTH boundary Seam, sibling to the **Anthropic Request Adapter**
 * (`src/anthropic/request.ts`) — also over `fetch()`, also
 * never-throwing, also returning a discriminated `{ok:true;data}|{ok:false;code}`
 * result whose `oauth-usage-*` codes join the `HydraErrorCode` union as
 * RESULT-OBJECT literals (no thrown subclass; the seam returns, never raises).
 * Callers discriminate on `code`, never on `err.message`.
 *
 * What it owns (and ONLY this):
 *   - resolving + freshly reading the credentials file (the access token),
 *   - the HTTP GET to the OAuth usage endpoint with the beta header,
 *   - the AbortSignal timeout discipline,
 *   - a MAXIMALLY DEFENSIVE parse (the response schema is observed-not-documented
 *     — probed empirically — so every window is nullable and a 200-with-garbage
 *     body is classified meter-unavailable, NEVER coerced to 0),
 *   - the never-throw result contract.
 *
 * What it deliberately does NOT own: the fallback-to-estimate decision, the
 * gating math, or any pacing policy — those stay in the usage tracker. This
 * file is the only place in the codebase that knows the OAuth meter exists.
 *
 * Account auto-follow: the credentials file (`~/.claude/.credentials.json`)
 * is read FRESH on every poll. Claude Code rotates `claudeAiOauth.accessToken`
 * in that file when the operator re-logs into a different account, so the meter
 * always reflects the currently-logged-in account with zero env changes — a
 * cached token would defeat that, hence the fresh read.
 *
 * Config override:
 *   - HYDRA_CLAUDE_CREDENTIALS_PATH — credentials file location (defaults to
 *     `~/.claude/.credentials.json`), mirroring the `HYDRA_CLAUDE_PROJECTS_ROOT`
 *     override on the Transcript Store. The credentials file is NOT a transcript,
 *     so the path resolver lives here rather than extending the Transcript Store
 *     Seam — each boundary stays single-purpose.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HydraErrorCode } from "../errors.ts";
import { logger } from "../logger.ts";
import { getOAuthUsageMaxStaleMs } from "./config.ts";

/** The subset of `HydraErrorCode` the OAuth Usage Adapter can return. */
export type OAuthUsageErrorCode = Extract<HydraErrorCode, `oauth-usage-${string}`>;

/**
 * One rolling-utilization window from the OAuth meter. `utilization` is a
 * direct 0–100 percent (NOT a fraction). `resetsAt` is the real window
 * boundary as an ISO-8601 string, or `null` when the meter reported a
 * non-string / unparseable / absent boundary.
 */
interface OAuthUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/**
 * The account's paid-overage ("extra usage") facility, as reported by the
 * meter's `extra_usage` object.
 *
 * Subscription quota is prepaid; **extra usage bills real money OUTSIDE the
 * subscription** once a window is exhausted. It is an account-level setting,
 * not a Hydra one, so it silently follows a `/login` to a different account the
 * same way the meter itself does — which is exactly why a gate keyed off
 * {@link armed} must live in code rather than in a per-account env constant.
 */
interface OAuthExtraUsage {
  /**
   * True when overage CAN bill: the facility is enabled AND the user has not
   * switched it off. This is a CAPABILITY flag, not evidence of spend — see
   * {@link usedCredits} for that.
   */
  armed: boolean;
  /**
   * The meter's raw `used_credits` counter, or `null` when absent/non-numeric.
   *
   * DELIBERATELY UNINTERPRETED. The meter reports `used_credits`,
   * `monthly_limit`, `currency` and `decimal_places` whose units do not
   * self-consistently reconcile with the sibling `utilization` field (observed
   * 2026-08-14: used_credits=51547, monthly_limit=1000, decimal_places=2,
   * utilization=100.0 — 51547 reads as $515.47 against $1000, i.e. 51.5%, not
   * 100%). Treat this as an opaque MONOTONIC COUNTER: a change means overage
   * was billed. Never render it as a currency amount, and never divide it by
   * the limit.
   */
  usedCredits: number | null;
}

/**
 * The parsed, gating-relevant slice of the OAuth meter. Two rolling windows —
 * the 5-hour (drives the 5h `emergencyStop`) and the 7-day (the weekly
 * headline) — plus the account's paid-overage facility. The opus/sonnet
 * sub-windows the endpoint also returns are not part of this contract.
 *
 * `extraUsage` is OPTIONAL so the many `OAuthUsageData` literals already in the
 * test suite keep type-checking; an absent value reads as "no overage
 * facility", never as "armed".
 */
export interface OAuthUsageData {
  fiveHour: OAuthUsageWindow;
  sevenDay: OAuthUsageWindow;
  extraUsage?: OAuthExtraUsage;
}

/**
 * The discriminated result the Adapter returns. `ok:true` carries the parsed
 * {@link OAuthUsageData}; `ok:false` carries a machine-readable `oauth-usage-*`
 * code. Callers discriminate on `code`, NEVER on prose. CRITICAL: a failure
 * result must make the caller FALL BACK to the transcript estimate — it must
 * never be read as "0% utilization" (which would wrongly unblock dispatch
 * during an OAuth outage; issue #1083 gate-safe invariant).
 *
 * `retryAfterMs` (issue #2666) is ADDITIVE and only ever populated on the
 * `oauth-usage-rate-limited` (429) failure: the server's parsed `Retry-After`
 * hint in ms, clamped to the maxStale ceiling. The cadence layer may use it
 * only to LENGTHEN its exponential backoff, never to shorten it.
 */
export type OAuthUsageResult =
  | { ok: true; data: OAuthUsageData }
  | { ok: false; code: OAuthUsageErrorCode; retryAfterMs?: number };

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
 * Default request timeout — the seam-level discipline every boundary Seam
 * follows, so a hung endpoint can't wedge the 60s usage scan. A timeout
 * degrades to the transcript estimate exactly like any other failure.
 */
const OAUTH_USAGE_TIMEOUT_MS = 5_000;

/**
 * Resolve the credentials file path — the single owner of the
 * `HYDRA_CLAUDE_CREDENTIALS_PATH` override. Defaults to
 * `~/.claude/.credentials.json`. Mirrors `projectsRoot()` on the Transcript
 * Store, but kept here (not there) because the credentials file is not a
 * transcript — each boundary seam stays single-purpose.
 */
function credentialsPath(): string {
  return (
    process.env.HYDRA_CLAUDE_CREDENTIALS_PATH ||
    join(homedir(), ".claude", ".credentials.json")
  );
}

/**
 * Read the OAuth access token FRESH from the credentials file, or `null` when
 * the file is missing / unreadable / malformed / has no
 * `claudeAiOauth.accessToken`. Never throws — a missing or rotated-away token
 * is the normal account-switch / logged-out path and must degrade gracefully.
 *
 * Read fresh on every call (no token cache): Claude Code rotates this file on
 * re-login, and caching the token would defeat the account auto-follow.
 */
async function readAccessToken(path: string = credentialsPath()): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: any) {
    // A missing/unreadable credentials file is an expected state (logged out,
    // relocated home dir). Logged so a persistent mis-config is visible, but
    // it degrades to the transcript estimate, never a throw.
    logger.error({ path, err }, "[oauth-usage] credentials file unreadable");
    return null;
  }
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (err: any) {
    logger.error({ path, err }, "[oauth-usage] credentials file is not valid JSON");
    return null;
  }
  const token = obj?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token === "") {
    logger.error({ path }, "[oauth-usage] credentials file has no claudeAiOauth.accessToken");
    return null;
  }
  return token;
}

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

/**
 * Map a thrown fetch error onto an `oauth-usage-*` failure code, following the
 * boundary-Seam `classifyThrown` shape. `AbortSignal.timeout` rejects
 * with a `TimeoutError`/`AbortError` name (=> `oauth-usage-timeout`); anything
 * else at the transport layer (DNS, ECONNREFUSED, offline) is
 * `oauth-usage-network`.
 */
function classifyThrown(err: any): OAuthUsageErrorCode {
  const name = err?.name;
  if (name === "TimeoutError" || name === "AbortError") return "oauth-usage-timeout";
  return "oauth-usage-network";
}

/**
 * Read the authoritative OAuth subscription-usage meter. NEVER throws — every
 * failure mode is surfaced via the discriminated {@link OAuthUsageResult} so the
 * caller can fall back to the transcript estimate:
 *
 *   oauth-usage-no-credentials — no credentials file / no access token,
 *   oauth-usage-token-expired  — the endpoint reported 401/403 (token expired/invalid),
 *   oauth-usage-rate-limited   — the endpoint reported 429; carries the parsed
 *                                Retry-After hint as `retryAfterMs` when present
 *                                (issue #2666),
 *   oauth-usage-non-2xx        — any other non-2xx status from the endpoint,
 *   oauth-usage-parse          — a 2xx body that failed JSON.parse OR a
 *                                200-with-garbage body missing a usable window,
 *   oauth-usage-timeout        — the AbortSignal fired,
 *   oauth-usage-network        — transport failed (DNS/ECONNREFUSED/offline).
 *
 * `fetchImpl` and `readToken` are injectable so the seam is unit-testable
 * without a live endpoint or a real credentials file.
 */
export async function readOAuthUsage(
  opts: {
    timeout?: number;
    fetchImpl?: typeof fetch;
    readToken?: (path?: string) => Promise<string | null>;
    credentialsPath?: string;
  } = {},
): Promise<OAuthUsageResult> {
  const timeout = opts.timeout ?? OAUTH_USAGE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readToken = opts.readToken ?? readAccessToken;

  const token = await readToken(opts.credentialsPath);
  if (token === null) {
    return { ok: false, code: "oauth-usage-no-credentials" };
  }

  let res: Response;
  try {
    res = await fetchImpl(OAUTH_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_USAGE_BETA,
      },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err: any) {
    const code = classifyThrown(err);
    logger.error({ code, err }, "[oauth-usage] read threw");
    return { ok: false, code };
  }

  if (!res.ok) {
    // 429 is the shared account-wide rate-limit bucket, distinct from a sick
    // endpoint (issue #2666): classify it separately so the operator-facing
    // oauthError string reads "rate-limited, meter serving stale" rather than a
    // generic non-2xx, and surface the parsed Retry-After hint so the cadence
    // layer can LENGTHEN (never shorten) its exponential backoff. Degrades to
    // stale-serve/estimate like every failure; never throws.
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        // Defensive access: injected test doubles may omit `headers` entirely.
        typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null,
        Date.now(),
        getOAuthUsageMaxStaleMs(),
      );
      const text = await res.text().catch(() => "");
      logger.error(
        { code: "oauth-usage-rate-limited", status: 429, retryAfterMs, body: text.slice(0, 200) },
        "[oauth-usage] oauth-usage-rate-limited: 429",
      );
      return retryAfterMs !== undefined
        ? { ok: false, code: "oauth-usage-rate-limited", retryAfterMs }
        : { ok: false, code: "oauth-usage-rate-limited" };
    }
    // 401/403 means the token expired or was revoked (the account-switch /
    // re-login window). Distinguish it from a generic non-2xx so a caller /
    // operator can tell "log back in" from "endpoint is sick". Both degrade to
    // the estimate; neither throws.
    const code: OAuthUsageErrorCode =
      res.status === 401 || res.status === 403
        ? "oauth-usage-token-expired"
        : "oauth-usage-non-2xx";
    const text = await res.text().catch(() => "");
    logger.error({ code, status: res.status, body: text.slice(0, 200) }, "[oauth-usage] non-2xx status");
    return { ok: false, code };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err: any) {
    logger.error({ code: "oauth-usage-parse", err }, "[oauth-usage] oauth-usage-parse (JSON.parse)");
    return { ok: false, code: "oauth-usage-parse" };
  }

  const data = parseOAuthUsageBody(body);
  if (data === null) {
    // A 2xx with a body we can't read a usable window out of. Treat exactly
    // like a failed read for gating-safety — fall back to the estimate, NEVER
    // coerce a missing utilization to 0.
    logger.error(
      { code: "oauth-usage-parse" },
      "[oauth-usage] oauth-usage-parse: 2xx body missing a usable five_hour/seven_day window",
    );
    return { ok: false, code: "oauth-usage-parse" };
  }
  return { ok: true, data };
}
