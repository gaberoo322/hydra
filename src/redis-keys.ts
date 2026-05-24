/**
 * DEPRECATED — re-export shim. Import from `./redis/keys.ts` instead.
 *
 * The original file moved to `src/redis/keys.ts` in ADR-0009 slice 6.
 * This shim survives for the back-compat tail (currently 26 caller files).
 * New code MUST NOT import from this path — `scripts/ci/redis-seam-check.ts`
 * blocks it via a baseline ratchet that only shrinks.
 *
 * Even imports from `src/redis/keys.ts` are restricted to files inside
 * `src/redis/`; everything else routes via a typed accessor in one of
 * the `src/redis/<domain>.ts` modules. See ADR-0009 for the closure plan.
 */

export { redisKeys } from "./redis/keys.ts";
