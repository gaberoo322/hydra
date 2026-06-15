/**
 * reflections/by-file.ts — By-file fan-out reflection index (issue #326)
 *
 * The secondary, many-to-many index that maps file paths to anchor reflections
 * across ALL anchors that touched those files. Split out of the former
 * `reflections/reflections.ts` catch-all (issue #1938) so the fan-out concern
 * lives in a Module whose name reflects its purpose, separate from the
 * per-anchor episodic store in `./per-anchor.ts`.
 *
 * Public API used outside this module:
 *   extractFilesFromAnchor  — file-path extraction heuristic (by-file keying)
 *   loadAnchorReflectionsByFile / backfillByFileIndex
 *
 * Redis key shape: `hydra:reflections:byfile:{filepath}` (a SET of anchor keys),
 * accessed through the `src/redis/reflections.ts` adapter. The fan-out has its
 * own cap (`MAX_BY_FILE_REFLECTIONS`) distinct from the per-anchor cap.
 *
 * `learning.ts` consumes this surface as its `by-file-reflections`
 * LearningContextSource block, independent of the `per-anchor-reflections`
 * block sourced from `./per-anchor.ts`.
 */

import {
  getAnchorReflections,
  addReflectionToFileIndex,
  getReflectionKeysByFile,
} from "../redis/reflections.ts";
import {
  REFLECTION_TTL,
  reflectionKey,
  type AnchorReflection,
  type ReflectionBlock,
} from "./per-anchor.ts";

// ===========================================================================
// Constants
// ===========================================================================

/**
 * Cap for by-file fan-out (issue #326). When a planner anchor touches a hot
 * file, we want a useful slice of recent reflections — not all 50 of them.
 */
export const MAX_BY_FILE_REFLECTIONS = 5;

// ===========================================================================
// File-path extraction
// ===========================================================================

/**
 * Extract files an anchor likely touches, for by-file index keying (issue #326).
 *
 * Sources, in priority order:
 *   1. Caller-supplied scope files (from `scopeBoundary.in`).
 *   2. File-path tokens parsed out of `anchorRef`.
 *
 * Returns a deduped list of normalized file paths. Heuristics:
 *   - We look for path-shaped tokens: optional leading `./`, then one or more
 *     `segment/` parts, ending in a file with a known source/test extension.
 *   - We accept extensions used in this repo (`.ts`, `.tsx`, `.js`, `.mjs`,
 *     `.mts`, `.cjs`, `.json`, `.yaml`, `.yml`, `.md`).
 *   - We strip surrounding backticks, parentheses, quotes, trailing punctuation.
 *
 * Conservative on purpose — false positives expand the by-file fan-out, false
 * negatives just degrade to legacy-key-only behavior. Pure function, exported
 * for unit testing.
 */
export function extractFilesFromAnchor(
  anchorRef: string,
  scopeFiles?: string[] | null,
): string[] {
  const out = new Set<string>();

  // 1. Caller-supplied scope.in wins — already normalized by the planner.
  if (Array.isArray(scopeFiles)) {
    for (const raw of scopeFiles) {
      const f = normalizeFilePath(raw);
      if (f) out.add(f);
    }
  }

  // 2. Path-shaped tokens in the anchor reference string.
  if (typeof anchorRef === "string" && anchorRef.length > 0) {
    // Allow optional ./, segment/segment/.../name.ext; segments may contain
    // letters, digits, _, -, .
    const re = /(?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|mts|cjs|json|yaml|yml|md)\b/g;
    const matches = anchorRef.match(re) || [];
    for (const m of matches) {
      const f = normalizeFilePath(m);
      if (f) out.add(f);
    }
  }

  return [...out];
}

/**
 * Normalize a file path token for indexing.
 * Strips wrapping punctuation, leading `./`, trailing colons/commas/etc.
 * Returns "" if the token doesn't look like a file path.
 */
