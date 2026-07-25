/**
 * Regression tests for the shared settled-fold contract (issue #916).
 *
 * Before #916 the "fan sub-reads out under `Promise.allSettled`, and on a
 * rejection log it + degrade to a fallback so the aggregator never throws"
 * contract was copy-pasted as a private `settledOrEmpty` / `settledOr` /
 * `settledOrNull` helper in ten aggregators. The contract was enforced by
 * convention, not by a Module, and the copies had drifted. This is the one
 * test surface that pins the contract now that all ten import it.
 *
 * Covers the three observed shapes:
 *   - settledOrEmpty — degrade `T[]` to `[]` (with the Array.isArray guard)
 *   - settledOr      — degrade `T` to an arbitrary fallback
 *   - settledOrNull  — degrade `T` to `null`
 * plus the core invariant: rejection logs (to the pino structured-logger seam)
 * AND returns the fallback (never throws).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  settle,
  settledOrEmpty,
  settledOr,
  settledOrNull,
  safeSource,
  toDetail,
  type SafeSourceError,
} from "../src/settled-fold.ts";

/** Build a fulfilled PromiseSettledResult without an await. */
function fulfilled<T>(value: T): PromiseSettledResult<T> {
  return { status: "fulfilled", value };
}

/** Build a rejected PromiseSettledResult without an await. */
function rejected<T>(reason: unknown): PromiseSettledResult<T> {
  return { status: "rejected", reason };
}

/**
 * The rejection log now flows through the pino structured-logger seam
 * (module singleton → process.stderr, ADR-0027) instead of a freeform
 * console.error. Capture the serialized JSON lines and assert on the
 * structured `label`/`err`/`msg` fields rather than grepping a format string.
 */
function withCapturedErrors<T>(
  fn: () => T,
): { result: T; calls: Record<string, any>[] } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  try {
    const result = fn();
    const calls = buf
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
    return { result, calls };
  } finally {
    (process.stderr as any).write = originalWrite;
  }
}

/** Render a captured structured log line back to a greppable string. */
function logText(entry: Record<string, any>): string {
  const err = entry.err;
  const reason = err && typeof err === "object" ? err.message ?? err : err;
  return `${entry.msg ?? ""} (${entry.label ?? ""}): ${reason ?? ""}`;
}

describe("settle (core fold)", () => {
  test("fulfilled returns the value and never logs", () => {
    const { result, calls } = withCapturedErrors(() =>
      settle(fulfilled(42), 0, "core/ok"),
    );
    assert.equal(result, 42);
    assert.equal(calls.length, 0);
  });

  test("rejected logs once and returns the fallback (never throws)", () => {
    const { result, calls } = withCapturedErrors(() =>
      settle(rejected(new Error("boom")), 7, "core/fail"),
    );
    assert.equal(result, 7);
    assert.equal(calls.length, 1);
    // The label and the error message both reach the structured log line.
    assert.equal(calls[0]!.label, "core/fail");
    assert.match(logText(calls[0]!), /boom/);
  });

  test("rejected with a non-Error reason logs the raw reason", () => {
    const { result, calls } = withCapturedErrors(() =>
      settle(rejected("plain-string-reason"), "fb", "core/raw"),
    );
    assert.equal(result, "fb");
    assert.match(logText(calls[0]!), /plain-string-reason/);
  });
});

describe("settledOrEmpty", () => {
  test("fulfilled array passes through", () => {
    const { result, calls } = withCapturedErrors(() =>
      settledOrEmpty(fulfilled([1, 2, 3]), "list/ok"),
    );
    assert.deepEqual(result, [1, 2, 3]);
    assert.equal(calls.length, 0);
  });

  test("rejected degrades to [] and logs", () => {
    const { result, calls } = withCapturedErrors(() =>
      settledOrEmpty(rejected<number[]>(new Error("nope")), "list/fail"),
    );
    assert.deepEqual(result, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.label, "list/fail");
  });

  test("fulfilled non-array degrades to [] (the Array.isArray guard)", () => {
    // autopilot-health carried this guard; the other copies did not. The
    // shared module folds it in so a malformed fulfilled value can't be
    // iterated as an array downstream.
    const bad = fulfilled("not-an-array" as unknown as number[]);
    const { result } = withCapturedErrors(() => settledOrEmpty(bad, "list/bad"));
    assert.deepEqual(result, []);
  });
});

describe("settledOr", () => {
  test("fulfilled returns the value", () => {
    const { result, calls } = withCapturedErrors(() =>
      settledOr(fulfilled("yes"), "fallback-val"),
    );
    assert.equal(result, "yes");
    assert.equal(calls.length, 0);
  });

  test("rejected returns the arbitrary fallback and logs", () => {
    const { result, calls } = withCapturedErrors(() =>
      settledOr(rejected(new Error("x")), 0),
    );
    assert.equal(result, 0);
    assert.equal(calls.length, 1);
  });

  test("optional label is included in the log line when provided", () => {
    const { calls } = withCapturedErrors(() =>
      settledOr(rejected(new Error("x")), 0, "cost/usage"),
    );
    assert.equal(calls[0]!.label, "cost/usage");
  });

  test("a falsy fulfilled value is NOT replaced by the fallback", () => {
    // settledOr degrades only on rejection — a legitimately-0 fulfilled
    // value must survive (the overnight-summary `mergeCount: 0` path).
    const { result } = withCapturedErrors(() => settledOr(fulfilled(0), 99));
    assert.equal(result, 0);
  });
});

