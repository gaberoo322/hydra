/**
 * Shared query-param schemas for GET read routes (ADR-0022, slice 1).
 *
 * ADR-0022 brought `req.query` validation into the **Schemas** Seam for GET
 * read routes: every handler that reads `req.query` reads it through a
 * `src/schemas/*` zod schema, never via raw `parseInt(req.query.x)`. This
 * module is the "one home for the repeated coercion" the ADR calls for — the
 * two idioms duplicated across ~18 routers:
 *
 *   1. `parseInt(req.query.count) || N`   → `countQuerySchema(defaultN)`
 *   2. `req.query.flag === "1"|"true"`    → `booleanFlag(defaultValue?)`
 *
 * Both helpers are deliberately **lenient on bad input** rather than rejecting
 * it with a 400: the legacy idioms they replace silently fell back to a default
 * (`parseInt("abc") || 20 === 20`), and the read surfaces that consume them
 * (metrics trends, paged lists) treat a garbled query as "give me the default
 * window", never as a client error. Migrating to a `safeParse` that suddenly
 * 400s on `?count=abc` would be a behaviour regression on a read route. So the
 * coercion `.catch(...)`es back to the default, and the route reads a typed,
 * always-present field off the parsed result — the Seam value (schema = type,
 * one pattern) without the behaviour change.
 *
 * Routes whose error handling IS bespoke (a hard 400, or a "never 500"
 * 200-empty fallback) still `safeParse` inline and own their response, exactly
 * as ADR-0011 lets body routes own theirs.
 */

import { z } from "zod";

/**
 * Factory for the `?count=N` query idiom (`parseInt(req.query.count) || N`).
 *
 * Returns a non-strict object schema with a single `count` field that:
 *   - coerces the wire string to a number,
 *   - floors to an integer and clamps to `[1, max]` (default cap 1000 — large
 *     enough that no current caller is constrained, small enough to stop an
 *     unbounded slice request),
 *   - falls back to `defaultN` on a missing, non-numeric, or out-of-range
 *     value (preserving the legacy `|| N` default-on-garbage behaviour).
 *
 * Non-strict (`.passthrough()`-equivalent: a plain object schema ignores
 * unknown keys) so a route carrying additional query params can still parse
 * its `count` through this factory without tripping on the others.
 *
 * @param defaultN  The default count when the param is absent or invalid.
 * @param max       The upper clamp (inclusive). Defaults to 1000.
 */
export function countQuerySchema(defaultN: number, max = 1000) {
  const defaultClamped = Math.min(Math.max(Math.trunc(defaultN), 1), max);
  return z.object({
    count: z.coerce
      .number()
      .transform((n) => Math.trunc(n))
      .pipe(z.number().int().min(1).max(max))
      // Any failure (NaN from a non-numeric string, < 1, > max, or the param
      // being absent) collapses to the default — the `|| N` semantics.
      .catch(defaultClamped)
      .default(defaultClamped),
  });
}

/**
 * Boolean-flag coercion for the `?flag=1` / `?flag=true` query idiom.
 *
 * Truthy wire values (case-insensitive): `"1"`, `"true"`, `"yes"`, `"on"`.
 * Everything else — including a missing param, `"0"`, `"false"`, or any
 * other string — is `false` unless `defaultValue` overrides the absent case.
 *
 * Returns a zod schema you compose into a route's query object, e.g.:
 *
 *   const Q = z.object({
 *     excludeMerged: booleanFlag(),
 *     count: countQuerySchema(50).shape.count,
 *   });
 *
 * @param defaultValue  Value when the param is `undefined` (absent). Default false.
 */
export function booleanFlag(defaultValue = false) {
  // `.optional()` so an absent key in the parent object (which zod surfaces as
  // `undefined`) reaches the transform rather than tripping a "Required" error;
  // the transform then applies `defaultValue` for the absent/undefined case.
  return z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultValue;
      if (typeof v === "boolean") return v;
      const s = v.trim().toLowerCase();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    });
}
