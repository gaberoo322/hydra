/**
 * test/fail-loud-ratchet.test.mts — blocking shrink-only STD-CATCH-FAIL-LOUD
 * ratchet (issue #5424). The live describe is the gate (runs in the REQUIRED
 * `test` job); the pure describe pins the key/diff semantics. Fails closed:
 * an ast-grep spawn/exit/parse failure FAILS the live test, never skips it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { AST_GREP_SPEC } = await import("../scripts/ast-search.ts");
const {
  FAIL_LOUD_RULE_IDS,
  buildScanArgs,
  diffKeys,
  formatFailure,
  hitKey,
  loadFailLoudBaseline,
  normaliseText,
  scanTrackedFiles,
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

  test("a hit absent from the baseline is new; a fixed hit is stale; shrink passes", () => {
    assert.deepEqual(diffKeys(["a", "b"], ["a"]).newKeys, ["b"]);
    assert.deepEqual(diffKeys(["a"], ["a", "b"]).newKeys, []);
    assert.deepEqual(diffKeys(["a"], ["a", "b"]).staleKeys, ["b"]);
  });

  test("duplicate identical hits are a multiset: a second copy is new", () => {
    assert.deepEqual(diffKeys(["a", "a"], ["a"]).newKeys, ["a"]);
    assert.deepEqual(diffKeys(["a"], ["a", "a"]).newKeys, []);
  });

  test("toHits drops rows without ruleId/file", () => {
    assert.equal(toHits([{ ruleId: "r", file: "f", text: "t" }, { file: "x" }, {}]).length, 1);
  });

  test("scan argv uses the single pinned spec and filters to the three rules", () => {
    const args = buildScanArgs(["a.sh"]);
    assert.equal(args[args.indexOf("-p") + 1], AST_GREP_SPEC);
    assert.equal(args.filter((a) => a.includes("@ast-grep/cli")).length, 1);
    const filter = args[args.indexOf("--filter") + 1];
    for (const id of FAIL_LOUD_RULE_IDS) assert.ok(filter.includes(id));
    assert.equal(args.at(-1), "a.sh");
  });

  test("failure message names the fix", () => {
    const msg = formatFailure({ newKeys: ["r\tf\tt"], staleKeys: [] });
    assert.match(msg, /intentional/);
    assert.match(msg, /--write-baseline/);
  });
});

describe("fail-loud-ratchet: live tree vs committed baseline", () => {
  test("no new silent catch/except/`|| true` hits (fails closed on tool error)", async () => {
    const scan = await scanTrackedFiles();
    assert.equal(scan.ok, true, scan.ok ? "" : `ast-grep scan failed: ${scan.error}`);
    if (scan.ok === false) return;
    const baseline = await loadFailLoudBaseline();
    const diff = diffKeys(scan.keys, baseline.hits);
    assert.equal(diff.newKeys.length, 0, formatFailure(diff));
  });
});
