import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

// The relocation subject (issue #3513): the pure token-breakdown data-model
// primitives moved OUT of the `transcript-scan.ts` I/O coordinator into the
// focused pure leaf `token-breakdown.ts`. This suite proves the seam is directly
// importable WITHOUT the JSONL-scan / OAuth-cache machinery — the pure→pure edge
// the extraction exists to create — and pins the accumulator + classifier
// behaviour at the new home.
import {
  EMPTY_BREAKDOWN,
  emptyByModel,
  addBreakdown,
  DISPATCH_KINDS,
  deriveDispatchKind,
  emptyByDispatchKind,
  deriveSkill,
  parseSentinel,
  INTERACTIVE_SKILL,
} from "../src/cost/token-breakdown.ts";
import type { ModelFamily, TokenBreakdown } from "../src/cost/token-math.ts";

describe("token-breakdown leaf — pure data-model primitives (issue #3513)", () => {
  test("EMPTY_BREAKDOWN is the all-zero sentinel", () => {
    assert.deepEqual(EMPTY_BREAKDOWN, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
    });
  });

  test("emptyByModel seeds all four families with distinct zero breakdowns", () => {
    const acc = emptyByModel();
    const families: ModelFamily[] = ["opus", "sonnet", "haiku", "unknown"];
    for (const f of families) {
      assert.deepEqual(acc[f], EMPTY_BREAKDOWN);
    }
    // Distinct objects — mutating one family must not bleed into another.
    acc.opus.input += 5;
    assert.equal(acc.sonnet.input, 0);
  });

  test("addBreakdown accumulates every sub-field in place", () => {
    const target: TokenBreakdown = { ...EMPTY_BREAKDOWN };
    addBreakdown(target, { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10 });
    addBreakdown(target, { input: 1, output: 1, cacheRead: 1, cacheCreation: 1, total: 4 });
    assert.deepEqual(target, { input: 2, output: 3, cacheRead: 4, cacheCreation: 5, total: 14 });
  });

  test("emptyByDispatchKind seeds every DISPATCH_KIND with a zero per-family accumulator", () => {
    const byKind = emptyByDispatchKind();
    for (const kind of DISPATCH_KINDS) {
      assert.deepEqual(byKind[kind], emptyByModel());
    }
  });

  test("deriveSkill precedence: sentinel > command-name > leading-slash > interactive", () => {
    assert.equal(
      deriveSkill("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->"),
      "hydra-dev",
    );
    assert.equal(deriveSkill("<command-name>hydra-incident</command-name>"), "hydra-incident");
    assert.equal(deriveSkill("/hydra-digest please summarise"), "hydra-digest");
    assert.equal(deriveSkill("hey can you look at this bug"), INTERACTIVE_SKILL);
    assert.equal(deriveSkill(null), INTERACTIVE_SKILL);
  });

  test("deriveDispatchKind partitions over the same precedence chain", () => {
    assert.equal(
      deriveDispatchKind("<!-- hydra-dispatch v1 skill=hydra-dev runId=y -->"),
      "autopilot-dispatched",
    );
    assert.equal(deriveDispatchKind("<command-name>hydra-qa</command-name>"), "operator-invoked");
    assert.equal(deriveDispatchKind("/hydra-digest go"), "operator-invoked");
    assert.equal(deriveDispatchKind("just chatting"), "interactive");
    assert.equal(deriveDispatchKind(null), "interactive");
    // Every input lands in a declared kind.
    for (const input of ["<!-- hydra-dispatch v1 skill=x -->", "/foo", "plain", null]) {
      assert.ok((DISPATCH_KINDS as readonly string[]).includes(deriveDispatchKind(input)));
    }
  });

  describe("parseSentinel — widen the dispatch sentinel parse (issue #3969)", () => {
    test("all-three-fields: skill, dispatchId and runId extracted from a full sentinel", () => {
      assert.deepEqual(
        parseSentinel("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=abc-123 runId=run-456 -->"),
        { skill: "hydra-dev", dispatchId: "abc-123", runId: "run-456" },
      );
    });

    test("skill-only (older transcript): skill attributed, dispatchId/runId null — no throw", () => {
      assert.deepEqual(parseSentinel("<!-- hydra-dispatch v1 skill=hydra-dev -->"), {
        skill: "hydra-dev",
        dispatchId: null,
        runId: null,
      });
      // The attribution path keeps working off skill= alone.
      assert.equal(deriveSkill("<!-- hydra-dispatch v1 skill=hydra-dev -->"), "hydra-dev");
      assert.equal(
        deriveDispatchKind("<!-- hydra-dispatch v1 skill=hydra-dev -->"),
        "autopilot-dispatched",
      );
    });

    test("malformed sentinel: never throws; absent/empty fields resolve to null; attribution falls through", () => {
      // Opener present, no fields at all.
      assert.deepEqual(parseSentinel("<!-- hydra-dispatch v1 -->"), {
        skill: null,
        dispatchId: null,
        runId: null,
      });
      // Empty field values resolve to null, never a partial/empty string.
      assert.deepEqual(
        parseSentinel("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId= runId= -->"),
        { skill: "hydra-dev", dispatchId: null, runId: null },
      );
      // No skill to attribute -> precedence falls through to the residual.
      assert.equal(deriveSkill("<!-- hydra-dispatch v1 -->"), INTERACTIVE_SKILL);
      assert.equal(deriveDispatchKind("<!-- hydra-dispatch v1 -->"), "interactive");
    });

    test("field-order variation: extraction is order-independent (decide.py: order not load-bearing)", () => {
      // runId first, skill middle, dispatchId last.
      assert.deepEqual(
        parseSentinel("<!-- hydra-dispatch v1 runId=run-456 skill=hydra-dev dispatchId=abc-123 -->"),
        { skill: "hydra-dev", dispatchId: "abc-123", runId: "run-456" },
      );
      // dispatchId/runId before skill.
      assert.deepEqual(
        parseSentinel("<!-- hydra-dispatch v1 dispatchId=abc-123 runId=run-456 skill=hydra-dev -->"),
        { skill: "hydra-dev", dispatchId: "abc-123", runId: "run-456" },
      );
    });

    test("field extraction is scoped to the comment body — prose field= tokens are never mis-read", () => {
      const parsed = parseSentinel(
        "<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=abc-123 --> later prose runId=not-a-dispatch",
      );
      assert.equal(parsed?.skill, "hydra-dev");
      assert.equal(parsed?.dispatchId, "abc-123");
      assert.equal(parsed?.runId, null); // the prose token sits outside the comment
    });

    test("no sentinel / null / empty input: returns null (attribution falls through to interactive)", () => {
      assert.equal(parseSentinel("just a plain interactive message"), null);
      assert.equal(parseSentinel(null), null);
      assert.equal(parseSentinel(""), null);
    });

    test("precedence preserved: the widening does not regress sentinel > command-name > leading-slash", () => {
      // Sentinel still wins over a trailing command-name / slash marker.
      assert.equal(
        deriveSkill(
          "<!-- hydra-dispatch v1 skill=hydra-qa --> <command-name>hydra-dev</command-name>",
        ),
        "hydra-qa",
      );
      assert.equal(
        deriveDispatchKind("<!-- hydra-dispatch v1 skill=hydra-qa --> /hydra-dev"),
        "autopilot-dispatched",
      );
    });
  });
});

