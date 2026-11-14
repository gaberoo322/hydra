/**
 * test/test-title-provenance-ratchet.test.mts — blocking shrink-only
 * STD-TEST-OWN-FEATURE ratchet (issue #5511). The live describe is the gate
 * (runs in the REQUIRED `test` job); the pure describe pins the grammar and key
 * semantics over synthetic sources. Fails closed: an unreadable test file or an
 * unparseable fixture FAILS the live test, never skips it.
 *
 * Synthetic sources are assembled from helper calls so this file's own source
 * never contains a grammar match as a title or comment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { stripComments } = await import("../scripts/ci/test-subject-map.ts");
const {
  commentLines,
  diffKeys,
  formatFailure,
  hitKey,
  loadProvenanceBaseline,
  matchesProvenance,
  normaliseText,
  scanSource,
  scanTestFiles,
} = await import("../scripts/ci/test-title-provenance-scan.ts");

const WORD_ROUND = "ro" + "und";
const callSrc = (fn: string, title: string) => `${fn}(${JSON.stringify(title)}, () => {});`;

describe("test-title-provenance: grammar", () => {
  test("each of the six literal patterns matches", () => {
    for (const s of [
      `${WORD_ROUND} 4`,
      `${WORD_ROUND}-3 follow-up`,
      "QA " + WORD_ROUND,
      "fix" + "-forward",
      "re" + "-review",
      "added by #1234",
      "prior " + "finding",
    ]) {
      assert.equal(matchesProvenance(s), true, s);
    }
  });

  test("a plain issue reference never matches", () => {
    for (const s of ["pins the lane (#5293)", "issue #4985 behaviour", "added by hand", "around 4 items"]) {
      assert.equal(matchesProvenance(s), false, s);
    }
  });
});

describe("test-title-provenance: title and comment extraction", () => {
  test("titles of describe/it/test and their skip/only/todo forms are scanned", () => {
    const t = `${WORD_ROUND} 4 title`;
    for (const fn of ["describe", "it", "test", "test.skip", "it.only", "describe.todo"]) {
      const hits = scanSource("test/x.test.mts", callSrc(fn, t));
      assert.deepEqual(hits.map((h) => h.kind), ["title"], fn);
    }
  });

  test("a clean title and an own-issue reference produce no hit", () => {
    assert.deepEqual(scanSource("test/x.test.mts", callSrc("it", "pins the lane (#5293)")), []);
  });

  test("a string that is not the first argument of a test call is not a title", () => {
    assert.deepEqual(scanSource("test/x.test.mts", `const x = ${JSON.stringify(WORD_ROUND + " 4")};`), []);
  });

  test("line and block comments are scanned", () => {
    const src = ["// QA " + WORD_ROUND + " note", "/*", " * fix" + "-forward remark", " */", "const x = 1;"].join("\n");
    const hits = scanSource("test/x.test.mts", src);
    assert.deepEqual(hits.map((h) => h.kind), ["comment", "comment"]);
  });

  test("a commented-out test call counts once, as a comment, never as a title", () => {
    const src = "// " + callSrc("it", `${WORD_ROUND} 4`);
    assert.deepEqual(scanSource("test/x.test.mts", src).map((h) => h.kind), ["comment"]);
  });

  test("stripComments stays length-preserving so the comment complement is valid", () => {
    const src = ["const a = 1; // tail", "/* block", "two */ const b = 2;"].join("\n");
    const stripped = stripComments(src);
    assert.equal(stripped.length, src.length);
    assert.deepEqual(stripped.split("\n").map((l) => l.length), src.split("\n").map((l) => l.length));
    assert.deepEqual(commentLines(src), ["// tail", "/* block", "two */"]);
  });
});

describe("test-title-provenance: key and diff semantics", () => {
  test("key ignores whitespace but not text, file or kind", () => {
    const a = hitKey({ kind: "title", file: "f", text: "a  b" });
    assert.equal(a, hitKey({ kind: "title", file: "f", text: " a b " }));
    assert.notEqual(a, hitKey({ kind: "title", file: "f", text: "a c" }));
    assert.notEqual(a, hitKey({ kind: "title", file: "g", text: "a b" }));
    assert.notEqual(a, hitKey({ kind: "comment", file: "f", text: "a b" }));
    assert.equal(normaliseText("  a \n b\t"), "a b");
  });

  test("key carries no line number: moving a hit down the file keeps its key", () => {
    const t = `${WORD_ROUND} 4 title`;
    const a = scanSource("test/x.test.mts", callSrc("it", t)).map(hitKey);
    const b = scanSource("test/x.test.mts", "const pad = 1;\n\n" + callSrc("it", t)).map(hitKey);
    assert.deepEqual(a, b);
  });

  test("a hit absent from the baseline is new; a fixed hit is stale and never fails", () => {
    assert.deepEqual(diffKeys(["a", "b"], ["a"]).newKeys, ["b"]);
    assert.deepEqual(diffKeys(["a"], ["a", "b"]).newKeys, []);
    assert.deepEqual(diffKeys(["a"], ["a", "b"]).staleKeys, ["b"]);
  });

  test("a swap (one fixed, one added) is still a new key", () => {
    assert.deepEqual(diffKeys(["new"], ["old"]).newKeys, ["new"]);
  });

  test("duplicate identical hits are a multiset: a second copy is new", () => {
    assert.deepEqual(diffKeys(["a", "a"], ["a"]).newKeys, ["a"]);
  });

  test("failure message names the rule and both exits", () => {
    const msg = formatFailure({ newKeys: ["title\tf\tt"], staleKeys: [] });
    assert.match(msg, /STD-TEST-OWN-FEATURE/);
    assert.match(msg, /rename/);
    assert.match(msg, /by hand/);
    assert.match(msg, /--write-baseline/);
  });
});

describe("test-title-provenance: live tree vs committed baseline", () => {
  test("no new QA-history title/comment hits (fails closed on read or fixture error)", async () => {
    const scan = await scanTestFiles();
    if (scan.ok === false) assert.fail(`scan failed (fail closed): ${scan.error}`);
    const baseline = await loadProvenanceBaseline();
    const diff = diffKeys(scan.keys, baseline.hits);
    assert.equal(diff.newKeys.length, 0, formatFailure(diff));
  });

  test("an unreadable file is a scan error, not a skip", async () => {
    const scan = await scanTestFiles(["test/definitely-missing.test.mts"]);
    assert.equal(scan.ok, false);
  });
});
