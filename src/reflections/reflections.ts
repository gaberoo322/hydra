/**
 * learning/reflections.ts — Per-anchor episodic reflection storage
 *
 * Holds the Reflexion-style reflection state used to inject failure context
 * into future planner calls for the same anchor (per-anchor) or any anchor
 * that touched the same files (by-file index, #326).
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
 *   loadAnchorReflectionsByFile (both return ReflectionBlock {content,count} —
 *   the count is sourced here so callers don't regex the rendered header)
 *   backfillByFileIndex / reflectionKey
 *   closeReflectionsRedis      — kept for test back-compat (no-op)
 *   getReflectionEffectiveness — per-anchor success/failure stats + injection rate
 *
 * Constants (REFLECTION_TTL etc.) live here so callers don't reach into
 * learning.ts internals.
 */

import {
  REFLECTION_PREFIX,
  getAnchorReflections,
  pushAnchorReflection,
  getReflectionOutcomes,
  addReflectionToFileIndex,
  getReflectionKeysByFile,
} from "../redis/reflections.ts";

// ===========================================================================
// Constants
// ===========================================================================

export const REFLECTION_TTL = 7 * 24 * 60 * 60; // 7 days
export const MAX_REFLECTIONS_PER_ANCHOR = 5;

/**
 * Cap for by-file fan-out (issue #326). When a planner anchor touches a hot
 * file, we want a useful slice of recent reflections — not all 50 of them.
 */
export const MAX_BY_FILE_REFLECTIONS = 5;

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

export type ReflectionOutcome = {
  anchorRef: string;
  hadReflections: true;
  outcome: "merged" | "failed" | "abandoned";
  cycleId: string;
  timestamp: string;
};

export type ReflectionEffectiveness = {
  ref: string;
  totalRetries: number;
  successes: number;
  failures: number;
  successRate: number;
};

// ===========================================================================
// Per-anchor episodic reflections
// ===========================================================================

export function reflectionKey(anchorRef: string): string {
  return REFLECTION_PREFIX + (anchorRef || "unknown").replace(/\s+/g, "-").toLowerCase().slice(0, 120);
}

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
  // a failure here must not block reflection storage, so we log and continue.
  try {
    const files = extractFilesFromAnchor(opts.anchorRef, opts.scopeFiles ?? opts.filesChanged);
    for (const file of files) {
      await addReflectionToFileIndex(file, key, REFLECTION_TTL);
    }
    if (files.length > 0) {
      console.log(`[Learning] Indexed reflection for "${opts.anchorRef.slice(0, 60)}" by ${files.length} file(s): ${files.slice(0, 3).join(", ")}${files.length > 3 ? "..." : ""}`);
    }
  } catch (err: any) {
    console.error(`[Learning] By-file index write failed for "${opts.anchorRef.slice(0, 60)}": ${err.message}`);
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

/**
 * A formatted reflection block plus the structured count of items it carries.
 *
 * Issue #804: the count is sourced HERE — from the parsed reflection array —
 * so downstream telemetry (`reflectionInjected` / `reflectionSources`) reads
 * it as data instead of regex-scanning the rendered `## PRIOR ATTEMPTS (N…`
 * header out of the formatted markdown. `content` is "" exactly when
 * `count === 0`.
 */
export interface ReflectionBlock {
  content: string;
  count: number;
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
 * Drop the per-anchor reflection list for `anchorRef` (post-merge cleanup).
 * If the anchor has prior >50% successful retries, the caller may instead
 * extend the key TTL via `extendAnchorReflectionsTTL`.
 *
 * Issue #326: also remove this anchor key from any by-file index entries it
 * might be a member of, so cleared reflections do not surface via the
 * secondary index. Best-effort — failures here are logged and ignored.
 */
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

/**
 * Close the Redis connection — kept for backward compatibility with tests.
 * The shared connection is managed by src/redis/connection.ts.
 */
export function closeReflectionsRedis() {
  // No-op: connection managed by src/redis/connection.ts singleton
}

// ===========================================================================
// Reflection effectiveness
// ===========================================================================

/**
 * Compute per-anchor effectiveness scores from reflection outcomes.
 * Returns anchors that had reflections when retried, with success/failure counts.
 *
 * Issue #193: also returns `injection` aggregate stats from recent cycle metrics
 * so the operator can verify reflections are actually reaching the planner.
 */
export async function getReflectionEffectiveness(): Promise<{
  anchors: ReflectionEffectiveness[];
  injection: { totalCycles: number; cyclesWithReflections: number; injectionRate: number };
}> {
  let anchors: ReflectionEffectiveness[] = [];
  try {
    const raw = await getReflectionOutcomes();
    const byAnchor = new Map<string, { successes: number; failures: number }>();

    for (const entry of raw) {
      try {
        const outcome: ReflectionOutcome = JSON.parse(entry);
        if (!outcome.anchorRef) continue;

        const existing = byAnchor.get(outcome.anchorRef) || { successes: 0, failures: 0 };
        if (outcome.outcome === "merged") {
          existing.successes++;
        } else {
          existing.failures++;
        }
        byAnchor.set(outcome.anchorRef, existing);
      } catch { /* intentional: skip unparseable entries */ }
    }

    for (const [ref, counts] of byAnchor) {
      const totalRetries = counts.successes + counts.failures;
      anchors.push({
        ref,
        totalRetries,
        successes: counts.successes,
        failures: counts.failures,
        successRate: totalRetries > 0 ? counts.successes / totalRetries : 0,
      });
    }
  } catch (err: any) {
    console.error(`[Learning] Failed to compute reflection effectiveness: ${err.message}`);
    anchors = [];
  }

  // Aggregate injection rate from recent metrics (issue #193 telemetry).
  // Failure-tolerant — never throws.
  const injection = await computeInjectionStats();

  return { anchors, injection };
}

/**
 * Compute reflection injection rate from the last 50 cycles.
 * Returns zeros if metrics are unavailable.
 */
async function computeInjectionStats(): Promise<{ totalCycles: number; cyclesWithReflections: number; injectionRate: number }> {
  try {
    const { getMetricsTrend } = await import("../metrics/trend.ts");
    const recent = await getMetricsTrend(50);
    const totalCycles = recent.length;
    const cyclesWithReflections = recent.filter((m: any) => m.reflectionInjected === "true").length;
    return {
      totalCycles,
      cyclesWithReflections,
      injectionRate: totalCycles > 0 ? cyclesWithReflections / totalCycles : 0,
    };
  } catch (err: any) {
    console.error(`[Learning] Failed to compute injection stats: ${err.message}`);
    return { totalCycles: 0, cyclesWithReflections: 0, injectionRate: 0 };
  }
}
