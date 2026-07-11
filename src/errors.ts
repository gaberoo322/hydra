/**
 * Typed-error taxonomy for the Hydra orchestrator (issue #756).
 *
 * Every error here is a real subclass of the native `Error`: `instanceof`
 * (base + subclass), a stable `name`, a populated `stack`, and a stable,
 * machine-readable `code` field. Callers and tests discriminate on
 * `err.code` (or `err instanceof <SubClass>`) instead of regexing
 * `err.message` — the same legibility win zod's `{ code:
 * "schema-validation-failed" }` boundary errors gave us in #562.
 *
 * Why no runtime dependency: the scouted `ts-custom-error` package exists to
 * repair the `Object.setPrototypeOf` / `instanceof` breakage that only occurs
 * when TypeScript downlevels `class extends Error` to ES5 functions. The
 * orchestrator compiles to `target: ES2022` on Node 22, where native
 * subclassing of `Error` works correctly — prototype chain, `instanceof`, and
 * `name` all behave. Adding the package would trip the ADR-0005
 * operator-approved-only dependency gate for no benefit. The sibling
 * `neverthrow` proposal (#755) was closed `wontfix`, so the codebase keeps
 * `throw` for genuinely-exceptional sites and makes the thrown value
 * machine-readable here.
 *
 * Additive contract: this module adds a taxonomy; it does NOT rewrite existing
 * `throw new Error(...)` sites. Those migrate opportunistically onto the typed
 * class when an agent next touches them. Note: do NOT throw these from
 * merge / grounding / verification code — those return result objects per the
 * CLAUDE.md "never throw from merge/grounding/verification" rule. Use this
 * taxonomy at boundary guards, invariant checks, and seam violations.
 */

/**
 * The canonical machine-readable error-code vocabulary. Each subclass binds a
 * fixed literal from this union. Add a new member here (and a subclass below)
 * when a genuinely new failure family appears — never reuse a code across two
 * unrelated families, and never widen a subclass's code beyond a single
 * literal.
 */
export type HydraErrorCode =
  | "invalid-argument"
  | "out-of-range"
  | "invariant-violation"
  | "not-found"
  | "redis-seam"
  | "untouchable-path"
  | "gate-invariant"
  // GitHub CLI Adapter (src/github/) result-object codes (issue #896).
  // These are NEVER thrown — the seam never throws (CLAUDE.md). They appear
  // only on the failure arm of the `{ ok:false; code; stderr }` result so
  // callers discriminate on `result.code` instead of regexing stderr prose.
  // No `GhSeamError` subclass exists by design: the seam returns, never raises.
  | "gh-not-installed" // the gh/git binary is not on PATH (spawn ENOENT)
  | "gh-auth-failed" // gh ran but reported an auth/permission failure
  | "gh-rate-limited" // GitHub reported an API rate-limit / secondary-limit / rate_limit_error (issue #3137)
  | "gh-empty" // the command produced no stdout where output was required
  | "gh-malformed-json" // --json output failed to JSON.parse
  | "gh-timeout" // the command exceeded its timeout and was killed
  | "gh-failed" // gh/git exited non-zero for any other reason
  // Host-Probe Adapter (src/host-probe/) result-object codes (issue #939).
  // The sibling Seam to the GitHub CLI Adapter for the host-info binaries
  // (df/free/systemctl). Same never-throw discipline: these literals appear
  // only on the failure arm of the host-probe `{ ok:false; code }` result, so
  // /api/health/deep discriminates on a code instead of the old
  // `.catch(() => null)` / `.catch(() => "unknown")` sentinel. No thrown
  // subclass — the adapter returns, never raises.
  | "host-probe-not-installed" // the host binary is not on PATH (spawn ENOENT)
  | "host-probe-timeout" // the probe exceeded its timeout and was killed
  | "host-probe-empty" // the probe exited 0 but produced no parseable output
  | "host-probe-failed" // the host binary exited non-zero for any other reason
  // Journal Adapter (src/journal/) result-object codes (issue #1958). The
  // fourth process Seam — sibling to the GitHub CLI Adapter and Host-Probe
  // Adapter, over the `journalctl` boundary. Same never-throw discipline: these
  // literals appear only on the failure arm of the JournalResult
  // `{ ok:false; code }`. A truncated/timed-out run is NOT a failure (the slice
  // accessor returns the captured partial text on the success arm) — these
  // codes only fire when the spawn itself fails. No thrown subclass — the
  // adapter returns, never raises.
  | "journal-spawn-failed" // journalctl could not be spawned (ENOENT / synchronous throw / error event)
  | "journal-timeout" // the spawn exceeded its timeout and was killed
  | "journal-truncated" // the spawn hit the 1 MB output cap and was killed
  // OpenViking Request Adapter (src/knowledge-base/ov-request.ts) result-object
  // codes (issue #954). The fourth boundary Seam — sibling to the GitHub CLI
  // Adapter and Host-Probe Adapter, but over fetch() not child_process. Same
  // never-throw discipline: these literals appear only on the failure arm of the
  // OvResult `{ ok:false; code }`, so callers (trackedOvSearch, the upload/skill
  // helpers, the work-queue dedup, the /health probes) discriminate on a code
  // instead of regexing fetch error prose. No thrown subclass — the adapter
  // returns, never raises.
  | "ov-service-down" // the request never reached OV (DNS/ECONNREFUSED/network)
  | "ov-non-2xx" // OV answered but with a non-2xx status (!res.ok)
  | "ov-malformed-json" // a 2xx body failed to JSON.parse
  | "ov-timeout" // the request exceeded its AbortSignal timeout and was aborted
  // OAuth Usage Adapter (src/cost/oauth-usage.ts) result-object codes (issue
  // #1083). The fifth boundary Seam — sibling to the OpenViking Request Adapter,
  // also over fetch(), reading the authoritative server-side subscription-usage
  // meter that rebases the Subscription Usage Tracker's headline + 5h
  // emergencyStop. Same never-throw discipline: these literals appear only on
  // the failure arm of the OAuthUsageResult `{ ok:false; code }`. CRITICAL: a
  // failure code makes the tracker FALL BACK to its transcript estimate — it is
  // NEVER read as 0% utilization (which would wrongly unblock dispatch during an
  // outage). No thrown subclass — the adapter returns, never raises.
  | "oauth-usage-no-credentials" // no credentials file / no claudeAiOauth.accessToken
  | "oauth-usage-token-expired" // the endpoint reported 401/403 (token expired/revoked)
  | "oauth-usage-rate-limited" // the endpoint reported 429; the optional Retry-After hint rides the failure arm (issue #2666)
  | "oauth-usage-non-2xx" // the endpoint answered with a non-2xx status other than 401/403/429
  | "oauth-usage-parse" // a 2xx body failed JSON.parse OR was missing a usable window
  | "oauth-usage-timeout" // the request exceeded its AbortSignal timeout and was aborted
  | "oauth-usage-network" // transport failed (DNS/ECONNREFUSED/offline)
  // Anthropic Request Adapter (src/anthropic/request.ts) result-object codes
  // (issue #1959). The sixth boundary Seam — sibling to the OpenViking Request
  // Adapter and the OAuth Usage Adapter, also over fetch(), owning the Anthropic
  // Messages API request boundary (URL, anthropic-version header, ANTHROPIC_API_KEY
  // resolution, AbortSignal timeout discipline — the gap the old inline
  // defaultLlmClient had — error classification, token-usage + USD cost
  // derivation). Same never-throw discipline: these literals appear only on the
  // failure arm of the AnthropicResult `{ ok:false; code }`, so the recommendation
  // engine maps a failure to an inert no-op instead of regexing fetch error prose.
  // No thrown subclass — the adapter returns, never raises.
  | "anthropic-no-api-key" // no ANTHROPIC_API_KEY configured (engine stays inert)
  | "anthropic-non-2xx" // the API answered with a non-2xx status (!res.ok)
  | "anthropic-malformed-json" // a 2xx body failed to JSON.parse
  | "anthropic-timeout" // the request exceeded its AbortSignal timeout and was aborted
  | "anthropic-network-error"; // transport failed (DNS/ECONNREFUSED/offline)

