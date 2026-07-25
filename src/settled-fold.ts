/**
 * Settled-fold contract — a cross-cutting async utility (issues #916, #3216).
 *
 * The contract: fan a set of sub-reads out under `Promise.allSettled`, and on
 * a *rejected* sub-read log it (CLAUDE.md fail-loud) and degrade that slice to
 * a fallback so the composing read itself never throws. A single slow `gh`
 * call can't blank the whole result.
 *
 * This is a *general* async utility — "degrade a `Promise.allSettled` slice to
 * a safe fallback while logging the rejection" — that belongs to no specific
 * domain. It lives at the flat `src/` root (alongside `src/errors.ts`) so any
 * module with a multi-source fan-out can import it without reaching across a
 * group boundary: dashboard aggregators (`src/aggregators/`), the autopilot
 * status composition seam (`src/autopilot/status.ts`), `src/review-pickup.ts`,
 * and any future caller. It was originally namespaced under `src/aggregators/`
 * (#916) because the ten aggregators were its first callers; #3216 relocated
 * it to the root since the fold is not an aggregators-domain concept and
 * migrated every caller to import from here directly (no back-compat shim —
 * the aggregators-namespaced re-export was dead-on-arrival and removed).
 *
 * The originating copy-paste problem (#916): the same fold was independently
 * redeclared as a private `settledOrEmpty<T>` / `settledOr<T>` /
 * `settledOrNull<T>` helper in ten aggregators, each re-deciding the log
 * format and the `Array.isArray` defensiveness. The copies had already
 * drifted — `autopilot-health` added an `Array.isArray` guard the others
 * lacked; some logs carried a `(${label})` suffix, some didn't; one variant
 * swallowed `result.value ?? null`.
 *
 * This module is the single home for that fold. The three observed shapes
 * are the same fold parameterised by fallback:
 *
 *   - {@link settledOrEmpty} — degrade a `T[]` sub-read to `[]`
 *     (with the `Array.isArray` guard that `autopilot-health` had and the
 *     others lacked — defensiveness folded in, not forked out).
 *   - {@link settledOr}      — degrade a `T` sub-read to an arbitrary fallback.
 *   - {@link settledOrNull}  — degrade a `T` sub-read to `null`.
 *
 * All three route through {@link settle}, so the "never throws / always logs"
 * contract has one referent and one test surface
 * (`test/aggregator-settle.test.mts`).
 *
 * The fourth shape — {@link safeSource} — is the **accumulating-error-provenance**
 * variant of the same never-throw family (issue #3628). Where `settle*` degrade
 * an *already-settled* `Promise.allSettled` slot into the void (log + fallback,
 * no trace), `safeSource` wraps the ad-hoc async CALL itself and, on rejection,
 * ALSO pushes a structured `{source, detail}` entry onto a caller-owned
 * `errors[]` array — so a multi-source assembler can surface *which* sub-sources
 * degraded rather than only logging them. It was promoted here from
 * `src/autopilot/retro-bundle.ts`, where it had been re-implemented privately
 * and then re-mirrored (as a bare type) a second time in
 * `src/autopilot/retro-enrichment.ts` after a single release cycle — the exact
 * copy-paste-drift pattern this module exists to end. It lives alongside
 * `settle*` because it is the same "sub-source fails → log + degrade to
 * fallback" contract; only the error-accumulation differs.
 */

import { logger } from "./logger.ts";

/** Emit the fail-loud structured log line for a rejected sub-read. */
function logRejection(label: string, reason: unknown): void {
  logger.error({ label, err: reason }, "[aggregators] sub-source failed");
}

/**
 * The core fold: on `fulfilled` return the value, on `rejected` log the
 * reason and return `fallback`. Every public helper delegates here so the
 * degrade-and-log behaviour is defined exactly once.
 */
export function settle<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  label: string,
): T {
  if (result.status === "fulfilled") return result.value;
  logRejection(label, result.reason);
  return fallback;
}

/**
 * Degrade a list-valued sub-read to `[]` on rejection.
 *
 * Also guards against a `fulfilled` value that isn't actually an array
 * (the defensiveness `autopilot-health` carried and its siblings lacked) —
 * a non-array `fulfilled` value degrades to `[]` rather than propagating a
 * shape the caller will iterate over.
 */
