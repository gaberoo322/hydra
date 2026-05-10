/**
 * learning/reflections.ts — Per-anchor episodic + global reflection storage
 *
 * Extracted from learning.ts (issue #219). Holds the Reflexion-style
 * reflection state used to inject failure context into future planner calls
 * for the same anchor (per-anchor) or the same anchor type (global buffer).
 *
 * Public API used outside this module:
 *   recordAnchorReflection / loadAnchorReflections / reflectionKey
 *   recordGlobalReflection / loadRelevantReflections / formatReflectionsForPrompt
 *   clearReflectionsForAnchor — clears the global buffer entries for an anchor
 *   recordReflection           — global-only convenience wrapper (legacy)
 *   getAllReflections          — GET /api/reflections
 *   closeReflectionsRedis      — kept for test back-compat (no-op)
 *   getReflectionEffectiveness — per-anchor success/failure stats + injection rate
 *   recordReflectionOutcome    — write `{anchorRef, outcome}` to outcome list
 *
 * Constants (REFLECTION_TTL etc.) live here so callers don't reach into
 * learning.ts internals.
 *
 * Behavior preserved 1:1 from the previous learning.ts implementation.
 */

import { redisKeys } from "../redis-keys.ts";
import {
  getAnchorReflections,
  pushAnchorReflection,
  deleteReflectionKey,
  pushReflection,
  getReflectionBuffer,
  replaceReflectionBuffer,
  pushReflectionOutcome,
  getReflectionOutcomes,
  setReflectionKeyTTL,
} from "../redis-adapter.ts";

// ===========================================================================
// Constants
// ===========================================================================

export const REFLECTION_TTL = 7 * 24 * 60 * 60; // 7 days
export const REFLECTION_TTL_EXTENDED = 30 * 24 * 60 * 60; // 30 days for effective reflections
export const MAX_REFLECTIONS_PER_ANCHOR = 5;
export const MAX_BUFFER_SIZE = 20;

// ===========================================================================
// Types
// ===========================================================================

export type GlobalReflection = {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
  timestamp: string;
};

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

