/**
 * Unit tests for the Pattern Memory prompt-rendering grammar
 * (`formatMemoryForPrompt`), extracted into `src/pattern-memory/prompt-format.ts`
 * by issue #1937.
 *
 * Before the extraction `formatMemoryForPrompt` had ZERO direct unit tests — it
 * was exercised only transitively through `getContext()` integration paths,
 * which required the full Redis-backed store pipeline to be wired up. Because
 * the grammar is now a pure string-in / struct-out transform in its own Module,
 * these tests pin its observable contracts against plain rendered-memory
 * fixtures with no store setup:
 *
 *   - the `[prevent]`/`[reinforce]` section format
 *   - the frequency-rank sort of prevention blocks (descending `(Nx)`)
 *   - the 10-item prevention cap and the 3-item reinforced cap
 *   - the `<= 5` reinforced-block guard
 *   - the PAST-OUTCOMES fallback when no `### [` blocks are present
 *   - the #804/#1455 `itemCount`-from-data contract (count == rendered groups)
 *   - empty / whitespace input → `{ content: "", itemCount: 0 }`
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatMemoryForPrompt } from "../src/pattern-memory/prompt-format.ts";

/** Build one rendered `### [severity] category (Nx)` block the way loadAgentMemory does. */
function block(severity: string, category: string, hits: number, action: string): string {
  return [
    `### [${severity}] ${category} (${hits}x)`,
    `ACTION: ${action}`,
    `LAST: cycle-${category} — example for ${category}`,
    "",
  ].join("\n");
}

describe("formatMemoryForPrompt — empty / no-op inputs", () => {
  test("empty string yields empty content and zero count", () => {
    assert.deepEqual(formatMemoryForPrompt("", "dev"), { content: "", itemCount: 0 });
  });

  test("whitespace-only string yields empty content and zero count", () => {
    assert.deepEqual(formatMemoryForPrompt("   \n\t ", "dev"), { content: "", itemCount: 0 });
  });

  test("blocks present but none prevent/reinforce yields empty content", () => {
    // A `### [info]` block is neither [prevent] nor [reinforce], so nothing renders.
    const memory = block("info", "noise", 4, "do nothing");
    assert.deepEqual(formatMemoryForPrompt(memory, "dev"), { content: "", itemCount: 0 });
  });
});

describe("formatMemoryForPrompt — prevention patterns", () => {
  test("renders the PREVENTION PATTERNS header and one group per prevent block", () => {
    const memory = block("prevent", "scope-creep", 5, "stay in scope");
    const { content, itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.match(content, /## PREVENTION PATTERNS/);
    assert.match(content, /ACTION: stay in scope/);
    assert.equal(itemCount, 1);
  });

  test("sorts prevention blocks by frequency descending", () => {
    const memory = [
      block("prevent", "low", 2, "low action"),
      block("prevent", "high", 99, "high action"),
      block("prevent", "mid", 10, "mid action"),
    ].join("\n");
    const { content } = formatMemoryForPrompt(memory, "dev");
    const idxHigh = content.indexOf("high action");
    const idxMid = content.indexOf("mid action");
    const idxLow = content.indexOf("low action");
    assert.ok(idxHigh < idxMid, "99x block should precede 10x block");
    assert.ok(idxMid < idxLow, "10x block should precede 2x block");
  });

  test("caps prevention blocks at 10 and counts only rendered groups", () => {
    // 12 prevent blocks — only the top 10 by frequency render and count.
    const memory = Array.from({ length: 12 }, (_, i) =>
      block("prevent", `cat${i}`, i + 1, `action ${i}`),
    ).join("\n");
    const { itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.equal(itemCount, 10);
  });
});

describe("formatMemoryForPrompt — reinforced patterns", () => {
  test("renders the REINFORCED PATTERNS header and caps at the last 3", () => {
    // 4 reinforce blocks (<= 5 guard satisfied); only the last 3 render.
    const memory = [
      block("reinforce", "r0", 1, "r0 action"),
      block("reinforce", "r1", 1, "r1 action"),
      block("reinforce", "r2", 1, "r2 action"),
      block("reinforce", "r3", 1, "r3 action"),
    ].join("\n");
    const { content, itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.match(content, /## REINFORCED PATTERNS/);
    assert.equal(itemCount, 3, "only the last 3 reinforce blocks render");
    assert.doesNotMatch(content, /r0 action/, "the oldest reinforce block is dropped by the slice(-3)");
    assert.match(content, /r3 action/);
  });

  test("more than 5 reinforce blocks suppresses the reinforced section", () => {
    // The `<= 5` guard means 6 reinforce blocks render NO reinforced section.
    const memory = Array.from({ length: 6 }, (_, i) =>
      block("reinforce", `r${i}`, 1, `action ${i}`),
    ).join("\n");
    const { content, itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.doesNotMatch(content, /REINFORCED PATTERNS/);
    assert.equal(itemCount, 0);
  });
});

describe("formatMemoryForPrompt — combined sections + itemCount-from-data (#804/#1455)", () => {
  test("itemCount equals the total rendered groups across both sections", () => {
    const memory = [
      block("prevent", "p0", 3, "p0 action"),
      block("prevent", "p1", 7, "p1 action"),
      block("reinforce", "r0", 1, "r0 action"),
    ].join("\n");
    const { content, itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.match(content, /## PREVENTION PATTERNS/);
    assert.match(content, /## REINFORCED PATTERNS/);
    // 2 prevent groups + 1 reinforce group = 3, counted from the data, not
    // regex-scanned out of the final markdown.
    assert.equal(itemCount, 3);
  });
});

describe("formatMemoryForPrompt — PAST OUTCOMES fallback", () => {
  test("renders trailing outcome lines when there are no ### [ blocks", () => {
    const memory = [
      "- outcome one",
      "ACTION: did a thing",
      "- outcome two",
    ].join("\n");
    const { content, itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.match(content, /## PAST OUTCOMES \(learn from these\)/);
    assert.match(content, /outcome two/);
    assert.equal(itemCount, 3, "all three matching lines are kept (under the 10 cap)");
  });

  test("caps the PAST OUTCOMES fallback at the last 10 lines", () => {
    const memory = Array.from({ length: 14 }, (_, i) => `- outcome ${i}`).join("\n");
    const { itemCount } = formatMemoryForPrompt(memory, "dev");
    assert.equal(itemCount, 10);
  });

  test("fallback with no matching lines yields empty content", () => {
    const memory = "some heading\nplain prose with no bullet or ACTION line";
    assert.deepEqual(formatMemoryForPrompt(memory, "dev"), { content: "", itemCount: 0 });
  });
});
