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
  REVIEW_BUCKETS,
  type OperatorActionEntryInput,
} from "../src/schemas/operator-actions.ts";
import {
  REGISTRY,
  validateRegistry,
  missingDefaultLines,
  outOfContextPlaceholders,
  classEntryCoverage,
} from "../src/operator-actions/registry.ts";
import { createOperatorActionsRouter } from "../src/api/operator-actions.ts";
import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";

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
  test("loads (import-time validateRegistry did not throw) with a default entry per admission line, plus variant entries", () => {
    // One DEFAULT entry (no `variant`) per admission line, plus the four
    // variant entries on `waiting-on-you:ready-for-human`: `grill-handoff`
    // (#4621, ADR-0034 §8.1) and the three §4 entry-path variants
    // `triage-origin` / `tracking-parent` / `dev-failure` (#4622, drift
    // assertion (b)) — pure data additions alongside their default.
    // Issue #4636 (ADR-0034 §9.2): plus one default `class:<name>` entry per
    // DISPATCH_CLASSES row.
    const defaultEntries = REGISTRY.filter((e) => e.variant === undefined);
    assert.equal(
      defaultEntries.length,
      ADMISSION_LINE_KEYS.length + DISPATCH_CLASSES.length,
    );
    assert.equal(
      REGISTRY.length,
      ADMISSION_LINE_KEYS.length + DISPATCH_CLASSES.length + 4,
    );
  });

  test("re-parses cleanly against the schema (belt-and-braces on the frozen export)", () => {
    const parsed = OperatorActionRegistrySchema.safeParse(REGISTRY);
    assert.equal(parsed.success, true);
  });

  test("ships exactly one class: entry per DISPATCH_CLASSES row (issue #4636)", () => {
    const classEntries = REGISTRY.filter((e) => e.key.startsWith("class:"));
    assert.equal(classEntries.length, DISPATCH_CLASSES.length);
    assert.deepEqual(
      classEntries.map((e) => e.key).sort(),
      DISPATCH_CLASSES.map((r) => `class:${r.name}`).sort(),
    );
    // "Exactly one": the schema superRefine rejects a duplicate (key, variant)
    // slot, so no class: entry may carry a variant either.
    assert.deepEqual(
      classEntries.filter((e) => e.variant !== undefined).map((e) => e.key),
      [],
    );
  });

  test("assertion (a): missingDefaultLines(REGISTRY) is empty", () => {
    assert.deepEqual(missingDefaultLines(REGISTRY), []);
  });

  test("assertion (d): outOfContextPlaceholders(REGISTRY) is empty", () => {
    assert.deepEqual(outOfContextPlaceholders(REGISTRY), []);
  });

  test("grill-handoff variant (#4621, ADR-0034 §8.1) carries the exact three labels", () => {
    const entry = REGISTRY.find(
      (e) => e.key === "waiting-on-you:ready-for-human" && e.variant === "grill-handoff",
    );
    assert.ok(entry, "waiting-on-you:ready-for-human must carry a grill-handoff variant entry");
    assert.equal(entry!.reviewBucket, "Grill handoff");
    assert.ok(REVIEW_BUCKETS.includes("Grill handoff"), "REVIEW_BUCKETS must include Grill handoff");
    assert.equal(entry!.recommended.label, "Grill with docs");
    assert.equal(entry!.alternatives[0].label, "Won't do");
    assert.equal(entry!.alternatives[1].label, "Approve draft as-is");
  });
});

// ---------------------------------------------------------------------------
// 2. missingDefaultLines — pure helper, both directions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// class:<name> entries (issue #4636, ADR-0034 §9.2)
// ---------------------------------------------------------------------------

const DRY_RUN_DEFAULT_CLASSES = [
  "cleanup_orch",
  "cleanup_target",
  "architecture_orch",
  "retro_orch",
  "skill_prune",
];

function classEntryFor(name: string) {
  const entry = REGISTRY.find((e) => e.key === `class:${name}` && e.variant === undefined);
  assert.ok(entry, `class:${name} must have a default registry entry`);
  return entry!;
}

