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
  backfillByFileIndex,
  extractFilesFromAnchor,
} from "./by-file.ts";

// Re-export the two axes + their pure helpers so callers can reach either the
// coordinator or a single axis through one domain entry point.
export {
  loadAnchorReflections,
  loadAnchorReflectionsRaw,
  recordAnchorReflection,
  reflectionKey,
  closeReflectionsRedis,
  REFLECTION_TTL,
  MAX_REFLECTIONS_PER_ANCHOR,
  type AnchorReflection,
  type ReflectionBlock,
} from "./per-anchor.ts";
export {
  loadAnchorReflectionsByFile,
  backfillByFileIndex,
  extractFilesFromAnchor,
  MAX_BY_FILE_REFLECTIONS,
} from "./by-file.ts";

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
  /**
   * Issue #2238: the opportunistic by-file backfill write. Only consulted when
   * `backfillOnHit` is set. Injectable so a test can assert the
   * backfill-before-by-file SEQUENCING without a Redis connection; production
   * callers omit it and get the real `backfillByFileIndex`.
   */
  backfillByFileIndex?: (
    anchorRef: string,
    scopeFiles?: string[] | null,
  ) => Promise<string[]>;
}

/**
 * Coordinator: load ALL reflections relevant to an anchor across both axes.
 *
 * Given an anchor reference and optional scope files, this:
 *   1. derives file keys via `extractFilesFromAnchor(anchorRef, scopeFiles)`,
 *   2. reads the per-anchor axis,
 *   3. (issue #2238, only when `backfillOnHit` is set AND the per-anchor axis
 *      HIT) runs the opportunistic by-file backfill and AWAITS it,
 *   4. reads the by-file axis (when files were derived),
 *   5. merges the two `ReflectionBlock`s into `combined` (content `\n\n`-joined
 *      dropping empties, count summed) and returns the per-axis blocks too.
 *
 * The backfill→by-file ORDERING is the reason this coordinator can host the
 * sequencing that used to live as a prose comment in `getContext()`: when
 * `backfillOnHit` is set, the backfill write commits BEFORE the by-file read,
 * expressed structurally as sequential `await`s rather than a comment a future
 * maintainer could parallelise away (issue #2238). When `backfillOnHit` is NOT
 * set (the live `/api/reflections` injection path), the two axis reads run IN
 * PARALLEL — neither read mutates state, so there is no sequencing constraint.
 *
 * A total miss (no per-anchor reflections AND no by-file matches) yields
 * `combined: { content: "", count: 0 }` so a caller can graceful-degrade to a
 * no-op injection — matching the live `/api/reflections` miss contract.
 *
 * The `deps` bag is for testing only; production callers omit it.
 */
export async function loadReflectionsForAnchor(
  anchorRef: string,
  opts?: {
    scopeFiles?: string[];
    /**
     * Issue #2238: when true, run the opportunistic by-file backfill on a
     * per-anchor HIT and serialise it BEFORE the by-file read (the ordering
     * `getContext()` used to express inline). When false/omitted, the two
     * axis reads fan out in parallel (the `/api/reflections` path).
     */
    backfillOnHit?: boolean;
    deps?: LoadReflectionsDeps;
  },
): Promise<CombinedReflections> {
  const loadPerAnchor = opts?.deps?.loadAnchorReflections ?? loadAnchorReflections;
  const loadByFile = opts?.deps?.loadAnchorReflectionsByFile ?? loadAnchorReflectionsByFile;
  const backfill = opts?.deps?.backfillByFileIndex ?? backfillByFileIndex;

  const files = extractFilesFromAnchor(anchorRef, opts?.scopeFiles);
  const readByFile = (): Promise<ReflectionBlock> =>
    files.length > 0
      ? loadByFile(files, anchorRef)
      : Promise.resolve<ReflectionBlock>({ content: "", count: 0 });

  let perAnchor: ReflectionBlock;
  let byFile: ReflectionBlock;

  if (opts?.backfillOnHit) {
    // Backfill-then-read ordering (issue #2238): the per-anchor read happens
    // first, then (only on a HIT) the opportunistic by-file backfill write is
    // awaited, and only then does the by-file read run — so a freshly
    // backfilled entry can never be missed by the by-file fan-out. The
    // sequencing lives here as `await`s instead of a comment in `getContext()`.
    perAnchor = await loadPerAnchor(anchorRef);
    if (perAnchor.count > 0) {
      // Backfill is opportunistic + failure-tolerant (it returns [] on any
      // error and logs internally), so it never blocks the by-file read.
      await backfill(anchorRef, opts?.scopeFiles);
    }
    byFile = await readByFile();
  } else {
    // No backfill: neither read mutates state, so fan them out in parallel.
    [perAnchor, byFile] = await Promise.all([loadPerAnchor(anchorRef), readByFile()]);
  }

  const content = [perAnchor.content, byFile.content].filter(Boolean).join("\n\n");
  const count = perAnchor.count + byFile.count;

  return {
    combined: { content, count },
    perAnchor,
    byFile,
  };
}
