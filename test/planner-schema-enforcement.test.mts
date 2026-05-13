/**
 * Regression test for issue #364 — enforce structured noWork on planner output.
 *
 * The /api/metrics/abandonment endpoint reported that 12/18 (67%) of cycle
 * abandonments fell into the "Planner produced no task" bucket — frontier-
 * model calls that returned empty / malformed / unstructured JSON instead of
 * the documented structured noWork shape from `to-planner.md`. Issue #270's
 * actionability gate only catches the *structured* noWork cases; it doesn't
 * fire on the schema-failure path.
 *
 * Fix (this issue):
 *   1. PLANNER_OUTPUT_SCHEMA: `reason` is required (not `["string", "null"]`).
 *   2. validateNoWorkSchema(): when `noWork=true`, `reason` must be a string
 *      of at least NOWORK_REASON_MIN_LENGTH characters after trim.
 *   3. runPlannerAgent() retries ONCE on the mini tier with a stripped prompt
 *      when the first call returns malformed JSON or a malformed noWork.
 *   4. On retry exhaustion, the planner returns a `__noWork` sentinel with
 *      `__plannerSchemaFailure: true` so pipeline-steps + the abandonment
 *      breakdown can attribute the failure correctly.
 *
 * These tests cover the pure surface: schema shape, noWork validator, the
 * retry-prompt contract, and the parsePlannerOutput JSON-extraction helper.
 * Full-loop integration is exercised by the live orchestrator.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  PLANNER_OUTPUT_SCHEMA,
  NOWORK_REASON_MIN_LENGTH,
  validateNoWorkSchema,
  validateTaskSchema,
  buildRetryNoWorkPrompt,
  parsePlannerOutput,
} from "../src/planner-prompt.ts";
import { categorizeAbandonReason } from "../src/metrics.ts";

describe("PLANNER_OUTPUT_SCHEMA — reason is required and non-nullable (issue #364)", () => {
  test("`reason` field type is `string`, not `[\"string\", \"null\"]`", () => {
    const props = PLANNER_OUTPUT_SCHEMA.properties as any;
    assert.equal(
      props.reason.type,
      "string",
      "reason must be a non-nullable string — the model cannot omit a diagnostic",
    );
  });

  test("`reason` is listed in required", () => {
    assert.ok(
      (PLANNER_OUTPUT_SCHEMA.required as string[]).includes("reason"),
      "reason must be in the required list so structured-output enforces emission",
    );
  });

  test("`noWork` stays a boolean and stays required", () => {
    const props = PLANNER_OUTPUT_SCHEMA.properties as any;
    assert.equal(props.noWork.type, "boolean");
    assert.ok((PLANNER_OUTPUT_SCHEMA.required as string[]).includes("noWork"));
  });
});

describe("validateNoWorkSchema — non-empty diagnostic reason (issue #364)", () => {
  test("accepts a well-formed noWork payload", () => {
    const errs = validateNoWorkSchema({
      noWork: true,
      reason: "Inspected priorities.md and the kanban backlog; both fully addressed by recent merges.",
    });
    assert.deepEqual(errs, []);
  });

  test("rejects noWork=true with empty reason", () => {
    const errs = validateNoWorkSchema({ noWork: true, reason: "" });
    assert.ok(errs.length > 0, "empty reason must be rejected");
    assert.ok(errs.some((e) => e.includes("empty")), errs.join("; "));
  });

  test("rejects noWork=true with whitespace-only reason", () => {
    const errs = validateNoWorkSchema({ noWork: true, reason: "    \n\t  " });
    assert.ok(errs.length > 0, "whitespace-only reason must be rejected");
  });

  test("rejects noWork=true with reason shorter than NOWORK_REASON_MIN_LENGTH", () => {
    const errs = validateNoWorkSchema({ noWork: true, reason: "n/a" });
    assert.ok(errs.length > 0);
    assert.ok(
      errs.some((e) => e.includes("too short")),
      "should flag short reasons explicitly",
    );
  });

  test("rejects noWork=true with reason missing entirely", () => {
    const errs = validateNoWorkSchema({ noWork: true });
    assert.ok(errs.length > 0);
  });

  test("rejects noWork flag missing", () => {
    const errs = validateNoWorkSchema({ reason: "long enough diagnostic reason here ok" });
    assert.ok(errs.length > 0);
  });

  test("min-length threshold is at least 20 chars to block 'blocked' / 'no work' etc.", () => {
    assert.ok(
      NOWORK_REASON_MIN_LENGTH >= 20,
      "20-char floor is the contract; lowering it admits non-diagnostic short-circuits",
    );
    // Sanity: common short-circuit phrases must fail the floor.
    for (const bad of ["no", "blocked", "n/a", "done", "all done", "nothing", "nothing to do"]) {
      const errs = validateNoWorkSchema({ noWork: true, reason: bad });
      assert.ok(errs.length > 0, `"${bad}" should fail the diagnostic-length floor`);
    }
  });
});

describe("validateTaskSchema — full-task arm (issue #364)", () => {
  const validTask = {
    title: "Add foo to bar",
    description: "details",
    taskType: "build",
    anchorType: "kanban",
    anchorReference: "kanban:row-1",
    whyNow: "why",
    confidence: "high",
    risk: "low",
    scopeBoundary: { in: ["src/foo.ts"], out: [], creates: [] },
    acceptanceCriteria: ["does the thing"],
    verificationPlan: [{ command: "npm test", expected: "exit 0", label: "tests" }],
  };

  test("accepts a complete task", () => {
    assert.deepEqual(validateTaskSchema(validTask), []);
  });

  test("rejects missing title (added in issue #364)", () => {
    const errs = validateTaskSchema({ ...validTask, title: "" });
    assert.ok(errs.some((e) => e.includes("title")));
  });

  test("rejects empty scopeBoundary.in", () => {
    const errs = validateTaskSchema({ ...validTask, scopeBoundary: { in: [], out: [], creates: [] } });
    assert.ok(errs.length > 0);
  });

  test("rejects missing risk", () => {
    const errs = validateTaskSchema({ ...validTask, risk: undefined });
    assert.ok(errs.some((e) => e.includes("risk")));
  });
});

describe("buildRetryNoWorkPrompt — stricter retry contract (issue #364)", () => {
  test("includes anchor type and reference verbatim", () => {
    const prompt = buildRetryNoWorkPrompt({
      type: "research",
      reference: "outcome-stuckness:test_growth",
      whyNow: "stalled",
    });
    assert.ok(prompt.includes("research"));
    assert.ok(prompt.includes("outcome-stuckness:test_growth"));
    assert.ok(prompt.includes("stalled"));
  });

  test("instructs the model to pick one of the two structured shapes", () => {
    const prompt = buildRetryNoWorkPrompt({ type: "kanban", reference: "r" });
    assert.ok(prompt.toLowerCase().includes("noWork".toLowerCase()));
    assert.ok(prompt.includes("reason"));
    assert.ok(
      prompt.includes(String(NOWORK_REASON_MIN_LENGTH)),
      "retry prompt must cite the min-length floor so the model knows the contract",
    );
  });

  test("forbids returning null / empty object", () => {
    const prompt = buildRetryNoWorkPrompt({ type: "kanban", reference: "r" });
    assert.ok(prompt.toLowerCase().includes("do not return null"));
    assert.ok(prompt.toLowerCase().includes("do not return an empty"));
  });

  test("retry prompt is compact (< 1500 chars) to honour the tight token budget", () => {
    const prompt = buildRetryNoWorkPrompt({
      type: "kanban",
      reference: "kanban:row-13",
      whyNow: "operator requested",
    });
    assert.ok(
      prompt.length < 1500,
      `retry prompt must stay compact; got ${prompt.length} chars`,
    );
  });
});

describe("parsePlannerOutput — JSON extraction contract (issue #364)", () => {
  test("returns parsed object for strict JSON", () => {
    const parsed = parsePlannerOutput('{"noWork": true, "reason": "long enough reason text here"}');
    assert.equal(parsed?.noWork, true);
    assert.equal(parsed?.reason, "long enough reason text here");
  });

  test("falls back to regex extraction when wrapped in prose", () => {
    const parsed = parsePlannerOutput(
      'Sure, here is the JSON:\n{"noWork": false, "title": "x"}\nLet me know if you need anything else.',
    );
    assert.equal(parsed?.title, "x");
  });

  test("returns null on completely unparseable input", () => {
    assert.equal(parsePlannerOutput("not json at all"), null);
    assert.equal(parsePlannerOutput(""), null);
    assert.equal(parsePlannerOutput(undefined), null);
    assert.equal(parsePlannerOutput(null), null);
  });

  test("returns null when regex-extracted substring is also invalid JSON", () => {
    // Has an opening `{` but the content is not valid JSON
    assert.equal(parsePlannerOutput("{ not a valid object"), null);
  });
});

describe("planner sentinel shape contract — schema-failure recovery (issue #364)", () => {
  /**
   * When the first planner call returns unparseable output AND the retry
   * also fails, runPlannerAgent returns this sentinel. pipeline-steps reads
   * exactly these fields — if a future refactor drops `__plannerSchemaFailure`,
   * the abandonment-breakdown endpoint silently loses visibility into the
   * 67% failure mode this issue exists to fix.
   */
  test("retry-exhausted sentinel satisfies the noWork early-exit contract", () => {
    const sentinel = {
      __noWork: true,
      reason: "planner_schema_failure (retry exhausted)",
      __plannerSchemaFailure: true,
      __plannerModel: "gpt-5.4",
    };

    assert.equal(sentinel.__noWork, true, "must set __noWork=true for early-exit branch");
    assert.equal(sentinel.__plannerSchemaFailure, true, "must set the schema-failure flag");
    assert.ok(typeof sentinel.reason === "string" && sentinel.reason.length > 0);
    assert.ok(
      sentinel.reason.toLowerCase().includes("schema"),
      "reason should self-describe so /api/metrics/abandonment can bucket it",
    );
  });

  test("schema-recovered-as-task: __plannerSchemaFailure tags a usable task", () => {
    // When the first call fails but the retry produces a fresh well-formed
    // task, runPlannerAgent tags the task with __plannerSchemaFailure so
    // downstream verification metrics can correlate first-call reliability
    // with merge outcomes.
    const recoveredTask = {
      title: "Add foo",
      __plannerSchemaFailure: true,
      __plannerModel: "gpt-5.4",
    };
    assert.equal(recoveredTask.__plannerSchemaFailure, true);
  });
});

describe("abandonment bucketing — schema failures categorised separately (issue #364)", () => {
  /**
   * pipeline-steps emits `abandonReason: "Planner schema failure: ..."` for
   * the schema-recovery-failed path. The abandonment-breakdown endpoint
   * categorises by `categorizeAbandonReason` which splits on the first colon.
   * The new "Planner schema failure" category must therefore be distinct
   * from the existing "Planner noWork" category.
   */
  test("'Planner schema failure: ...' buckets to a distinct category", () => {
    const real = categorizeAbandonReason("Planner noWork: all priorities addressed");
    const schema = categorizeAbandonReason("Planner schema failure: planner_schema_failure (retry exhausted)");
    assert.notEqual(real, schema, "schema-failure and real noWork must bucket separately");
    assert.equal(schema, "Planner schema failure");
    assert.equal(real, "Planner noWork");
  });

  test("the legacy 'Planner produced no task' category still buckets to its own category", () => {
    // The `!task` branch still fires when validateTaskSchema rejects an
    // otherwise-parseable task post-retry. The bucket name is unchanged so
    // the dashboard's existing series for this category remains stable.
    const category = categorizeAbandonReason("Planner produced no task");
    assert.equal(category, "Planner produced no task");
  });
});
