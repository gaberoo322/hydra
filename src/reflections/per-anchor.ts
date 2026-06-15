/**
 * reflections/per-anchor.ts — Per-anchor episodic reflection store
 *
 * The LIFO push/pop store keyed on anchor reference, with a 7-day TTL and a
 * 5-reflection cap. Holds the Reflexion-style reflection state used to inject
 * failure context into future planner calls for the SAME anchor. Split out of
 * the former `reflections/reflections.ts` catch-all (issue #1938) so the
 * per-anchor episodic concern is isolated from the by-file fan-out index in
 * `./by-file.ts`.
 *
 * Issue #1454: the dead global reflection buffer subsystem
 * (recordReflection / loadRelevantReflections / formatReflectionsForPrompt /
 * clearReflectionsForAnchor / getAllReflections / consolidateReflections and
 * the GlobalReflection type) was deleted. It had no live producers after the
 * codex control loop was retired; the live #841 injection path reads only the
 * per-anchor + by-file stores.
 *
 * Public API used outside this module:
 *   recordAnchorReflection / loadAnchorReflections / loadAnchorReflectionsRaw
 *   reflectionKey
 *   ReflectionBlock {content,count} — the count is sourced here so callers
 *   don't regex the rendered header
 *   closeReflectionsRedis      — kept for test back-compat (no-op)
 *
 * Constants (REFLECTION_TTL etc.) live here so callers don't reach into
 * learning.ts internals. `recordAnchorReflection`'s additive by-file index
 * write is delegated to `backfillByFileIndex` in `./by-file.ts` so this Module
 * imports only its own per-anchor Redis primitives.
 */

import {
  REFLECTION_PREFIX,
  getAnchorReflections,
  pushAnchorReflection,
} from "../redis/reflections.ts";
import { backfillByFileIndex } from "./by-file.ts";

// ===========================================================================
// Constants
// ===========================================================================

export const REFLECTION_TTL = 7 * 24 * 60 * 60; // 7 days
export const MAX_REFLECTIONS_PER_ANCHOR = 5;

// ===========================================================================
// Types
// ===========================================================================

export type AnchorReflection = {
  cycleId: string;
  anchorRef: string;
  taskTitle: string;
  outcome: string;
  reason: string;
  whatWasAttempted: string;
  whyItFailed: string;
  whatShouldChange: string;
  timestamp: string;
};

/**
 * A formatted reflection block plus the structured count of items it carries.
 *
 * Issue #804: the count is sourced HERE — from the parsed reflection array —
 * so downstream telemetry (`reflectionSources`) reads it as data instead of
 * regex-scanning the rendered `## PRIOR ATTEMPTS (N…` header out of the
 * formatted markdown. `content` is "" exactly when `count === 0`.
 */
export interface ReflectionBlock {
  content: string;
  count: number;
}

// ===========================================================================
// Per-anchor episodic reflections
// ===========================================================================

export function reflectionKey(anchorRef: string): string {
  return REFLECTION_PREFIX + (anchorRef || "unknown").replace(/\s+/g, "-").toLowerCase().slice(0, 120);
}

export async function recordAnchorReflection(opts: {
  cycleId: string;
  anchorRef: string;
  taskTitle: string;
  outcome: string;
  reason: string;
  filesChanged?: string[];
  verificationErrors?: string[];
  /** Issue #326: scope files (from `scopeBoundary.in`) for by-file indexing. */
  scopeFiles?: string[];
  /**
   * Optional pre-formed advice override (issue #1356). When supplied, it is
   * stored verbatim as `whatShouldChange` instead of being re-derived via
   * `generateAdvice`. The buffer-consolidation path passes the richer
   * `whatToTryDifferently` narrative through here so the per-anchor row keeps
   * full fidelity while STILL flowing through this single write primitive
   * (so the ring cap, TTL, cycleId dedup, and by-file index all stay in force —
   * artifact invariant #2). Fresh reap writes omit it and get `generateAdvice`.
   */
  whatShouldChange?: string;
  /**
   * Pre-formed timestamp override (issue #1356). Consolidation preserves the
   * buffered entry's original failure time rather than stamping "now", so the
   * per-anchor recency ordering reflects when the failure actually happened.
   */
  timestamp?: string;
}): Promise<{ written: boolean }> {
  const key = reflectionKey(opts.anchorRef);

  // Idempotency on cycleId (issue #1119): the reap-side producer keys each
  // record on the autopilot task_id, and re-invocation for the SAME reaped
  // dispatch (a retried POST, overlapping reaps) must be a no-op rather than
  // pushing a duplicate prior-attempt narrative. The store's push is otherwise
  // an unconditional rpush, so we dedup here — if a record with this cycleId
  // already exists for the anchor, skip the write. A non-empty cycleId is
  // required for the dedup to bite; callers always supply one (the wrapper
  // synthesises a stable id when the body omits it).
  if (opts.cycleId) {
    try {
      const existing = await getAnchorReflections(key);
      for (const raw of existing) {
        try {
          const parsed = JSON.parse(raw) as { cycleId?: string };
          if (parsed?.cycleId === opts.cycleId) {
            // Already recorded for this dispatch — converge harmlessly.
            return { written: false };
          }
        } catch {
          /* intentional: skip malformed entry during dedup scan */
        }
      }
    } catch (err: any) {
      // A dedup-scan failure must not block the write — fall through and push.
      // Worst case is a duplicate narrative, never a lost one.
      console.error(`[Learning] cycleId dedup scan failed for "${opts.anchorRef.slice(0, 60)}": ${err.message}`);
    }
  }

  const reflection: AnchorReflection = {
    cycleId: opts.cycleId,
    anchorRef: opts.anchorRef,
    taskTitle: opts.taskTitle,
    outcome: opts.outcome,
    reason: opts.reason,
    whatWasAttempted: opts.taskTitle || "Unknown task",
    whyItFailed: opts.reason || "Unknown reason",
    whatShouldChange: opts.whatShouldChange ?? generateAdvice(opts),
    timestamp: opts.timestamp || new Date().toISOString(),
  };

  await pushAnchorReflection(key, JSON.stringify(reflection), REFLECTION_TTL, MAX_REFLECTIONS_PER_ANCHOR);

  // Issue #326: also write to the by-file secondary index. This is additive —
  // a failure here must not block reflection storage. The fan-out write lives
  // in `./by-file.ts` (issue #1938), so the per-anchor store stays free of
  // by-file key shapes; `backfillByFileIndex` is itself failure-tolerant and
  // returns the count of files indexed (0 on any error).
  const indexedFiles = await backfillByFileIndex(opts.anchorRef, opts.scopeFiles ?? opts.filesChanged);
  if (indexedFiles.length > 0) {
    console.log(
      `[Learning] Indexed reflection for "${opts.anchorRef.slice(0, 60)}" by ${indexedFiles.length} file(s): ${indexedFiles.slice(0, 3).join(", ")}${indexedFiles.length > 3 ? "..." : ""}`,
    );
  }

  console.log(`[Learning] Recorded reflection for "${opts.anchorRef.slice(0, 60)}" (${opts.outcome})`);
  return { written: true };
}

