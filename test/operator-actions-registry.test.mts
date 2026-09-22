/**
 * Operator-action registry tests (issue #4620, ADR-0034 §8.2 — slice 1 of the
 * guidance-epic #4619).
 *
 * Four layers, mirroring the design-concept artifact's acceptance criteria:
 *
 *   1. The shipped `REGISTRY` — loads without throwing (fail-loud-at-import,
 *      mirroring `test/taxonomy-classes.test.mts`'s precedent for
 *      `src/taxonomy/classes.ts`) and both drift assertions return `[]`.
 *   2. `missingDefaultLines` / `outOfContextPlaceholders` — the two pure
 *      helpers acceptance criterion 3 requires be able to FAIL, driven both
 *      against the real REGISTRY (expect `[]`) and synthetic fixtures
 *      (expect the offending key/placeholder) per the design-concept
 *      artifact's explicit instruction.
 *   3. `OperatorActionEntrySchema` / `ActionSchema` / `OperatorActionRegistrySchema`
 *      shape rejections the mutation-kill-rate gate expects: `.strict()`
 *      extra-field rejection, 1- and 3-alternative rejection, unknown-`kind`
 *      rejection, unknown `<bucket>:<line>` key rejection, and the
 *      duplicate-`(key, variant)` superRefine.
 *   4. `GET /operator-actions` — the route handler called directly (the
 *      `test/taxonomy-route.test.mts` pattern: no live Express server, no
 *      Redis), asserting 200 + every entry validates against the schema.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { InvariantViolationError } from "../src/errors.ts";
import {
  ADMISSION_LINE_KEYS,
  ActionSchema,
  OperatorActionEntrySchema,
  OperatorActionRegistrySchema,
  OperatorActionsResponseSchema,
  type OperatorActionEntryInput,
} from "../src/schemas/operator-actions.ts";
import {
  REGISTRY,
  validateRegistry,
  missingDefaultLines,
  outOfContextPlaceholders,
} from "../src/operator-actions/registry.ts";
import { createOperatorActionsRouter } from "../src/api/operator-actions.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function terminalAction(label: string, command = "/hydra-review") {
  return {
    kind: "terminal-skill" as const,
    command,
    label,
    preconditions: [] as string[],
    consequence: `does something for ${label}`,
  };
}

function validEntry(
  key: string,
  overrides: Partial<OperatorActionEntryInput> = {},
): OperatorActionEntryInput {
  return {
    key,
    recommended: terminalAction("Recommended"),
    alternatives: [terminalAction("Alt 1"), terminalAction("Alt 2")],
    rationale: "because a synthetic fixture needs one",
    doc: "docs/operator-playbooks/hydra-review.md",
    ...overrides,
  } as OperatorActionEntryInput;
}

// ---------------------------------------------------------------------------
// 1. The shipped REGISTRY
// ---------------------------------------------------------------------------

describe("REGISTRY — the shipped table (issue #4620)", () => {
  test("loads (import-time validateRegistry did not throw) with one entry per admission line", () => {
    assert.equal(REGISTRY.length, ADMISSION_LINE_KEYS.length);
  });

  test("re-parses cleanly against the schema (belt-and-braces on the frozen export)", () => {
    const parsed = OperatorActionRegistrySchema.safeParse(REGISTRY);
    assert.equal(parsed.success, true);
  });

  test("ships ZERO class:<name> entries (slice 17 authors those)", () => {
    assert.equal(
      REGISTRY.filter((e) => e.key.startsWith("class:")).length,
      0,
    );
  });

  test("assertion (a): missingDefaultLines(REGISTRY) is empty", () => {
    assert.deepEqual(missingDefaultLines(REGISTRY), []);
  });

  test("assertion (d): outOfContextPlaceholders(REGISTRY) is empty", () => {
    assert.deepEqual(outOfContextPlaceholders(REGISTRY), []);
  });
});

// ---------------------------------------------------------------------------
// 2. missingDefaultLines — pure helper, both directions
// ---------------------------------------------------------------------------

describe("missingDefaultLines — pure helper (assertion a)", () => {
  test("[] on a complete synthetic registry (pass direction)", () => {
    const entries = validateRegistry(ADMISSION_LINE_KEYS.map((key) => validEntry(key)));
    assert.deepEqual(missingDefaultLines(entries), []);
  });

  test("flags an admission line with no entry at all (fail direction)", () => {
    const entries = validateRegistry(
      ADMISSION_LINE_KEYS.filter((key) => key !== "repetition:hits").map((key) =>
        validEntry(key),
      ),
    );
    assert.deepEqual(missingDefaultLines(entries), ["repetition:hits"]);
  });

  test("still flags a line whose only entry carries a variant (a default is required)", () => {
    const withoutLine = ADMISSION_LINE_KEYS.filter((key) => key !== "repetition:hits").map(
      (key) => validEntry(key),
    );
    const entries = validateRegistry([
      ...withoutLine,
      validEntry("repetition:hits", { variant: "triage-origin" }),
    ]);
    assert.deepEqual(missingDefaultLines(entries), ["repetition:hits"]);
  });
});

// ---------------------------------------------------------------------------
// 3. outOfContextPlaceholders — pure helper, both directions
// ---------------------------------------------------------------------------

describe("outOfContextPlaceholders — pure helper (assertion d)", () => {
  test("[] when no template uses a placeholder (pass direction)", () => {
    const entries = validateRegistry([validEntry("repetition:hits")]);
    assert.deepEqual(outOfContextPlaceholders(entries), []);
  });

  test("[] for an in-context placeholder on a per-item bucket (pass direction)", () => {
    const entries = validateRegistry([
      validEntry("waiting-on-you:needs-info", {
        recommended: terminalAction("Recommended", "gh issue view {number} --repo {repo}"),
      }),
    ]);
    assert.deepEqual(outOfContextPlaceholders(entries), []);
  });

  test("flags a placeholder outside an aggregate bucket's empty context (fail direction)", () => {
    const entries = validateRegistry([
      validEntry("repetition:hits", {
        recommended: terminalAction("Recommended", "gh issue view {number}"),
      }),
    ]);
    assert.deepEqual(outOfContextPlaceholders(entries), [
      { key: "repetition:hits", placeholder: "number" },
    ]);
  });

  test("flags an out-of-context placeholder in an ALTERNATIVE, not just recommended", () => {
    const entries = validateRegistry([
      validEntry("parked-over-cap:cap", {
        alternatives: [terminalAction("Alt 1", "gh pr view {number}"), terminalAction("Alt 2")],
      }),
    ]);
    assert.deepEqual(outOfContextPlaceholders(entries), [
      { key: "parked-over-cap:cap", placeholder: "number" },
    ]);
  });

  test("checks in-dashboard `route` templates too, not only terminal-skill `command`", () => {
    const entries = validateRegistry([
      validEntry("machine-stopped:paused", {
        recommended: {
          kind: "in-dashboard",
          route: "/things/{number}",
          method: "POST",
          confirmTier: "confirm-first",
          label: "Bad route",
          preconditions: [],
          consequence: "x",
        },
      }),
    ]);
    assert.deepEqual(outOfContextPlaceholders(entries), [
      { key: "machine-stopped:paused", placeholder: "number" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. validateRegistry — fail loud at import
// ---------------------------------------------------------------------------

describe("validateRegistry — fail-loud contract (issue #4620)", () => {
  test("throws InvariantViolationError (code invariant-violation) on a schema violation", () => {
    assert.throws(
      () => validateRegistry([validEntry("repetition:hits", { rationale: "" })]),
      (err: unknown) =>
        err instanceof InvariantViolationError &&
        (err as InvariantViolationError).code === "invariant-violation",
    );
  });

  test("throws on an unknown <bucket>:<line> key", () => {
    assert.throws(
      () => validateRegistry([validEntry("machine-stopped:not-a-real-line")]),
      (err: unknown) => err instanceof InvariantViolationError,
    );
  });

  test("throws on a duplicate (key, variant) slot", () => {
    assert.throws(
      () =>
        validateRegistry([validEntry("repetition:hits"), validEntry("repetition:hits")]),
      (err: unknown) => err instanceof InvariantViolationError,
    );
  });

  test("does NOT throw on a valid registry (pass direction)", () => {
    assert.doesNotThrow(() => validateRegistry([validEntry("repetition:hits")]));
  });
});

// ---------------------------------------------------------------------------
// 5. Schema-shape rejections (mutation kill-rate coverage)
// ---------------------------------------------------------------------------

describe("OperatorActionEntrySchema — .strict() + shape rejections", () => {
  test("rejects an unknown extra field", () => {
    const entry = { ...validEntry("repetition:hits"), extra: "nope" };
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, false);
  });

  test("rejects an alternatives tuple of length 1", () => {
    const entry = validEntry("repetition:hits", {
      alternatives: [terminalAction("Only one")] as any,
    });
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, false);
  });

  test("rejects an alternatives tuple of length 3", () => {
    const entry = validEntry("repetition:hits", {
      alternatives: [
        terminalAction("One"),
        terminalAction("Two"),
        terminalAction("Three"),
      ] as any,
    });
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, false);
  });

  test("accepts an alternatives tuple of exactly 2 (pass direction)", () => {
    const entry = validEntry("repetition:hits");
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, true);
  });

  test("rejects an unrecognised <bucket>:<line> key", () => {
    const entry = validEntry("machine-stopped:not-a-real-line");
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, false);
  });

  test("accepts a class:<name> key (namespace reserved, zero entries shipped)", () => {
    const entry = validEntry("class:dev_orch");
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, true);
  });

  test("rejects a malformed class:<name> key (uppercase)", () => {
    const entry = validEntry("class:DevOrch");
    assert.equal(OperatorActionEntrySchema.safeParse(entry).success, false);
  });
});

describe("ActionSchema — discriminated union over the six closed kinds", () => {
  test("rejects an unknown kind", () => {
    const bad = { kind: "not-a-kind", label: "x", preconditions: [], consequence: "y" };
    assert.equal(ActionSchema.safeParse(bad).success, false);
  });

  test("accepts each of the six closed kinds (pass direction)", () => {
    const common = { label: "x", preconditions: [], consequence: "y" };
    const cases = [
      { kind: "in-dashboard", route: "/x", method: "POST", confirmTier: "confirm-first", ...common },
      { kind: "terminal-skill", command: "/hydra-review", ...common },
      { kind: "config-env", project: "orchestrator", file: "config/x.yaml", ...common },
      { kind: "credential", ...common },
      { kind: "research-beyond-autonomy", ...common },
      { kind: "vision-decision", ...common },
    ];
    for (const c of cases) {
      assert.equal(ActionSchema.safeParse(c).success, true, JSON.stringify(c));
    }
  });

  test("rejects in-dashboard missing the required method", () => {
    const bad = {
      kind: "in-dashboard",
      route: "/x",
      confirmTier: "confirm-first",
      label: "x",
      preconditions: [],
      consequence: "y",
    };
    assert.equal(ActionSchema.safeParse(bad).success, false);
  });
});

describe("OperatorActionRegistrySchema — array-level superRefine", () => {
  test("rejects a duplicate (key, variant) slot", () => {
    const entries = [validEntry("repetition:hits"), validEntry("repetition:hits")];
    assert.equal(OperatorActionRegistrySchema.safeParse(entries).success, false);
  });

  test("permits the same key with two DIFFERENT variants (not a duplicate slot)", () => {
    const entries = [
      validEntry("waiting-on-you:ready-for-human"),
      validEntry("waiting-on-you:ready-for-human", { variant: "triage-origin" }),
      validEntry("waiting-on-you:ready-for-human", { variant: "dev-failure" }),
    ];
    assert.equal(OperatorActionRegistrySchema.safeParse(entries).success, true);
  });
});

// ---------------------------------------------------------------------------
// 6. GET /operator-actions — route (issue #4620 acceptance criterion 1)
// ---------------------------------------------------------------------------

function mockReq(): any {
  return { method: "GET", url: "/operator-actions", headers: {}, query: {}, params: {}, body: {} };
}
function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}
function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("GET /operator-actions — route", () => {
  test("returns 200 with every REGISTRY entry, validated by the schema", async () => {
    const router = createOperatorActionsRouter();
    const handler = findHandler(router, "GET", "/operator-actions");
    assert.ok(handler, "route handler must exist");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.entries.length, REGISTRY.length);
    const parsed = OperatorActionsResponseSchema.safeParse(res._body);
    assert.equal(parsed.success, true);
  });

  test("serves templates UNRESOLVED (no server-side {repo}/{number} substitution)", async () => {
    const router = createOperatorActionsRouter();
    const handler = findHandler(router, "GET", "/operator-actions");
    const res = mockRes();
    await handler!(mockReq(), res);
    const failedRequired = res._body.entries.find(
      (e: any) => e.key === "prs-not-landing:failed-required",
    );
    assert.ok(failedRequired);
    assert.match(failedRequired.recommended.command, /\{number\}/);
    assert.match(failedRequired.recommended.command, /\{repo\}/);
  });

  test("takes no query params — an unexpected query string is simply ignored", async () => {
    const router = createOperatorActionsRouter();
    const handler = findHandler(router, "GET", "/operator-actions");
    const res = mockRes();
    const req = mockReq();
    req.query = { unexpected: "1" };
    await handler!(req, res);
    assert.equal(res._status, 200);
  });
});
