/**
 * reflections.ts — Reflexion-style post-mortem buffer for Build Cycles
 *
 * Adds a global bounded buffer (hydra:reflections:buffer, capped at 20) on top
 * of the per-anchor reflections already in agent-memory.ts. This module provides:
 *
 *   recordReflection()          — store a structured reflection after cycle failure
 *   loadRelevantReflections()   — filter by anchor type/reference, return most recent
 *   clearReflectionsForAnchor() — clear after successful merge
 *   getAllReflections()          — for the GET /api/reflections endpoint
 *
 * Redis key: hydra:reflections:buffer (list, capped at 20)
 * Each reflection is JSON with: cycleId, anchorType, anchorReference,
 * failureMode, whatFailed, whyItFailed, whatToTryDifferently, timestamp
 *
 * The per-anchor reflections in agent-memory.ts remain the primary source for
 * planner context (keyed by anchor reference). This global buffer provides a
 * cross-anchor view for the API and for the planner's "Recent Failures" section.
 */

import {
  getRedisConnection,
  pushReflection,
  getReflectionBuffer,
  replaceReflectionBuffer,
} from "./redis-adapter.ts";

const MAX_BUFFER_SIZE = 20;

export type Reflection = {
  cycleId: string;
  anchorType: string;
  anchorReference: string;
  failureMode: string;
  whatFailed: string;
  whyItFailed: string;
  whatToTryDifferently: string;
  timestamp: string;
};

/**
 * Store a structured reflection after a cycle failure.
 * Appends to the global bounded buffer (capped at MAX_BUFFER_SIZE).
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
  const reflection: Reflection = {
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

  console.log(`[Reflections] Recorded reflection for cycle ${opts.cycleId}: ${opts.failureMode} — ${opts.whatFailed.slice(0, 80)}`);
}

/**
 * Load relevant reflections for a given anchor, filtered by type/reference.
 * Returns the most recent matching reflections, up to `limit`.
 */
export async function loadRelevantReflections(
  anchor: { type: string; reference: string },
  limit = 3,
): Promise<Reflection[]> {
  const raw = await getReflectionBuffer();
  if (raw.length === 0) return [];

  const all: Reflection[] = [];
  for (const entry of raw) {
    try {
      all.push(JSON.parse(entry));
    } catch { /* intentional: skip unparseable entries */ }
  }

  // Filter: match by anchor reference (exact or substring) or anchor type
  const refLower = (anchor.reference || "").toLowerCase();
  const relevant = all.filter((r) => {
    const rRefLower = (r.anchorReference || "").toLowerCase();
    // Exact match on reference
    if (rRefLower === refLower) return true;
    // Substring match (either direction) for partial matches
    if (refLower && rRefLower && (rRefLower.includes(refLower) || refLower.includes(rRefLower))) return true;
    // Same anchor type as a weaker signal
    if (r.anchorType === anchor.type) return true;
    return false;
  });

  // Most recent first, capped at limit
  return relevant.reverse().slice(0, limit);
}

/**
 * Format reflections for injection into the planner prompt as a
 * "## Recent Failures" section.
 */
export function formatReflectionsForPrompt(reflections: Reflection[]): string {
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

/**
 * Clear all reflections for a specific anchor reference from the global buffer.
 * Called after a successful merge to remove stale failure context.
 */
export async function clearReflectionsForAnchor(anchorReference: string): Promise<number> {
  const raw = await getReflectionBuffer();
  if (raw.length === 0) return 0;

  const refLower = (anchorReference || "").toLowerCase();
  let removed = 0;

  // Filter out entries matching this anchor reference
  const kept: string[] = [];
  for (const entry of raw) {
    try {
      const parsed: Reflection = JSON.parse(entry);
      const entryRefLower = (parsed.anchorReference || "").toLowerCase();
      if (entryRefLower === refLower || (refLower && entryRefLower.includes(refLower))) {
        removed++;
      } else {
        kept.push(entry);
      }
    } catch {
      kept.push(entry); // Keep unparseable entries
    }
  }

  if (removed > 0) {
    await replaceReflectionBuffer(kept);
    console.log(`[Reflections] Cleared ${removed} reflection(s) for anchor "${anchorReference.slice(0, 60)}"`);
  }

  return removed;
}

/**
 * Return all reflections in the global buffer (for the API endpoint).
 * Most recent first.
 */
export async function getAllReflections(): Promise<Reflection[]> {
  const raw = await getReflectionBuffer();

  const reflections: Reflection[] = [];
  for (const entry of raw) {
    try {
      reflections.push(JSON.parse(entry));
    } catch { /* intentional: skip unparseable entries */ }
  }

  // Most recent first
  return reflections.reverse();
}

/**
 * Close the Redis connection — for test cleanup.
 */
export function closeReflectionsRedis() {
  // Connection is now managed by the shared redis-adapter singleton.
  // This function is kept for backward compatibility with tests.
  // The shared connection should not be closed per-module.
}