function normalizeFilePath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  // Strip wrapping punctuation: backticks, quotes, parens, brackets.
  s = s.replace(/^[`'"(\[]+/, "").replace(/[`'")\],.:;]+$/, "");
  // Strip leading "./"
  s = s.replace(/^\.\//, "");
  if (!s) return "";
  // Must look path-shaped: at least one slash and a dotted extension.
  if (!/\//.test(s)) return "";
  if (!/\.[A-Za-z0-9]+$/.test(s)) return "";
  return s;
}

// ===========================================================================
// By-file fan-out reads + backfill
// ===========================================================================

/**
 * Load per-anchor reflections that match by-file (issue #326).
 *
 * For each file in `files`, look up the by-file index, then load each
 * reflection list, exclude reflections whose anchor matches `excludeAnchorRef`
 * (caller already loaded those via the primary key), dedup by cycleId, sort
 * by recency, and cap at `MAX_BY_FILE_REFLECTIONS`.
 *
 * Returns a formatted markdown block ready for planner-context injection, or
 * an empty string if no by-file matches were found.
 *
 * Failure-tolerant: any per-file lookup that fails is logged and skipped.
 */
export async function loadAnchorReflectionsByFile(
  files: string[],
  excludeAnchorRef?: string,
): Promise<ReflectionBlock> {
  if (!Array.isArray(files) || files.length === 0) return { content: "", count: 0 };

  const excludeKey = excludeAnchorRef ? reflectionKey(excludeAnchorRef) : null;
  const collected: Array<AnchorReflection & { __file: string }> = [];
  const seenAnchorKeys = new Set<string>();

  for (const file of files) {
    let anchorKeys: string[] = [];
    try {
      anchorKeys = await getReflectionKeysByFile(file);
    } catch (err: any) {
      console.error(`[Learning] By-file index read failed for "${file}": ${err.message}`);
      continue;
    }

    for (const anchorKey of anchorKeys) {
      if (excludeKey && anchorKey === excludeKey) continue;
      if (seenAnchorKeys.has(anchorKey)) continue;
      seenAnchorKeys.add(anchorKey);

      try {
        const raw = await getAnchorReflections(anchorKey);
        for (const entry of raw) {
          try {
            const parsed = JSON.parse(entry) as AnchorReflection;
            collected.push({ ...parsed, __file: file });
          } catch { /* intentional: skip unparseable entries */ }
        }
      } catch (err: any) {
        console.error(`[Learning] By-file reflection load failed for "${anchorKey}": ${err.message}`);
      }
    }
  }

  if (collected.length === 0) return { content: "", count: 0 };

  // Dedup by cycleId — same reflection may be indexed under multiple files.
  const byCycle = new Map<string, AnchorReflection & { __file: string }>();
  for (const r of collected) {
    if (!byCycle.has(r.cycleId)) byCycle.set(r.cycleId, r);
  }

  // Sort by timestamp, most recent first. Fallback to insertion order if
  // timestamps are missing.
  const ordered = [...byCycle.values()].sort((a, b) => {
    const ta = a.timestamp || "";
    const tb = b.timestamp || "";
    return tb.localeCompare(ta);
  }).slice(0, MAX_BY_FILE_REFLECTIONS);

  const lines = [
    `## RELATED FILES — Prior Failures (${ordered.length} matched by file)`,
    ``,
    `IMPORTANT: Different anchors previously failed while touching the same file(s). Read these before re-attempting similar work.`,
    ``,
  ];

  for (const ref of ordered) {
    lines.push(`### ${ref.cycleId} (file: ${ref.__file})`);
    lines.push(`- **Anchor**: ${ref.anchorRef}`);
    lines.push(`- **Task**: ${ref.taskTitle}`);
    lines.push(`- **Outcome**: ${ref.outcome}`);
    lines.push(`- **Why it failed**: ${ref.whyItFailed}`);
    lines.push(`- **Advice**: ${ref.whatShouldChange}`);
    lines.push(``);
  }

  return { content: lines.join("\n"), count: ordered.length };
}

/**
 * Opportunistic backfill: when the legacy per-anchor key is hit, also index it
 * under each file it touches so the new secondary index warms organically
 * without requiring a one-shot migration. Idempotent — SADD is a no-op on
 * duplicates. Failure-tolerant.
 *
 * Issue #326 acceptance criterion: "Backfill on read: when an old reflection
 * is hit by the legacy path, opportunistically index it under `by-file:` so
 * the new index warms organically."
 */
export async function backfillByFileIndex(
  anchorRef: string,
  scopeFiles?: string[] | null,
): Promise<number> {
  try {
    const files = extractFilesFromAnchor(anchorRef, scopeFiles);
    if (files.length === 0) return 0;
    const key = reflectionKey(anchorRef);
    for (const file of files) {
      await addReflectionToFileIndex(file, key, REFLECTION_TTL);
    }
    return files.length;
  } catch (err: any) {
    console.error(`[Learning] By-file backfill failed for "${anchorRef.slice(0, 60)}": ${err.message}`);
    return 0;
  }
}
