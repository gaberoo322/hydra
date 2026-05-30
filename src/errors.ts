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
  | "gate-invariant";

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