function generateAdvice(opts: { outcome: string; reason: string; filesChanged?: string[]; verificationErrors?: string[] }): string {
  if (opts.outcome === "no-task") {
    return "The planner could not produce a task for this anchor. The anchor may be too vague, already completed, or blocked by an external dependency. Consider: is there a more specific, actionable formulation?";
  }
  if (opts.outcome === "no-diff") {
    return "The executor ran but produced no code changes. The task may have been unclear, already implemented, or blocked by missing context. Consider: provide more specific scope boundary and acceptance criteria.";
  }
  if (opts.verificationErrors?.length) {
    return `Verification failed on: ${opts.verificationErrors.join(", ")}. The next attempt should address these specific failures. Consider: narrower scope, or fix the verification errors before adding new behavior.`;
  }
  if (opts.outcome === "abandoned") {
    return `Task was abandoned: ${opts.reason}. Consider: different approach, narrower scope, or verify prerequisites are met.`;
  }
  return `Previous attempt failed: ${opts.reason}. The next attempt should take a different approach.`;
}

/**
 * Load the raw per-anchor reflection records (parsed, not formatted) for
 * `anchorRef`. Returns the same data `loadAnchorReflections()` formats, but in
 * structured form so callers (e.g. anchor-candidate scoring in
 * src/anchor-candidates.ts) can inspect or hash deterministic subsets of the
 * records.
 *
 * Filters out malformed entries silently. Order is preserved (oldest first,
 * matching the Redis list order from `pushAnchorReflection`).
 */
export async function loadAnchorReflectionsRaw(
  anchorRef: string,
): Promise<AnchorReflection[]> {
  const key = reflectionKey(anchorRef);
  const raw = await getAnchorReflections(key);
  if (raw.length === 0) return [];
  const parsed: AnchorReflection[] = [];
  for (const r of raw) {
    try {
      parsed.push(JSON.parse(r));
    } catch {
      /* intentional: skip malformed reflection entries */
    }
  }
  return parsed;
}

export async function loadAnchorReflections(anchorRef: string): Promise<ReflectionBlock> {
  const key = reflectionKey(anchorRef);
  const raw = await getAnchorReflections(key);
  if (raw.length === 0) return { content: "", count: 0 };

  const reflections: AnchorReflection[] = raw.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  if (reflections.length === 0) return { content: "", count: 0 };

  const lines = [
    `## PRIOR ATTEMPTS (${reflections.length} previous failures for this anchor)`,
    ``,
    `IMPORTANT: This anchor has been tried before and FAILED. Do NOT repeat the same approach.`,
    ``,
  ];

  for (const ref of reflections) {
    lines.push(`### Attempt: ${ref.cycleId}`);
    lines.push(`- **Task**: ${ref.taskTitle}`);
    lines.push(`- **Outcome**: ${ref.outcome}`);
    lines.push(`- **Why it failed**: ${ref.whyItFailed}`);
    lines.push(`- **Advice**: ${ref.whatShouldChange}`);
    lines.push(``);
  }

  return { content: lines.join("\n"), count: reflections.length };
}

/**
 * Close the Redis connection — kept for backward compatibility with tests.
 * The shared connection is managed by src/redis/connection.ts.
 */
export function closeReflectionsRedis() {
  // No-op: connection managed by src/redis/connection.ts singleton
}
