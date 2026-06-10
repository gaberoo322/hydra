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
 * It is a boundary Seam, sibling to the **OpenViking Request Adapter**
 * (`src/knowledge-base/ov-request.ts`) — also over `fetch()`, also
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

/** The subset of `HydraErrorCode` the OAuth Usage Adapter can return. */
export type OAuthUsageErrorCode = Extract<HydraErrorCode, `oauth-usage-${string}`>;

/**
 * One rolling-utilization window from the OAuth meter. `utilization` is a
 * direct 0–100 percent (NOT a fraction). `resetsAt` is the real window
 * boundary as an ISO-8601 string, or `null` when the meter reported a
 * non-string / unparseable / absent boundary.
 */
export interface OAuthUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/**
 * The parsed, gating-relevant slice of the OAuth meter. Only the two windows
 * the tracker rebases onto are surfaced: the rolling 5-hour window (drives the
 * 5h `emergencyStop`) and the rolling 7-day window (the weekly headline). The
 * opus/sonnet/extra_usage sub-windows the endpoint also returns are not part of
 * this contract — the tracker does not gate on them.
 */
export interface OAuthUsageData {
  fiveHour: OAuthUsageWindow;
  sevenDay: OAuthUsageWindow;
}

/**
 * The discriminated result the Adapter returns. `ok:true` carries the parsed
 * {@link OAuthUsageData}; `ok:false` carries a machine-readable `oauth-usage-*`
 * code. Callers discriminate on `code`, NEVER on prose. CRITICAL: a failure
 * result must make the caller FALL BACK to the transcript estimate — it must
 * never be read as "0% utilization" (which would wrongly unblock dispatch
 * during an OAuth outage; issue #1083 gate-safe invariant).
 */
export type OAuthUsageResult =
  | { ok: true; data: OAuthUsageData }
  | { ok: false; code: OAuthUsageErrorCode };

/** Type guard narrowing an {@link OAuthUsageResult} to its failure arm. */
export function isOAuthUsageFailure(
  result: OAuthUsageResult,
): result is { ok: false; code: OAuthUsageErrorCode } {
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
 * Default request timeout — matches the OpenViking Request Adapter's seam-level
 * discipline so a hung endpoint can't wedge the 60s usage scan. A timeout
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
export function credentialsPath(): string {
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
    console.error(
      `[oauth-usage] credentials file unreadable at ${path}: ${err?.message || err}`,
    );
    return null;
  }
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (err: any) {
    console.error(`[oauth-usage] credentials file is not valid JSON at ${path}: ${err?.message || err}`);
    return null;
  }
  const token = obj?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token === "") {
    console.error(
      `[oauth-usage] credentials file has no claudeAiOauth.accessToken at ${path}`,
    );
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
 * Parse the full OAuth usage response body into {@link OAuthUsageData}, or
 * `null` when either gating window (five_hour / seven_day) is absent or
 * unparseable. The opus/sonnet/extra_usage sub-windows are ignored — the
 * tracker gates only on the two rolling windows. Maximally defensive: a
 * 200-with-garbage body parses to `null`, which the caller classifies as
 * `oauth-usage-parse` (=> fall back to estimate), never as 0% utilization.
 *
 * Exported so the defensive parse is unit-testable without a live endpoint.
 */
export function parseOAuthUsageBody(body: unknown): OAuthUsageData | null {
  if (body === null || typeof body !== "object") return null;
  const fiveHour = parseWindow((body as any).five_hour);
  const sevenDay = parseWindow((body as any).seven_day);
  if (fiveHour === null || sevenDay === null) return null;
  return { fiveHour, sevenDay };
}

/**
 * Map a thrown fetch error onto an `oauth-usage-*` failure code, mirroring the
 * OpenViking Request Adapter's `classifyThrown`. `AbortSignal.timeout` rejects
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
    console.error(`[oauth-usage] ${code}: ${err?.message ?? err}`);
    return { ok: false, code };
  }

  if (!res.ok) {
    // 401/403 means the token expired or was revoked (the account-switch /
    // re-login window). Distinguish it from a generic non-2xx so a caller /
    // operator can tell "log back in" from "endpoint is sick". Both degrade to
    // the estimate; neither throws.
    const code: OAuthUsageErrorCode =
      res.status === 401 || res.status === 403
        ? "oauth-usage-token-expired"
        : "oauth-usage-non-2xx";
    const text = await res.text().catch(() => "");
    console.error(`[oauth-usage] ${code}: ${res.status} ${text.slice(0, 200)}`);
    return { ok: false, code };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err: any) {
    console.error(`[oauth-usage] oauth-usage-parse (JSON.parse): ${err?.message ?? err}`);
    return { ok: false, code: "oauth-usage-parse" };
  }

  const data = parseOAuthUsageBody(body);
  if (data === null) {
    // A 2xx with a body we can't read a usable window out of. Treat exactly
    // like a failed read for gating-safety — fall back to the estimate, NEVER
    // coerce a missing utilization to 0.
    console.error(
      `[oauth-usage] oauth-usage-parse: 2xx body missing a usable five_hour/seven_day window`,
    );
    return { ok: false, code: "oauth-usage-parse" };
  }
  return { ok: true, data };
}
