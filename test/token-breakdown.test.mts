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
});
