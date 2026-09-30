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
 *   - the never-throw result contract.
 *
 * What it deliberately does NOT own: the fallback-to-estimate decision, the
 * gating math, or any pacing policy — those stay in the usage tracker — and,
 * since ADR-0042 Decision 5 (issue #4781), the PURE half of the old surface:
 * the endpoint constants, the result-arm type guards, the maximally-defensive
 * body parse, and the `Retry-After` parser all moved DOWN into the L1 leaf
 * `./oauth-meter-shape.ts` (so the pure `snapshot-assembly.ts` fold could
 * import `isOAuthUsageOk` without an upward edge onto this I/O module), and the
 * result/window TYPES moved into the type-vocabulary root `./types.ts`. This
 * file remains the I/O shell around {@link readOAuthUsage} and re-exports every
 * moved symbol at the old name (the #3513 precedent), so `test/oauth-usage.test.mts`,
 * `src/cost/index.ts`, and `scripts/cost/weighted-quota-report.ts` keep
 * resolving unchanged.
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
import { logger } from "../logger.ts";
import { getOAuthUsageMaxStaleMs } from "./config.ts";
// Pure meter-shape leaf (ADR-0042 Decision 5, issue #4781): the endpoint
// constants, the defensive body parse, and the Retry-After parser this I/O
// shell consumes. Imported DOWNWARD from L1; the leaf imports nothing at
// runtime, so no cycle.
import {
  OAUTH_USAGE_URL,
  OAUTH_USAGE_BETA,
  parseOAuthUsageBody,
  parseRetryAfterMs,
} from "./oauth-meter-shape.ts";
// The result/window TYPES moved to the type-vocabulary root (issue #4781);
// type-only, compile-erased.
import type { OAuthUsageResult, OAuthUsageErrorCode } from "./types.ts";

// Re-export the relocated pure surface at the SAME names this module used to
// own (ADR-0042 Decision 5, issue #4781 — the #3513 precedent), so existing
// importers of `./oauth-usage.ts` — `src/cost/index.ts` (the barrel's
// `OAuthUsageResult` re-export), `scripts/cost/weighted-quota-report.ts`, and
// `test/oauth-usage.test.mts` / `test/extra-usage-gate.test.mts` — keep
// resolving unchanged. The canonical owners are now `./oauth-meter-shape.ts`
// (values) and `./types.ts` (types); new code should import directly from there.
export {
  isOAuthUsageOk,
  isOAuthUsageFailure,
  parseOAuthUsageBody,
  parseRetryAfterMs,
  OAUTH_USAGE_URL,
  OAUTH_USAGE_BETA,
} from "./oauth-meter-shape.ts";
export type { OAuthUsageErrorCode, OAuthUsageData, OAuthUsageResult } from "./types.ts";

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
