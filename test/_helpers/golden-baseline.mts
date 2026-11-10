/**
 * Golden-baseline helper (issue #5440, ADR-0043 Decision 4).
 *
 * A golden family whose collector returns one wide struct would otherwise
 * restate the whole struct in every fixture, so a new collector field re-records
 * every file. Instead each fixture stores only the TOP-LEVEL fields of that
 * struct that differ from one committed healthy baseline; a replay test merges
 * baseline + difference back into the full expected struct and still deep-equals
 * the collector's whole output against it, so the guard is unchanged.
 *
 * The merge is deliberately SHALLOW: a fixture that changes any part of a nested
 * field restates that whole field. A recursive merge would make array and
 * nested-object semantics ambiguous; a shallow one is trivially checkable.
 */
import { isDeepStrictEqual } from "node:util";

export type Struct = Record<string, unknown>;

/** Full expected struct = baseline with the fixture's differing top-level fields laid over it. */
export function mergeBaseline(baseline: Struct, difference: Struct): Struct {
  return { ...baseline, ...difference };
}

/**
 * The top-level fields of `full` that differ from `baseline` (deep equality per
 * field), in `full`'s key order. A field `full` lacks but the baseline has can
 * not be expressed by a shallow overlay, so it throws rather than recording a
 * difference that would merge back wrong.
 */
export function diffFromBaseline(baseline: Struct, full: Struct): Struct {
  for (const key of Object.keys(baseline)) {
    if (!(key in full)) {
      throw new Error(`golden-baseline: field "${key}" is in the baseline but absent from the output; a shallow overlay cannot express removal`);
    }
  }
  const out: Struct = {};
  for (const key of Object.keys(full)) {
    if (!(key in baseline) || !isDeepStrictEqual(baseline[key], full[key])) out[key] = full[key];
  }
  return out;
}
