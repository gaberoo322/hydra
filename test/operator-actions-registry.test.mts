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
  BUCKET_CONTEXT,
  CONTROL_CHECKS,
  CONTROL_KEYS,
  OperatorActionEntrySchema,
  OperatorActionRegistrySchema,
  OperatorActionsResponseSchema,
  REVIEW_BUCKETS,
  bucketOfKey,
  type Action,
  type OperatorActionEntry,
  type OperatorActionEntryInput,
} from "../src/schemas/operator-actions.ts";
import {
  REGISTRY,
  validateRegistry,
  missingDefaultLines,
  outOfContextPlaceholders,
  classEntryCoverage,
  controlEntryCoverage,
} from "../src/operator-actions/registry.ts";
import { createOperatorActionsRouter } from "../src/api/operator-actions.ts";
import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";
import { evaluatePromoteEligibility } from "../src/autopilot/work-projections.ts";
import {
  healthVerdicts,
  reopenVerdicts,
  rowVerdicts,
} from "../dashboard/src/lib/control-verdicts.ts";
import {
  alertVerdicts,
  alertsVerdicts,
  schedulerVerdicts,
} from "../dashboard/src/lib/health-verdicts.ts";
import { readFile } from "node:fs/promises";

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
    // DISPATCH_CLASSES row. Issue #4629 (ADR-0034 §8.3): plus one default
    // `control:<page>/<name>` entry per CONTROL_KEYS member.
    const defaultEntries = REGISTRY.filter((e) => e.variant === undefined);
    assert.equal(
      defaultEntries.length,
      ADMISSION_LINE_KEYS.length + DISPATCH_CLASSES.length + CONTROL_KEYS.length,
    );
    assert.equal(
      REGISTRY.length,
      ADMISSION_LINE_KEYS.length + DISPATCH_CLASSES.length + CONTROL_KEYS.length + 4,
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
// class:<name> entries (issue #4636, ADR-0034 §9.2)
// ---------------------------------------------------------------------------

const DRY_RUN_DEFAULT_CLASSES = [
  "cleanup_orch",
  "cleanup_target",
  "architecture_orch",
  "retro_orch",
  "skill_prune",
  "wire_or_retire_target",
  "design_qa_target",
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

  test("the dry-run-default classes carry --apply on their recommended command", () => {
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

// ---------------------------------------------------------------------------
// 5. control:<page>/<name> entries (issue #4629, ADR-0034 §8.3;
//    design-concept 821e48ed INV-1/2/3/5/8/14)
// ---------------------------------------------------------------------------

const BOARD_STATE_SRC = "../dashboard/src/components/pages/work/BoardState.jsx";
const HEALTH_SRC = "../dashboard/src/pages/Health.jsx";
// The two /health panels that host #4631's controls beside the reads they own
// (design-concept 5ae4b72c INV-7).
const ALERTS_PANEL_SRC = "../dashboard/src/components/pages/health/AlertsPanel.jsx";
const SERVICE_STRIP_SRC = "../dashboard/src/components/pages/health/ServiceStrip.jsx";
/** Every dashboard file that renders a control: key. */
const CONTROL_PAGE_SRCS = [BOARD_STATE_SRC, HEALTH_SRC, ALERTS_PANEL_SRC, SERVICE_STRIP_SRC];

async function readPage(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/** recommended + both alternatives, indexed (never spread — see the NOTE in
 * registry.ts's outOfContextPlaceholders on tuple-spread widening). */
function actionsOf(entry: OperatorActionEntry): Action[] {
  return [entry.recommended, entry.alternatives[0], entry.alternatives[1]];
}

function controlEntry(key: string): OperatorActionEntry {
  const entry = REGISTRY.find((e) => e.key === key && e.variant === undefined);
  assert.ok(entry, `${key} has a default registry entry`);
  return entry!;
}

/** The ordered check ids of an entry's recommended action. */
function checksOf(entry: OperatorActionEntry): string[] {
  return entry.recommended.preconditions.flatMap((p) => (typeof p === "string" ? [] : [p.check]));
}

describe("control:<page>/<name> registry entries (issue #4629)", () => {
  test("controlEntryCoverage(REGISTRY, CONTROL_KEYS) is {missing: [], extra: []}", () => {
    assert.deepEqual(controlEntryCoverage(REGISTRY, CONTROL_KEYS), { missing: [], extra: [] });
  });

  test("CONTROL_KEYS includes the eight #4629 /work + /health controls", () => {
    // A membership pin, not an exact list: #4631 (and any later slice)
    // appends keys; controlEntryCoverage above keeps the list closed against
    // the registry in both directions.
    for (const key of [
      "control:health/brake-engage",
      "control:health/brake-release",
      "control:health/pause",
      "control:health/resume",
      "control:work/close",
      "control:work/promote",
      "control:work/relabel",
      "control:work/reopen",
    ]) {
      assert.ok((CONTROL_KEYS as readonly string[]).includes(key), key);
    }
  });

  test("{text, check} preconditions appear ONLY on control: entries — feed and class entries stay string-only", () => {
    const offenders: string[] = [];
    for (const entry of REGISTRY) {
      if (bucketOfKey(entry.key) === "control") continue;
      for (const action of actionsOf(entry)) {
        for (const p of action.preconditions) {
          if (typeof p !== "string") offenders.push(`${entry.key}${entry.variant ? `::${entry.variant}` : ""}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "AttentionFeed.jsx renders precondition strings directly — no object may reach it");
  });

  test("every control entry recommends an in-dashboard action whose route carries no placeholder", () => {
    // Relaxed by #4631 (design-concept 5ae4b72c INV-9): the ONE placeholder a
    // control route may carry is BUCKET_CONTEXT.control's `{id}`, and only
    // control:health/alert-dismiss uses it; every other per-row value is
    // body-built client-side (#4629 INV-7).
    const withPlaceholder: string[] = [];
    for (const key of CONTROL_KEYS) {
      const { recommended } = controlEntry(key);
      assert.equal(recommended.kind, "in-dashboard", `${key} is a page write control`);
      if (recommended.kind === "in-dashboard") {
        const stripped = recommended.route.replaceAll("{id}", "");
        assert.doesNotMatch(stripped, /[{}]/, `${key}: only {id} may template a control route`);
        if (stripped !== recommended.route) withPlaceholder.push(key);
      }
    }
    assert.deepEqual(withPlaceholder, ["control:health/alert-dismiss"]);
  });

  test("the promote checklist is exactly the promote gate's four rules, in order", () => {
    assert.deepEqual(checksOf(controlEntry("control:work/promote")), [
      "issue-open",
      "not-already-ready",
      "has-scope-section",
      "no-open-blocker",
    ]);
  });

  test("the promote checklist order mirrors evaluatePromoteEligibility's precedence", () => {
    // A row violating every rule refuses with the FIRST rule; clearing each in
    // checklist order exposes the next — so the gate's precedence and the
    // checklist order cannot drift apart silently.
    const reasonOf: Record<string, string> = {
      "issue-open": "closed",
      "not-already-ready": "already-ready",
      "has-scope-section": "missing-scope-section",
      "no-open-blocker": "blocked",
    };
    const row: any = {
      number: 40,
      title: "fixture",
      url: "https://example.invalid/40",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
      state: "CLOSED",
      labels: ["ready-for-agent"],
      body: "Blocked by #41",
    };
    const open = new Set([41]);
    const fixes: Record<string, () => void> = {
      "issue-open": () => { row.state = "OPEN"; },
      "not-already-ready": () => { row.labels = []; },
      "has-scope-section": () => { row.body = "## Files in scope\n\n- `fixture/a.ts`\n\nBlocked by #41"; },
      "no-open-blocker": () => { open.clear(); },
    };
    for (const check of checksOf(controlEntry("control:work/promote"))) {
      const verdict = evaluatePromoteEligibility(row, open);
      assert.equal(verdict.eligible, false, `${check} still refuses`);
      assert.equal(verdict.eligible === false ? verdict.reason : null, reasonOf[check]);
      fixes[check]!();
    }
    assert.deepEqual(evaluatePromoteEligibility(row, open), { eligible: true });
  });

  test("confirm tiers: promote, resume, brake-engage, brake-release confirm first; relabel, close, reopen, pause are immediate-undo", () => {
    const tierOf = (key: string) => {
      const { recommended } = controlEntry(key);
      return recommended.kind === "in-dashboard" ? recommended.confirmTier : null;
    };
    for (const key of ["control:work/promote", "control:health/resume", "control:health/brake-engage", "control:health/brake-release"]) {
      assert.equal(tierOf(key), "confirm-first", key);
    }
    for (const key of ["control:work/relabel", "control:work/close", "control:work/reopen", "control:health/pause"]) {
      assert.equal(tierOf(key), "immediate-undo", key);
    }
  });

  test("control:health/resume and the feed's machine-stopped:paused share method, route and confirmTier", () => {
    const page = controlEntry("control:health/resume").recommended;
    const feed = controlEntry("machine-stopped:paused").recommended;
    assert.equal(page.kind, "in-dashboard");
    assert.equal(feed.kind, "in-dashboard");
    if (page.kind === "in-dashboard" && feed.kind === "in-dashboard") {
      assert.deepEqual(
        { method: page.method, route: page.route, confirmTier: page.confirmTier },
        { method: feed.method, route: feed.route, confirmTier: feed.confirmTier },
        "one route never behaves two ways",
      );
    }
  });

  test("every control: key is referenced by exactly one dashboard page file", async () => {
    const pages: Record<string, string> = {};
    for (const rel of CONTROL_PAGE_SRCS) pages[rel] = await readPage(rel);
    for (const key of CONTROL_KEYS) {
      const owners = Object.entries(pages).filter(([, src]) => src.includes(`"${key}"`)).map(([rel]) => rel);
      assert.equal(owners.length, 1, `${key} must be rendered by exactly one page (got ${owners.join(", ") || "none"})`);
    }
  });

  test("every check id a page's control entries use appears in that page's verdict table", async () => {
    // The tables live in the tested leaf lib/control-verdicts.ts (PR #5155
    // review); each page imports its own and every check id its entries use
    // must be a key the table actually produces.
    const tables: Record<string, { imports: string[]; ids: Set<string>; lib?: string }> = {
      [BOARD_STATE_SRC]: {
        imports: ["rowVerdicts", "reopenVerdicts"],
        ids: new Set([...Object.keys(rowVerdicts({}, undefined)), ...Object.keys(reopenVerdicts(""))]),
      },
      [HEALTH_SRC]: { imports: ["healthVerdicts"], ids: new Set(Object.keys(healthVerdicts(null, false))) },
      // #4631 (design-concept 5ae4b72c INV-4/5): the alert and scheduler
      // tables live in the sibling leaf lib/health-verdicts.ts; the table is
      // probed with inputs that make every check id present.
      [ALERTS_PANEL_SRC]: {
        imports: ["alertVerdicts", "alertsVerdicts"],
        lib: "health-verdicts",
        ids: new Set([...Object.keys(alertVerdicts({})), ...Object.keys(alertsVerdicts(0))]),
      },
      [SERVICE_STRIP_SRC]: {
        imports: ["schedulerVerdicts"],
        lib: "health-verdicts",
        ids: new Set(Object.keys(schedulerVerdicts({ running: false, stopReason: null }, 0))),
      },
    };
    for (const [rel, table] of Object.entries(tables)) {
      const src = await readPage(rel);
      const lib = table.lib ?? "control-verdicts";
      for (const fn of table.imports) {
        assert.match(src, new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\} from "[./]+lib/${lib}\\.ts"`), `${rel} imports ${fn}`);
      }
      for (const key of CONTROL_KEYS.filter((k) => src.includes(`"${k}"`))) {
        for (const check of checksOf(controlEntry(key))) {
          assert.ok(table.ids.has(check), `${rel} renders ${key} but its verdict table lacks "${check}"`);
        }
      }
    }
  });

  test("neither page carries a hand-written label, precondition or consequence string", async () => {
    for (const rel of CONTROL_PAGE_SRCS) {
      const src = await readPage(rel);
      for (const key of CONTROL_KEYS.filter((k) => src.includes(`"${k}"`))) {
        const { recommended } = controlEntry(key);
        const texts = [
          recommended.consequence,
          ...recommended.preconditions.map((p) => (typeof p === "string" ? p : p.text)),
        ];
        for (const text of texts) {
          assert.ok(!src.includes(text), `${rel} re-spells registry text for ${key}: "${text}"`);
        }
        // Labels: the quoted literal or a JSX text node — never page copy.
        assert.ok(!src.includes(`"${recommended.label}"`), `${rel} quotes ${key}'s label`);
        assert.ok(!src.includes(`>${recommended.label}<`), `${rel} renders ${key}'s label as JSX text`);
      }
    }
  });
});

describe("controlEntryCoverage — pure helper (issue #4629)", () => {
  const keys = ["control:work/promote", "control:health/pause"];
  test("{[], []} when every key has exactly one default control: entry (pass direction)", () => {
    const entries = validateRegistry(keys.map((k) => validEntry(k)));
    assert.deepEqual(controlEntryCoverage(entries, keys), { missing: [], extra: [] });
  });

  test("flags a listed key with no control: entry as missing (fail direction)", () => {
    const entries = validateRegistry([validEntry("control:work/promote")]);
    assert.deepEqual(controlEntryCoverage(entries, keys), { missing: ["control:health/pause"], extra: [] });
  });

  test("flags a control: entry outside the list as extra (fail direction)", () => {
    const entries = validateRegistry([...keys.map((k) => validEntry(k)), validEntry("control:work/rogue")]);
    assert.deepEqual(controlEntryCoverage(entries, keys), { missing: [], extra: ["control:work/rogue"] });
  });

  test("a key whose only entry carries a variant still counts as missing", () => {
    const entries = validateRegistry([
      validEntry("control:work/promote"),
      validEntry("control:health/pause", { variant: "reframe" }),
    ]);
    assert.deepEqual(controlEntryCoverage(entries, keys).missing, ["control:health/pause"]);
  });

  test("ignores admission-line and class: entries entirely", () => {
    const entries = validateRegistry([
      ...keys.map((k) => validEntry(k)),
      validEntry("machine-stopped:paused"),
      validEntry("class:dev_orch"),
    ]);
    assert.deepEqual(controlEntryCoverage(entries, keys), { missing: [], extra: [] });
  });
});

describe("control: namespace + typed preconditions — schema (issue #4629)", () => {
  test("bucketOfKey returns the literal control, and BUCKET_CONTEXT.control is exactly ['id']", () => {
    assert.equal(bucketOfKey("control:work/promote"), "control");
    assert.equal(bucketOfKey("control:health/brake-engage"), "control");
    // #4631 (design-concept 5ae4b72c INV-9) amends #4629's empty list: the
    // alert id is the only per-row route segment any control carries.
    assert.deepEqual([...BUCKET_CONTEXT.control], ["id"]);
  });

  test("EntryKeySchema admits control:(work|health)/<name> and rejects other shapes", () => {
    for (const key of ["control:work/promote", "control:health/brake-release", "control:work/a-1"]) {
      assert.equal(OperatorActionEntrySchema.safeParse(validEntry(key)).success, true, key);
    }
    for (const key of ["control:runs/rerun", "control:work/Promote", "control:work", "control:work/", "control:/x"]) {
      assert.equal(OperatorActionEntrySchema.safeParse(validEntry(key)).success, false, key);
    }
  });

  test("a {text, check} precondition parses only with a CONTROL_CHECKS id and no extra field", () => {
    const withPre = (pre: unknown) =>
      ActionSchema.safeParse({ ...terminalAction("x"), preconditions: [pre] }).success;
    for (const check of CONTROL_CHECKS) assert.equal(withPre({ text: "t", check }), true, check);
    assert.equal(withPre({ text: "t", check: "issue-closed" }), false, "an unknown check id is a parse error");
    assert.equal(withPre({ text: "t", check: "issue-open", extra: 1 }), false, "strict object");
    assert.equal(withPre({ check: "issue-open" }), false, "text is required");
    assert.equal(withPre("prose stays valid"), true);
  });

  test("CONTROL_CHECKS is the closed twelve-id vocabulary", () => {
    // The #4629 twelve stay a contiguous, ordered prefix; later slices
    // (#4631) append their ids after them.
    assert.deepEqual([...CONTROL_CHECKS].slice(0, 12), [
      "issue-open",
      "not-already-ready",
      "has-scope-section",
      "no-open-blocker",
      "relabel-target-chosen",
      "issue-number-entered",
      "pause-state-verified",
      "autopilot-running",
      "autopilot-paused",
      "brake-state-verified",
      "brake-off",
      "brake-engaged",
    ]);
  });

  test("missingDefaultLines and classEntryCoverage ignore control: entries", () => {
    const entries = validateRegistry([
      ...ADMISSION_LINE_KEYS.map((k) => validEntry(k)),
      validEntry("control:work/promote"),
    ]);
    assert.deepEqual(missingDefaultLines(entries), []);
    assert.deepEqual(classEntryCoverage(entries, []), { missing: [], extra: [] });
  });
});

// ---------------------------------------------------------------------------
// 6. /health alert, scheduler and housekeeping controls (issue #4631,
//    design-concept 5ae4b72c INV-2/3/4/6/7/9/12)
// ---------------------------------------------------------------------------

const HEALTH_4631_KEYS = [
  "control:health/alert-dismiss",
  "control:health/alerts-dismiss-all",
  "control:health/scheduler-stop",
  "control:health/scheduler-start",
  "control:health/housekeeping",
] as const;

function inDashboard(key: string) {
  const { recommended } = controlEntry(key);
  assert.equal(recommended.kind, "in-dashboard", `${key} recommends an in-dashboard action`);
  if (recommended.kind !== "in-dashboard") throw new Error("unreachable");
  return recommended;
}

describe("control:health alert/scheduler/housekeeping entries (issue #4631)", () => {
  test("the five #4631 keys join CONTROL_KEYS and the five checks join CONTROL_CHECKS", () => {
    for (const key of HEALTH_4631_KEYS) {
      assert.ok((CONTROL_KEYS as readonly string[]).includes(key), key);
    }
    for (const check of ["alert-open", "alerts-any-open", "scheduler-running", "scheduler-not-running", "no-fresh-deliberate-stop"]) {
      assert.ok((CONTROL_CHECKS as readonly string[]).includes(check), check);
    }
  });

  test("each entry recommends POST in-dashboard on its real route, cites docs/reference.md, and offers two read-only hand-offs", () => {
    const routes: Record<string, string> = {
      "control:health/alert-dismiss": "/alerts/{id}/dismiss",
      "control:health/alerts-dismiss-all": "/alerts/dismiss-all",
      "control:health/scheduler-stop": "/scheduler/stop",
      "control:health/scheduler-start": "/scheduler/start",
      "control:health/housekeeping": "/maintenance/housekeeping",
    };
    const readOnly = new Set([
      "curl -s http://localhost:4000/api/alerts",
      "/hydra-review",
      "curl -s http://localhost:4000/api/scheduler/status",
      "journalctl --user -u hydra-orchestrator.service -n 200 --no-pager",
      "systemctl --user status hydra-housekeeping.timer",
    ]);
    for (const key of HEALTH_4631_KEYS) {
      const entry = controlEntry(key);
      const recommended = inDashboard(key);
      assert.equal(recommended.method, "POST", key);
      assert.equal(recommended.route, routes[key], key);
      assert.equal(entry.doc, "docs/reference.md", key);
      for (const alt of [entry.alternatives[0], entry.alternatives[1]]) {
        assert.equal(alt.kind, "terminal-skill", `${key}: alternatives are hand-offs`);
        if (alt.kind === "terminal-skill") assert.ok(readOnly.has(alt.command), `${key}: ${alt.command} is a read-only hand-off`);
      }
    }
  });

  test("confirm tiers: alert-dismiss, scheduler-start, housekeeping are immediate-undo; dismiss-all and scheduler-stop confirm first", () => {
    for (const key of ["control:health/alert-dismiss", "control:health/scheduler-start", "control:health/housekeeping"]) {
      assert.equal(inDashboard(key).confirmTier, "immediate-undo", key);
    }
    for (const key of ["control:health/alerts-dismiss-all", "control:health/scheduler-stop"]) {
      assert.equal(inDashboard(key).confirmTier, "confirm-first", key);
    }
  });

  test("check bindings: each entry carries exactly its typed checks, in order; housekeeping has none", () => {
    assert.deepEqual(checksOf(controlEntry("control:health/alert-dismiss")), ["alert-open"]);
    assert.deepEqual(checksOf(controlEntry("control:health/alerts-dismiss-all")), ["alerts-any-open"]);
    assert.deepEqual(checksOf(controlEntry("control:health/scheduler-stop")), ["scheduler-running"]);
    assert.deepEqual(checksOf(controlEntry("control:health/scheduler-start")), ["scheduler-not-running", "no-fresh-deliberate-stop"]);
    assert.deepEqual(controlEntry("control:health/housekeeping").recommended.preconditions, []);
    // Every line is typed — none of these controls carries a prose ☐ line.
    for (const key of HEALTH_4631_KEYS) {
      for (const p of controlEntry(key).recommended.preconditions) assert.equal(typeof p, "object", key);
    }
  });

  test("precondition and consequence strings are the #4424 table's, with the two glossary corrections", () => {
    const textsOf = (key: string) => controlEntry(key).recommended.preconditions.map((p) => (typeof p === "string" ? p : p.text));
    assert.deepEqual(textsOf("control:health/alert-dismiss"), ["alert is open"]);
    assert.deepEqual(textsOf("control:health/alerts-dismiss-all"), ["≥ 1 open alert"]);
    assert.deepEqual(textsOf("control:health/scheduler-stop"), ["scheduler running"]);
    assert.deepEqual(textsOf("control:health/scheduler-start"), ["scheduler not running", "no deliberate-stop marker younger than 24 h"]);
    const consequenceOf = (key: string) => controlEntry(key).recommended.consequence;
    assert.equal(consequenceOf("control:health/alert-dismiss"), "the alert leaves the count and the list; Undo within the window cancels before anything is sent");
    assert.equal(consequenceOf("control:health/alerts-dismiss-all"), "every open alert is dismissed; none can be restored");
    assert.equal(consequenceOf("control:health/scheduler-stop"), "writes the deliberate-stop marker (24 h); the watchdog will NOT restart it");
    assert.equal(consequenceOf("control:health/scheduler-start"), "clears the marker and the heartbeat resumes ticking at the stored interval");
    assert.equal(consequenceOf("control:health/housekeeping"), "runs every due chore now and reports {ran, skipped}; chores inside their time-guard window are skipped");
    // Glossary corrections: chores are timer-driven, never "on the next tick";
    // there is no un-dismiss route, so nothing claims Undo "restores" it.
    assert.doesNotMatch(consequenceOf("control:health/scheduler-start"), /next tick/);
    assert.doesNotMatch(consequenceOf("control:health/alert-dismiss"), /restores/);
  });

  test("scheduler-start and the feed's machine-stopped:scheduler-deliberate share method and route, differ in tier, and the control carries no-fresh-deliberate-stop", () => {
    const page = inDashboard("control:health/scheduler-start");
    const feed = controlEntry("machine-stopped:scheduler-deliberate").recommended;
    assert.equal(feed.kind, "in-dashboard");
    if (feed.kind !== "in-dashboard") return;
    assert.deepEqual({ method: page.method, route: page.route }, { method: feed.method, route: feed.route });
    assert.notEqual(page.confirmTier, feed.confirmTier, "the two entries are enabled in disjoint states, so the tiers may differ");
    // Disjointness: the feed row exists only while a deliberate stop is younger
    // than 24 h — exactly when this line is ✗ and the control is disabled.
    assert.ok(checksOf(controlEntry("control:health/scheduler-start")).includes("no-fresh-deliberate-stop"));
    const fresh = schedulerVerdicts(
      { running: false, stopReason: "deliberate", deliberateStoppedAt: new Date(1_000_000).toISOString() },
      1_000_000 + 60_000,
    );
    assert.equal(fresh["no-fresh-deliberate-stop"], false, "a fresh deliberate stop disables the control");
  });

  test("assertion (d) admits {id} on a control route and still flags any other placeholder", () => {
    assert.deepEqual(outOfContextPlaceholders(REGISTRY), []);
    const route = (r: string) => ({
      kind: "in-dashboard" as const,
      route: r,
      method: "POST" as const,
      confirmTier: "immediate-undo" as const,
      label: "x",
      preconditions: [],
      consequence: "y",
    });
    const ok = validateRegistry([validEntry("control:health/alert-dismiss", { recommended: route("/alerts/{id}/dismiss") })]);
    assert.deepEqual(outOfContextPlaceholders(ok), []);
    const bad = validateRegistry([validEntry("control:health/alert-dismiss", { recommended: route("/alerts/{number}/dismiss") })]);
    assert.deepEqual(outOfContextPlaceholders(bad), [{ key: "control:health/alert-dismiss", placeholder: "number" }]);
  });

  test("placement follows read ownership: alert controls in AlertsPanel.jsx, scheduler in ServiceStrip.jsx, housekeeping in Health.jsx", async () => {
    const owner: Record<string, string> = {
      "control:health/alert-dismiss": ALERTS_PANEL_SRC,
      "control:health/alerts-dismiss-all": ALERTS_PANEL_SRC,
      "control:health/scheduler-stop": SERVICE_STRIP_SRC,
      "control:health/scheduler-start": SERVICE_STRIP_SRC,
      "control:health/housekeeping": HEALTH_SRC,
    };
    for (const [key, rel] of Object.entries(owner)) {
      assert.ok((await readPage(rel)).includes(`controlKey="${key}"`), `${rel} renders ${key}`);
    }
  });
});
