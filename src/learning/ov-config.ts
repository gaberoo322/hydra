/**
 * learning/ov-config.ts — Single source of truth for OpenViking connection config.
 *
 * Issue #231: Before this module, OPENVIKING_API_KEY had two different default
 * literals across src/ (`1080bb...` in src/api/misc.ts vs `56611b96...` in four
 * other files). The `1080bb...` key returns 401 against the running OV instance;
 * `56611b96...` is the canonical key that matches `.env` and the systemd unit.
 *
 * If the env var ever went missing in production, the dashboard search proxy
 * would diverge from the agent search wrapper — one authenticating, the other
 * silently returning UNAUTHENTICATED. Centralising the constant eliminates that
 * class of drift; the regression test in `test/ov-config.test.mts` enforces
 * "no other literal API keys in src/".
 *
 * Behavior preserved 1:1 — the canonical default is identical to what
 * src/learning/ov-search.ts shipped with before. Callers should import these
 * named exports rather than reading process.env directly.
 */

export const OPENVIKING_URL =
  process.env.OPENVIKING_URL || "http://localhost:1933";

/**
 * Canonical OpenViking API key. The default is intentionally the dev-host key
 * to keep local-first workflows working out of the box; production deployments
 * MUST set OPENVIKING_API_KEY in the environment so that key rotation does not
 * require a code change. The startup warning below makes the fall-through
 * obvious in production logs.
 */
export const OPENVIKING_API_KEY =
  process.env.OPENVIKING_API_KEY ||
  "56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c";

/** Standard headers for OV HTTP calls — pre-built so callers don't re-stringify. */
export const OPENVIKING_HEADERS = {
  "Content-Type": "application/json",
  "X-Api-Key": OPENVIKING_API_KEY,
};

// One-shot startup warning if the env var is missing in production.
// Module-scoped guard so re-imports don't re-warn; tests can re-trigger by
// re-importing after clearing the require cache.
if (
  !process.env.OPENVIKING_API_KEY &&
  process.env.NODE_ENV === "production"
) {
  console.warn(
    "[ov-config] OPENVIKING_API_KEY is not set in production — falling back to compiled-in default. Set it in the environment to silence this warning.",
  );
}
