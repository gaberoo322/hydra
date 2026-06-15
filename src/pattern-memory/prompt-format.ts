/**
 * pattern-memory/prompt-format.ts — Pattern Memory prompt-rendering grammar
 *
 * Extracted from `agent-memory.ts` (issue #1937). This Module owns the one
 * self-contained concern that translates an agent's already-loaded Pattern
 * Memory into a prompt block: the `[prevent]`/`[reinforce]` section format,
 * the frequency-rank sort, the 10-item / 3-item caps, the PAST-OUTCOMES
 * fallback, and the `#804`/`#1455` `itemCount`-from-data contract.
 *
 * The store + promotion + stale-rule + migration concerns stay in
 * `agent-memory.ts`. This Module imports none of them — `formatMemoryForPrompt`
 * is a pure string-in / struct-out transform, so the rendering grammar is now
 * testable with a plain rendered-memory fixture (no Redis, no store state).
 *
 * Issue #1937 explicitly DEFERS the interface redesign (taking `MemoryPattern[]`
 * directly instead of the pre-rendered `string`) to a future `hydra-grill`
 * run. This extraction is behaviour-preserving: the signature and logic are
 * moved verbatim.
 *
 * Sole production caller: `src/learning.ts` (the `agent-memory` learning block).
 */

/**
 * Render the agent's Pattern Memory into a prompt block AND report how many
 * promoted-pattern groups it actually emitted.
 *
 * Issue #1455 — the count is sourced from the structured group list this
 * function assembles (the `prevent`/`reinforce` blocks that survive the
 * frequency-rank cap), NOT regex-scanned out of the rendered markdown at the
 * composition seam. The #804 count-from-data contract requires `itemCount` to
 * come from the underlying data; counting the groups here — where the data is
 * still structured — is the data source. `content` is "" / `itemCount` 0 when
 * the agent has no renderable patterns.
 */
export function formatMemoryForPrompt(
  memory: string,
  agentName: string,
): { content: string; itemCount: number } {
  if (!memory || memory.trim().length === 0) return { content: "", itemCount: 0 };

  const blocks = memory.split(/^(?=### \[)/m).filter(r => r.trim().startsWith("### ["));
  if (blocks.length === 0) {
    const lines = memory.split("\n").filter(l => l.startsWith("- ") || l.startsWith("ACTION:"));
    if (lines.length === 0) return { content: "", itemCount: 0 };
    const kept = lines.slice(-10);
    return {
      content: `\n## PAST OUTCOMES (learn from these)\n${kept.join("\n")}\n`,
      itemCount: kept.length,
    };
  }

  const preventBlocks = blocks.filter(b => b.includes("[prevent]"));
  const reinforceBlocks = blocks.filter(b => b.includes("[reinforce]"));

  const parts: string[] = [];
  // itemCount tracks the promoted-pattern GROUPS actually rendered into the
  // prompt — one per `### [severity]` block emitted, counted from the block
  // list here rather than re-parsed from the final string.
  let itemCount = 0;

  if (preventBlocks.length > 0) {
    parts.push(`\n## PREVENTION PATTERNS (ranked by frequency — follow these)`);
    const sorted = preventBlocks.sort((a, b) => {
      const countA = parseInt(a.match(/\((\d+)x\)/)?.[1] || "0");
      const countB = parseInt(b.match(/\((\d+)x\)/)?.[1] || "0");
      return countB - countA;
    });
    for (const block of sorted.slice(0, 10)) {
      const lines = block.split("\n").filter(l =>
        l.startsWith("ACTION:") || l.startsWith("LAST:") || l.startsWith("### [")
      );
      if (lines.length > 0) {
        parts.push(lines.join("\n"));
        itemCount++;
      }
    }
  }

  if (reinforceBlocks.length > 0 && reinforceBlocks.length <= 5) {
    parts.push(`\n## REINFORCED PATTERNS (these approaches have worked)`);
    for (const block of reinforceBlocks.slice(-3)) {
      const lines = block.split("\n").filter(l =>
        l.startsWith("ACTION:") || l.startsWith("LAST:") || l.startsWith("### [")
      );
      if (lines.length > 0) {
        parts.push(lines.join("\n"));
        itemCount++;
      }
    }
  }

  if (parts.length === 0) return { content: "", itemCount: 0 };
  return { content: parts.join("\n\n") + "\n", itemCount };
}
