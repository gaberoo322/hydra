/**
 * anchor-actionability.ts — Pre-planner deterministic actionability gate (issue #270).
 *
 * The planner is the dominant cost in the cycle (~$14/call, 89.8% of total spend
 * per the 50-cycle cost-attribution window in PR #275). Before issue #270, three
 * out of every four unmerged cycles ended in a `noWork` outcome — the planner
 * burned $5–$11 of frontier inference just to conclude that the anchor was
 * already covered by completed work.
 *
 * This module short-circuits that path. For anchor types that are vulnerable to
 * the "already addressed" failure mode (research, user-request, doc-fallback),
 * we deterministically compare the anchor reference against:
 *   1. The "What's been completed" section of `config/direction/priorities.md`
 *   2. The titles of the last 50 merged cycles (from Redis cycle metrics)
 *
 * If a normalized match is found, we return `{ actionable: false }` and the
 * planner call is skipped. The existing `__noWork` sentinel handling in
 * `pipeline-steps.handlePlanResult` records the abandonment so the circuit
 * breaker still counts it.
 *
 * We deliberately do NOT gate `failing-test`, `prior-failure`, `reframe`,
 * `codebase-health`, or `regression-hunt` anchors. Those are recovery flows that
 * legitimately retry against known-failed work.
 *
 * The token normalization reuses `normalizeReference()` from `plan-cache.ts`
 * (issue #192) — same logic that backs the plan cache key, so a planner-style
 * reference variant collides with the completed-work entry that retired it.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeReference } from "./plan-cache.ts";
import { getRecentMetricIds, getCycleMetrics } from "./redis-adapter.ts";

// Anchor types that should pass through the actionability gate. Anything not
// listed here is left untouched (recovery/retry flows + specific anchors that
// the planner is required to look at even when superficially "done").
const GATED_ANCHOR_TYPES = new Set([
  "research",
  "user-request",
  "doc",          // priorities-doc fallback (anchor-selection.ts L840/852)
  "priorities-doc", // alias defensive-coded for callers using descriptive type names
]);

// How many recent merged cycles to scan for the duplicate-title check.
const MERGED_TITLE_LOOKBACK = 50;

// Minimum tokens to consider a match meaningful. Single-token references like
// "foo" would otherwise collide with too many completed-work entries.
const MIN_TOKEN_OVERLAP = 2;

export type ActionabilityResult = {
  actionable: boolean;
  reason: string;
  /** Optional structured detail useful for logging / metrics. */
  matchedAgainst?: string;
};

/**
 * Pre-validate whether an anchor is genuinely actionable before invoking the
 * frontier planner. Returns `{ actionable: true }` for anchor types outside the
 * gated set (no opinion). For gated types, performs the deterministic checks
 * described in the module header.
 *
 * Never throws — read failures are logged and treated as "actionable" (safe
 * default: we'd rather spend the planner call than block legitimate work).
 *
 * Pure aside from filesystem + Redis reads — both injected via top-level
 * imports for testability.
 */
export async function isAnchorActionable(
  anchor: { type: string; reference: string },
): Promise<ActionabilityResult> {
  if (!anchor || typeof anchor.reference !== "string" || !anchor.reference.trim()) {
    return { actionable: true, reason: "no reference to check" };
  }
  if (!GATED_ANCHOR_TYPES.has(anchor.type)) {
    return { actionable: true, reason: `anchor type "${anchor.type}" not gated` };
  }

  const normalizedRef = normalizeReference(anchor.type, anchor.reference);
  const refTokens = tokenSet(normalizedRef);
  if (refTokens.size < MIN_TOKEN_OVERLAP) {
    return { actionable: true, reason: "reference too short to compare" };
  }

  // Check 1: completed priorities section
  const completedMatch = await matchCompletedPriorities(refTokens);
  if (completedMatch) {
    return {
      actionable: false,
      reason: `anchor-already-addressed: matches completed priority "${completedMatch.slice(0, 80)}"`,
      matchedAgainst: completedMatch,
    };
  }

  // Check 2: last N merged cycle titles
  const mergedMatch = await matchRecentMergedTitle(refTokens);
  if (mergedMatch) {
    return {
      actionable: false,
      reason: `anchor-already-addressed: matches recently merged task "${mergedMatch.slice(0, 80)}"`,
      matchedAgainst: mergedMatch,
    };
  }

  return { actionable: true, reason: "no completed/merged match" };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Split a normalized reference (from `normalizeReference`) into a Set of
 * tokens. The normalizer already lowercases, strips stopwords/parentheticals,
 * and sorts — we just need a set for O(1) lookups.
 */
function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
}

/**
 * Match against the "What's been completed" section of priorities.md.
 * Returns the matching line text on hit, null otherwise.
 *
 * Match policy: every token in `refTokens` (after normalization) must appear
 * in the candidate line's normalized token set. This is intentionally strict —
 * it accepts that the operator may write completed entries in a different
 * phrasing than the anchor reference, as long as the salient nouns match.
 */
async function matchCompletedPriorities(
  refTokens: Set<string>,
): Promise<string | null> {
  try {
    const configDir = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");
    const path = join(configDir, "direction", "priorities.md");
    const content = await readFile(path, "utf-8");

    const section = content.match(/# What's been completed[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (!section) return null;

    const lines = section[1]
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 10);

    for (const line of lines) {
      const lineTokens = tokenSet(normalizeReference("generic", line));
      if (containsAll(lineTokens, refTokens)) {
        return line;
      }
    }
    return null;
  } catch (err: any) {
    // ENOENT is expected on fresh installs / test environments without config.
    if (err?.code !== "ENOENT") {
      console.error(`[AnchorActionability] priorities.md read failed (proceeding): ${err?.message ?? err}`);
    }
    return null;
  }
}

/**
 * Match against the titles of the last N merged cycles (Redis metrics index).
 * Returns the matching title on hit, null otherwise.
 *
 * Only considers cycles with `tasksMerged > 0` (so abandoned/failed cycles
 * don't shadow a future legitimate attempt at the same anchor).
 */
async function matchRecentMergedTitle(
  refTokens: Set<string>,
): Promise<string | null> {
  try {
    const ids = await getRecentMetricIds(MERGED_TITLE_LOOKBACK);
    for (const cycleId of ids) {
      const raw = await getCycleMetrics(cycleId);
      if (!raw || !raw.taskTitle) continue;
      const merged = parseInt(raw.tasksMerged ?? "0", 10) || 0;
      if (merged <= 0) continue;

      const titleTokens = tokenSet(normalizeReference("generic", raw.taskTitle));
      if (containsAll(titleTokens, refTokens)) {
        return raw.taskTitle;
      }
    }
    return null;
  } catch (err: any) {
    console.error(`[AnchorActionability] recent-merge scan failed (proceeding): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Returns true if every element of `needles` is in `haystack`. Pure helper
 * exported for tests via re-exports below.
 */
function containsAll(haystack: Set<string>, needles: Set<string>): boolean {
  if (needles.size === 0) return false;
  for (const t of needles) {
    if (!haystack.has(t)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test surface — exported for white-box testing of the matcher only.
// ---------------------------------------------------------------------------

export const __test__ = {
  tokenSet,
  containsAll,
  GATED_ANCHOR_TYPES,
  MERGED_TITLE_LOOKBACK,
};