describe("class:<name> registry entries (issue #4636)", () => {
  test("classEntryCoverage(REGISTRY, DISPATCH_CLASSES names) is {missing: [], extra: []}", () => {
    assert.deepEqual(
      classEntryCoverage(REGISTRY, DISPATCH_CLASSES.map((r) => r.name)),
      { missing: [], extra: [] },
    );
  });

  test("every class: entry recommends a terminal-skill whose command is /<classes.json skill>", () => {
    for (const row of DISPATCH_CLASSES) {
      const entry = classEntryFor(row.name);
      assert.equal(entry.recommended.kind, "terminal-skill", `class:${row.name}`);
      const command =
        entry.recommended.kind === "terminal-skill" ? entry.recommended.command : "";
      const firstToken = command.split(/\s+/)[0];
      assert.equal(
        firstToken,
        `/${row.skill}`,
        `class:${row.name} command must begin with /${row.skill}, got ${JSON.stringify(command)}`,
      );
    }
  });

  test("the five dry-run-default classes carry --apply on their recommended command", () => {
    for (const name of DRY_RUN_DEFAULT_CLASSES) {
      assert.ok(
        DISPATCH_CLASSES.some((r) => r.name === name),
        `${name} must be a real dispatch class`,
      );
      const entry = classEntryFor(name);
      const command =
        entry.recommended.kind === "terminal-skill" ? entry.recommended.command : "";
      assert.match(command, /(^|\s)--apply(\s|$)/, `class:${name} must carry --apply`);
    }
    assert.equal(classEntryFor("cleanup_orch").recommended.kind, "terminal-skill");
    const cleanup = classEntryFor("cleanup_orch").recommended;
    assert.equal(cleanup.kind === "terminal-skill" && cleanup.command, "/hydra-cleanup --apply");
  });

  test("no class: entry template carries a {placeholder}; operator arguments use <angle> tokens", () => {
    const classEntries = REGISTRY.filter((e) => e.key.startsWith("class:"));
    assert.deepEqual(outOfContextPlaceholders(classEntries), []);
    for (const entry of classEntries) {
      for (const action of [entry.recommended, entry.alternatives[0], entry.alternatives[1]]) {
        if (action.kind === "terminal-skill") {
          assert.doesNotMatch(action.command, /\{[a-zA-Z0-9_]+\}/, `${entry.key}: ${action.command}`);
        }
      }
    }
    const research = classEntryFor("research_orch").recommended;
    assert.equal(
      research.kind === "terminal-skill" && research.command,
      "/hydra-issue-research <issue-number>",
    );
  });

  test("every class: entry's doc is its skill's operator playbook", () => {
    for (const row of DISPATCH_CLASSES) {
      assert.equal(classEntryFor(row.name).doc, `docs/operator-playbooks/${row.skill}.md`);
    }
  });
});

describe("classEntryCoverage — pure helper (issue #4636)", () => {
  test("{[], []} when every name has exactly one default class: entry (pass direction)", () => {
    const entries = validateRegistry([validEntry("class:alpha"), validEntry("class:beta")]);
    assert.deepEqual(classEntryCoverage(entries, ["alpha", "beta"]), { missing: [], extra: [] });
  });

  test("flags a taxonomy class with no class: entry as missing (fail direction)", () => {
    const entries = validateRegistry([validEntry("class:alpha")]);
    assert.deepEqual(classEntryCoverage(entries, ["alpha", "beta"]), {
      missing: ["beta"],
      extra: [],
    });
  });

  test("flags a class: entry naming a non-taxonomy class as extra (fail direction)", () => {
    const entries = validateRegistry([validEntry("class:alpha"), validEntry("class:ghost")]);
    assert.deepEqual(classEntryCoverage(entries, ["alpha"]), {
      missing: [],
      extra: ["class:ghost"],
    });
  });

  test("a class whose only entry carries a variant still counts as missing", () => {
    const entries = validateRegistry([
      validEntry("class:alpha", { variant: "triage-origin" }),
    ]);
    assert.deepEqual(classEntryCoverage(entries, ["alpha"]), {
      missing: ["alpha"],
      extra: [],
    });
  });

  test("ignores admission-line entries entirely", () => {
    const entries = validateRegistry([validEntry(ADMISSION_LINE_KEYS[0]!)]);
    assert.deepEqual(classEntryCoverage(entries, []), { missing: [], extra: [] });
  });
});

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

  test("accepts a class:<name> key (the ADR-0034 §9.2 namespace)", () => {
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
