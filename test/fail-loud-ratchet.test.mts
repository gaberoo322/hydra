/**
 * test/fail-loud-ratchet.test.mts — blocking shrink-only STD-CATCH-FAIL-LOUD
 * ratchet (issue #5424). The pure describe pins the key/diff semantics; the
 * live-tree verdict runs in test/ratchets-live.test.mts (REQUIRED `test` job).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { AST_GREP_SPEC } = await import("../scripts/ast-search.ts");
const {
  FAIL_LOUD_RULE_IDS,
  buildScanArgs,
  hitKey,
  normaliseText,
  toHits,
} = await import("../scripts/ci/fail-loud-ratchet.ts");

describe("fail-loud-ratchet: pure semantics", () => {
  test("key ignores line numbers and whitespace but not text, file or rule", () => {
    const a = hitKey({ ruleId: "r", file: "f.py", text: "except X:\n    pass" });
    assert.equal(a, hitKey({ ruleId: "r", file: "f.py", text: "except X:\n        pass" }));
    assert.notEqual(a, hitKey({ ruleId: "r", file: "f.py", text: "except X:\n    y = 1" }));
    assert.notEqual(a, hitKey({ ruleId: "r", file: "g.py", text: "except X:\n    pass" }));
    assert.notEqual(a, hitKey({ ruleId: "s", file: "f.py", text: "except X:\n    pass" }));
    assert.equal(normaliseText("  a \n b\t"), "a b");
  });

  test("toHits drops rows without ruleId/file", () => {
    assert.equal(toHits([{ ruleId: "r", file: "f", text: "t" }, { file: "x" }, {}]).length, 1);
  });

  test("scan argv uses the single pinned spec and filters to every fail-loud rule", () => {
    const args = buildScanArgs(["a.sh"]);
    assert.equal(args[args.indexOf("-p") + 1], AST_GREP_SPEC);
    assert.equal(args.filter((a) => a.includes("@ast-grep/cli")).length, 1);
    const filter = args[args.indexOf("--filter") + 1];
    for (const id of FAIL_LOUD_RULE_IDS) assert.ok(filter.includes(id));
    assert.equal(args.at(-1), "a.sh");
  });

  test("src/ lane rule is in the ratchet filter beside the generic rule (#5435 QA)", () => {
    assert.ok(FAIL_LOUD_RULE_IDS.includes("fail-loud-catch-src" as never));
    assert.ok(FAIL_LOUD_RULE_IDS.includes("fail-loud-catch"));
  });
});
