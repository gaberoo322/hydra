/**
 * reflections/reflections.ts — Back-compat re-export barrel (issue #1938)
 *
 * The former single-file module owning both reflection access surfaces has been
 * split into two sibling Modules whose names reflect their distinct concerns:
 *
 *   - `./per-anchor.ts` — the per-anchor episodic LIFO store
 *     (`recordAnchorReflection`, `loadAnchorReflections`,
 *      `loadAnchorReflectionsRaw`, `reflectionKey`, the `AnchorReflection` /
 *      `ReflectionBlock` types, the per-anchor TTL + cap constants,
 *      `closeReflectionsRedis`).
 *   - `./by-file.ts` — the by-file fan-out index
 *     (`loadAnchorReflectionsByFile`, `backfillByFileIndex`,
 *      `extractFilesFromAnchor`, the by-file cap).
 *
 * This barrel preserves the original import surface so existing callers
 * (`learning.ts`, `api/reflections.ts`, `anchor-candidates.ts`,
 * `autopilot/retro-bundle.ts`, `autopilot/runs.ts`) and tests keep working
 * unchanged while new code can import from the concern-specific Modules
 * directly. `learning.ts` already treats the two surfaces as independent
 * `per-anchor-reflections` / `by-file-reflections` LearningContextSource blocks
 * — this split makes the Module structure match what the caller already knows.
 */

export {
  REFLECTION_TTL,
  MAX_REFLECTIONS_PER_ANCHOR,
  reflectionKey,
  recordAnchorReflection,
  loadAnchorReflections,
  loadAnchorReflectionsRaw,
  closeReflectionsRedis,
  type AnchorReflection,
  type ReflectionBlock,
} from "./per-anchor.ts";

export {
  MAX_BY_FILE_REFLECTIONS,
  extractFilesFromAnchor,
  loadAnchorReflectionsByFile,
  backfillByFileIndex,
} from "./by-file.ts";
