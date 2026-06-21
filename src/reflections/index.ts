/**
 * reflections/index.ts — Reflections domain coordinator + axis re-exports
 *
 * The `src/reflections/` domain exposes two axes of reflection reads:
 *   - per-anchor episodic (`./per-anchor.ts`) — the LIFO store keyed on a
 *     single anchor reference.
 *   - by-file cross-anchor (`./by-file.ts`) — the fan-out index that surfaces
 *     reflections from OTHER anchors that touched the same file(s).
 *
 * Callers that want "all reflections relevant to an anchor" (the live #841
 * injection path in `src/api/reflections.ts`, and `getContext()`'s composition
 * in `src/api/learning.ts`) previously each re-derived the same four-step
 * composition inline:
 *   1. extract file keys from the anchor (`extractFilesFromAnchor`),
 *   2. read the per-anchor axis (`loadAnchorReflections`),
 *   3. read the by-file axis (`loadAnchorReflectionsByFile`) gated on (1),
 *   4. combine the two `ReflectionBlock`s (concatenate content, sum counts).
 *
 * This coordinator (issue #2232) owns that two-axis composition so the callers
 * collapse to a single call and no longer need to know the domain's internal
 * axis structure. Adding a third axis later is a change HERE, not in N callers.
 *
 * The narrower per-axis helpers (`loadAnchorReflectionsRaw`,
 * `extractFilesFromAnchor`, the single-axis reads) stay exported from their
 * own modules and re-exported here, so callers with single-axis needs
 * (`retro-bundle.ts` wants only raw per-anchor records; `anchor-candidates.ts`
 * reads raw reflections for scoring, not for prompt assembly) keep importing
 * exactly the axis they use.
 */

import { loadAnchorReflections, type ReflectionBlock } from "./per-anchor.ts";
import {
  loadAnchorReflectionsByFile,
  extractFilesFromAnchor,
} from "./by-file.ts";

// Re-export only the single-axis reads that callers actually reach through
// this domain entry point (`learning-context.ts` consumes both as its default
// axis readers) plus the shared `ReflectionBlock` shape. The narrower per-axis
// helpers (`loadAnchorReflectionsRaw`, `recordAnchorReflection`, `reflectionKey`,
// `extractFilesFromAnchor`, the TTL/cap constants, the `AnchorReflection`
// record type, …) stay exported from their own modules — callers that need
// them import directly from `./per-anchor.ts` / `./by-file.ts`, so re-exporting
// them here only added dead surface (issue #2302).
export {
  loadAnchorReflections,
  type ReflectionBlock,
} from "./per-anchor.ts";
export { loadAnchorReflectionsByFile } from "./by-file.ts";

/**
 * The combined result of `loadReflectionsForAnchor`: the merged narrative
 * plus the two per-axis blocks that composed it.
 *
 * `combined.content` is the two axes' content joined by a blank line (the
 * SAME `\n\n` join the live `/api/reflections` route emitted inline), and
 * `combined.count` is the sum of the two axis counts. The individual
 * `perAnchor` / `byFile` blocks are surfaced so callers that attribute the
 * narrative per axis (the API route's `blocks: [{source, count}, ...]` list,
 * `getContext()`'s per-source trace) read the counts as data instead of
 * re-reading either axis.
 */
export interface CombinedReflections {
  /** Two axes merged: content `\n\n`-joined, count summed. */
  combined: ReflectionBlock;
  /** The per-anchor episodic axis result. */
  perAnchor: ReflectionBlock;
  /** The by-file cross-anchor axis result ({content:"",count:0} when no scope files). */
  byFile: ReflectionBlock;
}

/**
 * Injectable axis-reader surface for `loadReflectionsForAnchor` (issue #2232).
 *
 * Both fields are OPTIONAL and default to the real per-anchor / by-file reads,
 * mirroring the optional-deps-bag idiom already used by `getContext`'s
 * `GetContextDeps` (src/api/learning.ts) — so a test can pin the composition
 * (file extraction, parallel fan-out, content/count merge) without a Redis
 * connection, while production callers pass no `deps` and observe identical
 * behaviour.
 */
export interface LoadReflectionsDeps {
  loadAnchorReflections?: (anchorRef: string) => Promise<ReflectionBlock>;
  loadAnchorReflectionsByFile?: (
    files: string[],
    excludeAnchorRef?: string,
  ) => Promise<ReflectionBlock>;
}

/**
 * Coordinator: load ALL reflections relevant to an anchor across both axes.
 *
 * Given an anchor reference and optional scope files, this:
 *   1. derives file keys via `extractFilesFromAnchor(anchorRef, scopeFiles)`,
 *   2. reads the per-anchor axis and (when files were derived) the by-file axis
 *      IN PARALLEL — neither read mutates state, so unlike `getContext`'s
 *      backfill-then-read ordering there is no sequencing constraint here,
 *   3. merges the two `ReflectionBlock`s into `combined` (content `\n\n`-joined
 *      dropping empties, count summed) and returns the per-axis blocks too.
 *
 * A total miss (no per-anchor reflections AND no by-file matches) yields
 * `combined: { content: "", count: 0 }` so a caller can graceful-degrade to a
 * no-op injection — matching the live `/api/reflections` miss contract.
 *
 * The `deps` bag is for testing only; production callers omit it.
 */
export async function loadReflectionsForAnchor(
  anchorRef: string,
  opts?: { scopeFiles?: string[]; deps?: LoadReflectionsDeps },
): Promise<CombinedReflections> {
  const loadPerAnchor = opts?.deps?.loadAnchorReflections ?? loadAnchorReflections;
  const loadByFile = opts?.deps?.loadAnchorReflectionsByFile ?? loadAnchorReflectionsByFile;

  const files = extractFilesFromAnchor(anchorRef, opts?.scopeFiles);

  const [perAnchor, byFile] = await Promise.all([
    loadPerAnchor(anchorRef),
    files.length > 0
      ? loadByFile(files, anchorRef)
      : Promise.resolve<ReflectionBlock>({ content: "", count: 0 }),
  ]);

  const content = [perAnchor.content, byFile.content].filter(Boolean).join("\n\n");
  const count = perAnchor.count + byFile.count;

  return {
    combined: { content, count },
    perAnchor,
    byFile,
  };
}
