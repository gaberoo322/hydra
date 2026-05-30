/**
 * Regression test for the typed-error taxonomy (issue #756).
 *
 * The scouted `ts-custom-error` dependency exists to repair `instanceof` /
 * prototype-chain breakage that ONLY happens when TypeScript downlevels
 * `class extends Error` to ES5. We compile to ES2022 on Node 22, where native
 * subclassing works — so src/errors.ts is dependency-free. These tests pin the
 * four properties ts-custom-error would have provided so a future tsconfig
 * `target` regression (or an accidental dep) is caught:
 *
 *   1. `instanceof` holds for both the subclass AND the HydraError base AND
 *      the native Error.
 *   2. `name` equals the concrete subclass name (via `new.target.name`).
 *   3. `code` is the stable machine-readable literal bound to that subclass.
 *   4. `stack` is populated and contains the subclass name.
 *
 * Pure module — no Redis, no I/O.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  HydraError,
  InvalidArgumentError,
  OutOfRangeError,
  InvariantViolationError,
  NotFoundError,
  RedisSeamError,
  UntouchablePathError,
  GateInvariantError,
  type HydraErrorCode,
} from "../src/errors.ts";

/** Every subclass paired with its expected stable code. */
const SUBCLASSES: Array<{
  Ctor: new (message: string) => HydraError;
  name: string;
  code: HydraErrorCode;
}> = [
  { Ctor: InvalidArgumentError, name: "InvalidArgumentError", code: "invalid-argument" },
  { Ctor: OutOfRangeError, name: "OutOfRangeError", code: "out-of-range" },
  { Ctor: InvariantViolationError, name: "InvariantViolationError", code: "invariant-violation" },
  { Ctor: NotFoundError, name: "NotFoundError", code: "not-found" },
  { Ctor: RedisSeamError, name: "RedisSeamError", code: "redis-seam" },
  { Ctor: UntouchablePathError, name: "UntouchablePathError", code: "untouchable-path" },
  { Ctor: GateInvariantError, name: "GateInvariantError", code: "gate-invariant" },
];

describe("typed-error taxonomy (issue #756)", () => {
  for (const { Ctor, name, code } of SUBCLASSES) {
    describe(name, () => {
      const err = new Ctor(`${name} boom`);

      test("instanceof holds for subclass, HydraError base, and native Error", () => {
        assert.ok(err instanceof Ctor, "instanceof own subclass");
        assert.ok(err instanceof HydraError, "instanceof HydraError base");
        assert.ok(err instanceof Error, "instanceof native Error");
      });

      test("name equals the concrete subclass name", () => {
        assert.equal(err.name, name);
      });

      test("code is the stable machine-readable literal", () => {
        assert.equal(err.code, code);
      });

      test("message round-trips", () => {
        assert.equal(err.message, `${name} boom`);
      });

      test("stack is populated and contains the subclass name", () => {
        assert.ok(typeof err.stack === "string" && err.stack.length > 0, "stack populated");
        assert.ok(err.stack!.includes(name), `stack mentions ${name}`);
      });
    });
  }

  test("every subclass binds a distinct code", () => {
    const codes = SUBCLASSES.map((s) => s.code);
    assert.equal(new Set(codes).size, codes.length, "no two subclasses share a code");
  });

  test("a HydraError can be discriminated by code without message-matching", () => {
    function classify(err: unknown): HydraErrorCode | "unknown" {
      return err instanceof HydraError ? err.code : "unknown";
    }
    assert.equal(classify(new RedisSeamError("raw new Redis() outside src/redis/")), "redis-seam");
    assert.equal(classify(new TypeError("native")), "unknown");
    assert.equal(classify("not an error"), "unknown");
  });

  test("HydraError base is itself a usable, code-bearing Error", () => {
    const e = new HydraError("invariant-violation", "base used directly");
    assert.ok(e instanceof Error);
    assert.equal(e.name, "HydraError");
    assert.equal(e.code, "invariant-violation");
  });
});
