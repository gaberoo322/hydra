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
 */

/** Format the fail-loud log line for a rejected sub-read. */
function rejectionMessage(label: string, reason: unknown): string {
  const detail =
    (reason as { message?: string } | null | undefined)?.message ?? reason;
  return `[aggregators] sub-source failed (${label}): ${detail}`;
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
  console.error(rejectionMessage(label, result.reason));
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
  console.error(rejectionMessage(label, result.reason));
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
  console.error(rejectionMessage(label, result.reason));
  return null;
}