export function settledOrEmpty<T>(
  result: PromiseSettledResult<T[]>,
  label: string,
): T[] {
  if (result.status === "fulfilled") {
    return Array.isArray(result.value) ? result.value : [];
  }
  logRejection(label, result.reason);
  return [];
}

/**
 * Degrade a sub-read to an arbitrary `fallback` on rejection.
 *
 * The `label` is optional so the two historical call shapes
 * (`overnight-summary` passed no label; `cost-burn` passed one) collapse
 * onto a single signature. When omitted, the log line reports the fallback
 * site generically.
 */
export function settledOr<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  label = "fallback",
): T {
  return settle(result, fallback, label);
}

/**
 * Degrade a sub-read to `null` on rejection.
 *
 * A `fulfilled` value is coalesced to `null` when nullish, matching the
 * `result.value ?? null` shape `autopilot-health` used (and folding in the
 * `null`-coalescing that `builder-health` relied on the value already being
 * present for).
 */
export function settledOrNull<T>(
  result: PromiseSettledResult<T>,
  label: string,
): T | null {
  if (result.status === "fulfilled") return result.value ?? null;
  logRejection(label, result.reason);
  return null;
}

// ---------------------------------------------------------------------------
// safeSource — the accumulating-error-provenance variant (issue #3628)
// ---------------------------------------------------------------------------

/**
 * One sub-source that failed to load — surfaced (accumulated) instead of
 * thrown. Caller-agnostic shape: `{source, detail}`. Promoted from
 * `retro-bundle.ts`'s private `RetroBundleError` so the retro bundle's served
 * `errors[]` JSON stays byte-identical while the type has a single home.
 */
export interface SafeSourceError {
  /** Stable, machine-readable source name, e.g. `"run-record"`, `"friction"`. */
  source: string;
  /** The error message (best-effort string coercion). */
  detail: string;
}

/** Best-effort string coercion of a thrown value's `.message` (else `String`). */
export function toDetail(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/**
 * Run a sub-source reader under the never-throw contract WITH structured error
 * provenance (issue #3628). On rejection: log the failure (CLAUDE.md fail-loud),
 * push a `{source, detail}` entry onto the caller-owned `errors` array, and
 * return `fallback`. Never throws.
 *
 * This is the "accumulating errors" sibling of {@link settledOr} et al.: those
 * degrade an already-settled `Promise.allSettled` slot into the void; this wraps
 * the ad-hoc async CALL and records *which* source degraded so a composing
 * assembler can surface a partial-result trace (`bundle.errors[]`) rather than
 * only logging the rejection.
 *
 * The `errors` array is caller-owned and mutated in place, so a multi-source
 * assembler can bind one array once (`(source, fallback, fn) => safeSource(source, errors, fallback, fn)`)
 * and thread the bound closure into sub-coordinators — they accumulate onto the
 * same array without ever touching it directly.
 */
export async function safeSource<T>(
  source: string,
  errors: SafeSourceError[],
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = toDetail(err);
    logger.error({ source, err }, "[settled-fold] sub-source failed");
    errors.push({ source, detail });
    return fallback;
  }
}

/**
 * The {@link safeSource} closure a multi-source assembler passes DOWN to its
 * sub-coordinators — {@link safeSource} with the `errors[]` argument already
 * bound: `(source, fallback, fn) => Promise<T>`.
 *
 * A composing assembler binds its own `errors[]` once
 * (`(source, fallback, fn) => safeSource(source, errors, fallback, fn)`) and
 * threads THIS closure into a sub-coordinator (e.g. `retro-enrichment`'s
 * `enrichDispatchesWithCycleData`), so the sub-coordinator accumulates onto the
 * assembler's array without ever touching it directly. Promoted from
 * `retro-enrichment.ts`, which previously re-declared this exact type as a
 * local `SafeSource` that explicitly mirrored the assembler's private helper
 * (issue #3628).
 */
export type BoundSafeSource = <T>(
  source: string,
  fallback: T,
  fn: () => Promise<T>,
) => Promise<T>;