const REFLECTION_PREFIX = redisKeys.reflectionPrefix();

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
}) {
  const key = reflectionKey(opts.anchorRef);

  const reflection: AnchorReflection = {
    cycleId: opts.cycleId,
    anchorRef: opts.anchorRef,
    taskTitle: opts.taskTitle,
    outcome: opts.outcome,
    reason: opts.reason,
    whatWasAttempted: opts.taskTitle || "Unknown task",
    whyItFailed: opts.reason || "Unknown reason",
    whatShouldChange: generateAdvice(opts),
    timestamp: new Date().toISOString(),
  };

  await pushAnchorReflection(key, JSON.stringify(reflection), REFLECTION_TTL, MAX_REFLECTIONS_PER_ANCHOR);
  console.log(`[Learning] Recorded reflection for "${opts.anchorRef.slice(0, 60)}" (${opts.outcome})`);
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

export async function loadAnchorReflections(anchorRef: string): Promise<string> {
  const key = reflectionKey(anchorRef);
  const raw = await getAnchorReflections(key);
  if (raw.length === 0) return "";

  const reflections: AnchorReflection[] = raw.map(r => {
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);

  if (reflections.length === 0) return "";

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

  return lines.join("\n");
}

/**
 * Drop the per-anchor reflection list for `anchorRef` (post-merge cleanup).
 * If the anchor has prior >50% successful retries, the caller may instead
 * extend the key TTL via `extendAnchorReflectionsTTL`.
 */
export async function deleteAnchorReflections(anchorRef: string): Promise<void> {
  await deleteReflectionKey(reflectionKey(anchorRef));
}

/**
 * Extend the TTL on a per-anchor reflection key. Used when reflections have
 * proven effective (>50% retry success rate).
 */
export async function extendAnchorReflectionsTTL(anchorRef: string): Promise<void> {
  await setReflectionKeyTTL(reflectionKey(anchorRef), REFLECTION_TTL_EXTENDED);
}

// ===========================================================================
// Global reflection buffer
// ===========================================================================

export async function recordGlobalReflection(opts: {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
}): Promise<void> {
  const reflection: GlobalReflection = {
    cycleId: opts.cycleId,
    anchorType: opts.anchorType,
    anchorReference: opts.anchorReference,
    failureMode: opts.failureMode,
    whatFailed: opts.whatFailed,
    whyItFailed: opts.whyItFailed,
    whatToTryDifferently: opts.whatToTryDifferently,
    timestamp: new Date().toISOString(),
  };

  await pushReflection(JSON.stringify(reflection), MAX_BUFFER_SIZE);
  console.log(`[Learning] Recorded global reflection for cycle ${opts.cycleId}: ${opts.failureMode}`);
}

/**
 * Backwards-compat alias for `recordGlobalReflection`.
 * Tests + direct API callers used `recordReflection` historically.
 */
export async function recordReflection(opts: {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
}): Promise<void> {
  await recordGlobalReflection(opts);
}

export async function loadRelevantReflections(
  anchor: { type: string; reference: string },
  limit = 3,
): Promise<GlobalReflection[]> {
  const raw = await getReflectionBuffer();
  if (raw.length === 0) return [];

  const all: GlobalReflection[] = [];
  for (const entry of raw) {
    try {
      all.push(JSON.parse(entry));
    } catch { /* intentional: skip unparseable entries */ }
  }

  const refLower = (anchor.reference || "").toLowerCase();
  const relevant = all.filter((r) => {
    const rRefLower = (r.anchorReference || "").toLowerCase();
    if (rRefLower === refLower) return true;
    if (refLower && rRefLower && (rRefLower.includes(refLower) || refLower.includes(rRefLower))) return true;
    if (r.anchorType === anchor.type) return true;
    return false;
  });

  return relevant.reverse().slice(0, limit);
}

export function formatReflectionsForPrompt(reflections: GlobalReflection[]): string {
  if (reflections.length === 0) return "";

  const lines = [
    `## Recent Failures`,
    ``,
    `IMPORTANT: These recent failures are relevant to the current anchor. Do NOT repeat the same approaches.`,
    ``,
  ];

  for (const ref of reflections) {
    lines.push(`### ${ref.cycleId} (${ref.failureMode})`);
    lines.push(`- **What failed**: ${ref.whatFailed}`);
    lines.push(`- **Why**: ${ref.whyItFailed}`);
    lines.push(`- **Try differently**: ${ref.whatToTryDifferently}`);
    lines.push(``);
  }

  return lines.join("\n");
}

export async function clearReflectionsForAnchor(anchorReference: string): Promise<number> {
  const raw = await getReflectionBuffer();
  if (raw.length === 0) return 0;

  const refLower = (anchorReference || "").toLowerCase();
  let removed = 0;

  const kept: string[] = [];
  for (const entry of raw) {
    try {
      const parsed: GlobalReflection = JSON.parse(entry);
      const entryRefLower = (parsed.anchorReference || "").toLowerCase();
      if (entryRefLower === refLower || (refLower && entryRefLower.includes(refLower))) {
        removed++;
      } else {
        kept.push(entry);
      }
    } catch {
      kept.push(entry);
    }
  }

  if (removed > 0) {
    await replaceReflectionBuffer(kept);
    console.log(`[Learning] Cleared ${removed} reflection(s) for anchor "${anchorReference.slice(0, 60)}"`);
  }

  return removed;
}

/**
 * Return all reflections in the global buffer (for GET /api/reflections).
 * Most recent first.
 */
export async function getAllReflections(): Promise<GlobalReflection[]> {
  const raw = await getReflectionBuffer();

  const reflections: GlobalReflection[] = [];
  for (const entry of raw) {
    try {
      reflections.push(JSON.parse(entry));
    } catch { /* intentional: skip unparseable entries */ }
  }

  return reflections.reverse();
}

/**
 * Close the Redis connection — kept for backward compatibility with tests.
 * The shared connection is managed by redis-adapter.
 */
export function closeReflectionsRedis() {
  // No-op: connection managed by redis-adapter singleton
}

// ===========================================================================
// Reflection outcomes / effectiveness
// ===========================================================================

/**
 * Record that an anchor with prior reflections completed in `outcome` state.
 * Used to compute reflection effectiveness over time.
 */
export async function recordReflectionOutcome(opts: {
  anchorRef: string;
  outcome: "merged" | "failed" | "abandoned";
  cycleId: string;
}): Promise<number> {
  const existingReflections = await getAnchorReflections(reflectionKey(opts.anchorRef));
  if (existingReflections.length === 0) return 0;

  const outcome: ReflectionOutcome = {
    anchorRef: opts.anchorRef,
    hadReflections: true,
    outcome: opts.outcome,
    cycleId: opts.cycleId,
    timestamp: new Date().toISOString(),
  };
  await pushReflectionOutcome(JSON.stringify(outcome), Date.now());
  return existingReflections.length;
}

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
    const { getMetricsTrend } = await import("../metrics.ts");
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
