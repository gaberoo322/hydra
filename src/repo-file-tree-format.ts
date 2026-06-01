/**
 * repo-file-tree-format.ts — Token-bounded formatting of a scoped file-tree
 * block for the planner prompt (issue #366).
 *
 * Shallow, string-building concern. Split out of the former monolithic
 * `repo-map.ts` (issue #805) so the formatter presents a small interface
 * independent of the import-graph machinery and the matcher.
 *
 * The only shared dependency is `isTestFile`, imported from
 * `repo-import-graph.ts` (its single home — no duplication).
 */

import { isTestFile } from "./repo-import-graph.ts";

/**
 * Format a list of files into a token-bounded human-readable block suitable
 * for injection into the planner prompt. Output format per line:
 *
 *   src/lib/foo.ts
 *   src/lib/foo.test.ts        [test]
 *
 * Uses the same ~4-chars-per-token approximation as `formatRepoMap()`.
 * Stops emitting lines when the budget would be exceeded and appends an
 * elision marker. Returns an empty string when `files` is empty.
 *
 * @param files       - Ordered list of paths (highest relevance first)
 * @param tokenBudget - Approximate token cap (default 2000 per issue #366 AC)
 */
export function formatScopedFileTree(
  files: string[],
  tokenBudget = 2000,
): string {
  if (files.length === 0) return "";
  const charsPerToken = 4;
  const charBudget = tokenBudget * charsPerToken;
  const lines: string[] = [];
  let totalChars = 0;
  let truncated = 0;

  for (const file of files) {
    const isTest = isTestFile(file);
    const line = isTest ? `${file}  [test]` : file;
    const cost = line.length + 1; // +1 for newline
    if (totalChars + cost > charBudget && lines.length > 0) {
      truncated = files.length - lines.length;
      break;
    }
    lines.push(line);
    totalChars += cost;
  }

  if (truncated > 0) {
    lines.push(`... (${truncated} more file(s) omitted to fit token budget)`);
  }
  return lines.join("\n");
}