/**
 * Base class for all Hydra typed errors. Carries a stable `code` and sets
 * `name` from the concrete subclass via `new.target.name`, so a subclass does
 * not have to repeat its own name. `stack` is populated by the `super(message)`
 * call, as for any native `Error`.
 */
export class HydraError extends Error {
  /** Stable, machine-readable discriminator. Prefer this over message-matching. */
  readonly code: HydraErrorCode;

  constructor(code: HydraErrorCode, message: string) {
    super(message);
    // `new.target` is the constructor actually invoked (the leaf subclass),
    // so `name` reflects the concrete class without each subclass repeating it.
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * An argument failed a boundary guard (wrong type, missing required field).
 * The typed analogue of the many `throw new TypeError("... required")` sites
 * in src/scout and src/pattern-memory.
 */
export class InvalidArgumentError extends HydraError {
  constructor(message: string) {
    super("invalid-argument", message);
  }
}

/**
 * A numeric or enumerated argument was outside its allowed range/set. The
 * typed analogue of `throw new RangeError(...)` sites.
 */
export class OutOfRangeError extends HydraError {
  constructor(message: string) {
    super("out-of-range", message);
  }
}

/**
 * An internal invariant was violated — a "this should never happen" guard,
 * e.g. using a subsystem before it was initialized.
 */
export class InvariantViolationError extends HydraError {
  constructor(message: string) {
    super("invariant-violation", message);
  }
}

/**
 * A required entity (artifact, anchor, record) did not exist where the caller
 * required it to. For genuinely-exceptional lookups only — silent `false` /
 * `null` returns remain the right pattern for expected misses.
 */
export class NotFoundError extends HydraError {
  constructor(message: string) {
    super("not-found", message);
  }
}

/**
 * A Redis-seam invariant was violated — e.g. a raw `new Redis()` connection
 * created outside `src/redis/`, which ADR-0009 forbids. Lets a test assert
 * `err instanceof RedisSeamError` instead of parsing the seam-check prose.
 */
export class RedisSeamError extends HydraError {
  constructor(message: string) {
    super("redis-seam", message);
  }
}

/**
 * An attempt was made to mutate an Untouchable-Core / protected path (ADR-0001)
 * outside the operator-approved path.
 */
export class UntouchablePathError extends HydraError {
  constructor(message: string) {
    super("untouchable-path", message);
  }
}

/**
 * A merge-gate / tier-classifier invariant was violated (e.g. a tier-0 change
 * without the operator-approved label reaching a code path that requires it).
 * Note the never-throw-from-merge rule still applies to the gate's own happy
 * path — this is for invariant breaches the gate must surface as exceptional.
 */
export class GateInvariantError extends HydraError {
  constructor(message: string) {
    super("gate-invariant", message);
  }
}