describe("deriveSkill — in-transcript precedence (issue #2402)", () => {
  test("(1) hydra-dispatch sentinel skill= wins over everything", () => {
    assert.equal(
      deriveSkill("<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->"),
      "hydra-dev",
    );
    // Sentinel embedded in a longer prompt body still wins over a slash marker.
    assert.equal(
      deriveSkill(
        "/hydra-autopilot\n<!-- hydra-dispatch v1 skill=hydra-grill dispatchId=x runId=y -->\nbody",
      ),
      "hydra-grill",
    );
  });

  test("(2a) <command-name>/skill</command-name> marker, then (2b) leading /skill", () => {
    assert.equal(
      deriveSkill(
        "<command-message>hydra-autopilot</command-message>\n<command-name>/hydra-autopilot</command-name>",
      ),
      "hydra-autopilot",
    );
    // Leading-slash optional inside the command-name tag.
    assert.equal(
      deriveSkill("<command-name>hydra-incident</command-name>"),
      "hydra-incident",
    );
    // A raw typed slash command (no command-name wrapper).
    assert.equal(deriveSkill("/hydra-digest please summarise"), "hydra-digest");
    // Namespaced plugin:skill form.
    assert.equal(deriveSkill("<command-name>/foo:bar</command-name>"), "foo:bar");
  });

  test("(3) residual: plain prose, empty, and null all bucket to 'interactive'", () => {
    assert.equal(deriveSkill("hey can you look at this bug"), INTERACTIVE_SKILL);
    assert.equal(deriveSkill(""), INTERACTIVE_SKILL);
    assert.equal(deriveSkill(null), INTERACTIVE_SKILL);
    assert.equal(INTERACTIVE_SKILL, "interactive");
  });
});

describe("deriveDispatchKind — precedence projection (issue #2403)", () => {
  test("sentinel -> autopilot-dispatched", () => {
    assert.equal(
      deriveDispatchKind(
        "<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=x runId=y -->",
      ),
      "autopilot-dispatched",
    );
  });

  test("a sentinel embedded in a longer prompt still wins -> autopilot-dispatched", () => {
    assert.equal(
      deriveDispatchKind(
        "preamble text <!-- hydra-dispatch v1 skill=hydra-qa dispatchId=x runId=z --> more",
      ),
      "autopilot-dispatched",
    );
  });

  test("<command-name> marker -> operator-invoked", () => {
    assert.equal(
      deriveDispatchKind("<command-name>hydra-incident</command-name>"),
      "operator-invoked",
    );
    assert.equal(
      deriveDispatchKind("<command-name>/hydra-qa</command-name>"),
      "operator-invoked",
    );
  });

  test("leading /slash -> operator-invoked", () => {
    assert.equal(deriveDispatchKind("/hydra-digest please summarise"), "operator-invoked");
  });

  test("no marker / empty / null -> interactive residual", () => {
    assert.equal(deriveDispatchKind("hey can you look at this bug"), "interactive");
    assert.equal(deriveDispatchKind(""), "interactive");
    assert.equal(deriveDispatchKind(null), "interactive");
  });

  test("is total: every input lands in exactly one of the three kinds", () => {
    for (const input of [
      "<!-- hydra-dispatch v1 skill=s runId=r -->",
      "<command-name>/x</command-name>",
      "/y",
      "plain",
      "",
      null,
    ]) {
      assert.ok(
        DISPATCH_KINDS.includes(deriveDispatchKind(input)),
        `kind for ${JSON.stringify(input)} must be one of DISPATCH_KINDS`,
      );
    }
  });
});
