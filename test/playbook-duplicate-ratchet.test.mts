/**
 * test/playbook-duplicate-ratchet.test.mts — the playbook duplicate ratchet
 * (issue #5587): passages shared verbatim between two playbook sources are
 * counted per file and capped by a shrink-only baseline (STD-PLAYBOOK-ONE-HOME).
 *
 * The unit cases feed synthetic text through the exported pure functions; the
 * last cases run the real ratchet over the real playbooks: that is the gate.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const {
  MIN_SPAN_TOKENS,
  STANDARD_REL,
  tokenise,
  scanTexts,
  countSpans,
  findIntraSpans,
  measureTexts,
  readTexts,
  duplicateRatchet,
} = await import("../scripts/ci/playbook-duplicate-ratchet.ts");
const { REPO_ROOT } = await import("../scripts/ci/seam-check-lib.ts");

const words = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const toks = (s: string): string[] => tokenise(s).map((t: { text: string }) => t.text);

describe("playbook-duplicate-ratchet: tokenise", () => {
  test("lowercases, keeps [a-z0-9_-] runs and drops tokens with no alphanumeric", () => {
    assert.deepEqual(toks("Never `END_turn` -- on a (pending) wait-state, 2x _ !"), ["never", "end_turn", "on", "a", "pending", "wait-state", "2x"]);
  });

  test("frontmatter, fences (blockquote, nested, unclosed), comments and @include contribute nothing", () => {
    const src = [
      "---",
      "allowed_tools_claude: a b c",
      "---",
      "keep1",
      "````bash",
      "fenced1",
      "```text",
      "fenced2",
      "```",
      "fenced3",
      "````",
      "> ```",
      "> quoted-fence",
      "> ```",
      "<!-- comment1 -->",
      "<!--",
      "comment2",
      "-->",
      "@include _fragments/x.md",
      "keep2",
      "~~~",
      "unclosed-to-eof",
    ].join("\n");
    assert.deepEqual(toks(src), ["keep1", "keep2"]);
  });

  test("a token carries its 1-based source line", () => {
    assert.deepEqual(tokenise("a\n\nb c"), [
      { text: "a", line: 1 },
      { text: "b", line: 3 },
      { text: "c", line: 3 },
    ]);
  });
});

describe("playbook-duplicate-ratchet: spans", () => {
  const shared = words("s", MIN_SPAN_TOKENS);

  test("a span shared by two files counts once in each and names the partner", () => {
    const found = scanTexts({ "a.md": `x1 ${shared} y1`, "b.md": `z1 ${shared} z2` });
    assert.deepEqual(countSpans(found), { "a.md": 1, "b.md": 1 });
    assert.deepEqual(found["a.md"][0].partners, ["b.md"]);
    assert.equal(found["a.md"][0].tokens, MIN_SPAN_TOKENS);
    assert.equal(found["a.md"][0].line, 1);
  });

  test("a run shorter than the minimum is not a hit", () => {
    const short = words("s", MIN_SPAN_TOKENS - 1);
    assert.deepEqual(scanTexts({ "a.md": short, "b.md": short }), {});
  });

  test("adjacent shared windows merge into one maximal span", () => {
    const long = words("t", MIN_SPAN_TOKENS + 5);
    const found = scanTexts({ "a.md": long, "b.md": long });
    assert.equal(found["a.md"].length, 1);
    assert.equal(found["a.md"][0].tokens, MIN_SPAN_TOKENS + 5);
  });

  test("a span held by three files counts once per file", () => {
    const found = scanTexts({ "a.md": shared, "b.md": shared, "c.md": shared });
    assert.deepEqual(countSpans(found), { "a.md": 1, "b.md": 1, "c.md": 1 });
    assert.deepEqual(found["a.md"][0].partners, ["b.md", "c.md"]);
  });

  test("repetition inside one file is not a cross-file hit", () => {
    assert.deepEqual(scanTexts({ "a.md": `${shared}\n\n${shared}`, "b.md": "unrelated words only" }), {});
  });

  test("repetition inside one file is an intra row, never a cross row", () => {
    const rows = measureTexts({ "a.md": `${shared}\n\n${shared}`, "b.md": "unrelated words only" });
    assert.deepEqual(rows, { "a.md\tintra": 1 });
  });

  test("a passage stated three times counts once per extra occurrence", () => {
    const spans = findIntraSpans("a.md", tokenise(`${shared}\n\nx1 x2 x3\n\n${shared}\n\ny1 y2 y3\n\n${shared}`));
    assert.equal(spans.length, 2);
  });

  test("a passage stated once is not an intra hit, and fenced repeats are exempt", () => {
    assert.deepEqual(findIntraSpans("a.md", tokenise(shared)), []);
    assert.deepEqual(findIntraSpans("a.md", tokenise(["```", shared, "```", "```", shared, "```"].join("\n"))), []);
  });

  test("a passage cross-shared and self-repeated counts in both arms independently", () => {
    const rows = measureTexts({ "a.md": `${shared}\n\n${shared}`, "b.md": shared });
    assert.deepEqual(rows, { "a.md": 2, "b.md": 1, "a.md\tintra": 1 });
  });

  test("exempt text shared between files is not a hit", () => {
    const fenced = ["```", shared, "```"].join("\n");
    assert.deepEqual(scanTexts({ "a.md": fenced, "b.md": fenced }), {});
    const fm = ["---", shared, "---", "body"].join("\n");
    assert.deepEqual(scanTexts({ "a.md": fm, "b.md": fm }), {});
  });
});

describe("playbook-duplicate-ratchet: policy", () => {
  test("one required counted ceiling ratchet, stale rows hint, on its own baseline", () => {
    const p = duplicateRatchet.policy;
    assert.equal(p.id, "playbook-duplicate-ratchet");
    assert.equal(p.shape, "counted");
    assert.equal(p.polarity, "ceiling");
    assert.notEqual(p.stale, "fail");
    assert.equal(p.enforcement, "required");
    assert.match(p.baseline, /playbook-duplicate-baseline\.json$/);
  });

  test("the retired --files scope is refused as an unknown flag (exit 2)", async () => {
    assert.equal(await duplicateRatchet.main(["--files", "a.md"]), 2);
  });

  test("the remedy the module prints names STD-PLAYBOOK-ONE-HOME and _fragments/", () => {
    const help = (duplicateRatchet.policy.help ?? []).join("\n");
    assert.match(help, /STD-PLAYBOOK-ONE-HOME/);
    assert.match(help, /_fragments\//);
  });
});

describe("playbook-duplicate-ratchet: the real playbooks", () => {
  test("the standard the report points at defines STD-PLAYBOOK-ONE-HOME and names this ratchet", () => {
    const standard = readFileSync(join(REPO_ROOT, STANDARD_REL), "utf8");
    assert.match(standard, /^### STD-PLAYBOOK-ONE-HOME\n[\s\S]*?enforced-by: reviewer, scripts\/ci\/playbook-duplicate-ratchet\.ts/m);
  });

  test("measured keys are a bare playbook path or path+TAB+intra", async () => {
    const measured = measureTexts(readTexts(REPO_ROOT));
    for (const key of Object.keys(measured)) {
      assert.match(key, /^docs\/operator-playbooks\/[^\t]+\.md(\tintra)?$/, `bad key shape: ${JSON.stringify(key)}`);
    }
    assert.ok(Object.keys(measured).some((k) => k.endsWith("\tintra")), "at least one intra row is measured");
    assert.ok(Object.keys(measured).some((k) => !k.includes("\t")), "at least one bare cross-file row is measured");
  });
  test("the real playbooks stay at or under the committed baseline ceiling", async () => {
    const v = await duplicateRatchet.verdict(REPO_ROOT);
    assert.deepEqual(v.added, [], v.advice);
    assert.ok(v.ok, v.advice);
  });
  test("a bare cross-file key never carries the intra suffix (sibling shape)", () => {
    const rows = measureTexts({ "a.md": words("x", 20), "b.md": words("x", 20) });
    assert.deepEqual(Object.keys(rows).sort(), ["a.md", "b.md"]);
  });
});