describe("settledOrNull", () => {
  test("fulfilled returns the value", () => {
    const obj = { autonomy: 0.5 };
    const { result, calls } = withCapturedErrors(() =>
      settledOrNull(fulfilled(obj), "null/ok"),
    );
    assert.equal(result, obj);
    assert.equal(calls.length, 0);
  });

  test("rejected degrades to null and logs", () => {
    const { result, calls } = withCapturedErrors(() =>
      settledOrNull(rejected(new Error("y")), "null/fail"),
    );
    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.label, "null/fail");
  });

  test("fulfilled nullish is coalesced to null", () => {
    const { result } = withCapturedErrors(() =>
      settledOrNull(fulfilled(undefined), "null/nullish"),
    );
    assert.equal(result, null);
  });
});

/**
 * The accumulating-error-provenance variant (issue #3628). Promoted out of
 * `retro-bundle.ts` (where it was private and then re-mirrored a second time in
 * `retro-enrichment.ts`) into the settled-fold family. Unlike `settle*` — which
 * degrade an already-settled `Promise.allSettled` slot into the void — this
 * wraps the ad-hoc async CALL and, on rejection, ALSO pushes a structured
 * `{source, detail}` entry onto a caller-owned `errors[]` array. Tested here
 * directly (no `RetroBundle` fixture) — the leverage the issue calls out.
 *
 * `withCapturedErrors` is synchronous; `safeSource` is async, so this suite
 * captures the pino stderr lines around an `await`.
 */
async function withCapturedErrorsAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: Record<string, any>[] }> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    const calls = buf
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
    return { result, calls };
  } finally {
    (process.stderr as any).write = originalWrite;
  }
}

describe("safeSource (accumulating-error-provenance variant)", () => {
  test("fulfilled read returns the value and accumulates no errors", async () => {
    const errors: SafeSourceError[] = [];
    const { result, calls } = await withCapturedErrorsAsync(() =>
      safeSource("run-record", errors, "fallback", async () => "loaded"),
    );
    assert.equal(result, "loaded");
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 0, "no fail-loud log on success");
  });

  test("rejection returns the fallback, never throws", async () => {
    const errors: SafeSourceError[] = [];
    const { result } = await withCapturedErrorsAsync(() =>
      safeSource<string[]>("friction", errors, [], async () => {
        throw new Error("redis down");
      }),
    );
    assert.deepEqual(result, []);
  });

  test("rejection accumulates a {source, detail} entry onto errors[]", async () => {
    const errors: SafeSourceError[] = [];
    await withCapturedErrorsAsync(() =>
      safeSource("friction", errors, [] as string[], async () => {
        throw new Error("redis down");
      }),
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].source, "friction");
    assert.equal(errors[0].detail, "redis down");
  });

  test("multiple failing sub-sources accumulate onto the SAME shared array (the assembler-binds-once contract)", async () => {
    const errors: SafeSourceError[] = [];
    await safeSource("a", errors, 0, async () => {
      throw new Error("a boom");
    });
    await safeSource("b", errors, 0, async () => {
      throw new Error("b boom");
    });
    await safeSource("c", errors, 0, async () => 42); // succeeds — no entry
    assert.deepEqual(
      errors.map((e) => e.source),
      ["a", "b"],
    );
    assert.deepEqual(
      errors.map((e) => e.detail),
      ["a boom", "b boom"],
    );
  });

  test("rejection emits a fail-loud structured log with the source in context", async () => {
    const errors: SafeSourceError[] = [];
    const { calls } = await withCapturedErrorsAsync(() =>
      safeSource("stuck-signals", errors, null, async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(calls.length, 1);
    const line = logText(calls[0]);
    assert.match(line, /sub-source failed/);
    // Provenance stays in the structured `source` field.
    assert.equal(calls[0].source, "stuck-signals");
    assert.match(String(calls[0].err?.message ?? calls[0].err ?? ""), /boom/);
  });

  test("a non-Error rejection coerces to a string detail (toDetail contract)", async () => {
    const errors: SafeSourceError[] = [];
    await withCapturedErrorsAsync(() =>
      safeSource("weird", errors, null, async () => {
        throw "just a string"; // eslint-disable-line no-throw-literal
      }),
    );
    assert.equal(errors[0].detail, "just a string");
  });
});

describe("toDetail", () => {
  test("extracts .message from an Error", () => {
    assert.equal(toDetail(new Error("kaboom")), "kaboom");
  });

  test("extracts .message from a plain object carrying a string message", () => {
    assert.equal(toDetail({ message: "structured" }), "structured");
  });

  test("String-coerces a value with no string .message", () => {
    assert.equal(toDetail(42), "42");
    assert.equal(toDetail("bare"), "bare");
    assert.equal(toDetail({ message: 5 }), "[object Object]");
  });
});
