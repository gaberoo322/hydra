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
// Doc-anchor saturation check (issue #285)
//
// The actionability gate above catches "anchor already addressed" cases by
// token-matching the anchor reference against completed work. But the doc
// fallback anchor in `selectAnchor()` uses a constant reference
// (`direction/priorities.md`), so token-overlap never fires — the planner
// runs anyway, produces a freshly-drifted title, and the post-planner drift
// detector rejects it after the frontier call has completed.
//
// In the 50-cycle window from 2026-05-11, this loop fired 9 times against
// the same doc anchor at ~$60/cycle — $518 of $1421 total spend (36.5%).
//
// This function provides a pre-planner saturation signal: if the last N
// cycles for `{anchorType: "doc", anchorReference: <ref>}` were all
// drift-rejected, the caller should either trigger a priorities refresh
// inline or fall through to the next anchor source. Threshold N comes from
// `HYDRA_DOC_SATURATION_THRESHOLD` (default 2).
// ---------------------------------------------------------------------------

import { getMetricsTrend } from "./metrics/trend.ts";

const DOC_SATURATION_LOOKBACK = 10;
const DOC_SATURATION_DEFAULT_THRESHOLD = 2;
// Drift-rejected cycles record `abandonReason` like "Drift: ..." (pipeline-
// steps.ts L217) or `abandonReason: "drift-pre-filter"` (control-loop.ts
// L153). Either form counts toward saturation.
const DRIFT_ABANDON_PATTERNS = [/^drift:/i, /^drift-pre-filter$/i];

export type DocSaturationResult = {
  saturated: boolean;
  reason: string;
  /** Number of consecutive recent drift-rejected cycles for this anchor. */
  consecutiveDriftCount: number;
};

/**
 * Returns true when the last N cycles for the given doc anchor were ALL
 * drift-rejected (i.e. `abandonReason` starts with "Drift:" or equals
 * "drift-pre-filter") AND no merged cycle interleaves them.
 *
 * Scans the `HYDRA_DOC_SATURATION_LOOKBACK` most recent cycles. If a merge
 * for any anchor is interleaved, the counter resets (we only care about
 * uninterrupted runs of waste). Other-anchor cycles (e.g. queue items) are
 * ignored — they don't reset the counter because they're not the same
 * anchor source.
 *
 * Never throws — Redis failures log and return `{ saturated: false }` (safe
 * default: prefer paying the planner cost than blocking legitimate work).
 *
 * Threshold is read fresh on each call so tests can tune it via env var.
 */
export async function isDocAnchorSaturated(
  anchorType: string,
  anchorReference: string,
): Promise<DocSaturationResult> {
  if (anchorType !== "doc" && anchorType !== "priorities-doc") {
    return { saturated: false, reason: "not a doc anchor", consecutiveDriftCount: 0 };
  }
  if (!anchorReference || typeof anchorReference !== "string") {
    return { saturated: false, reason: "no reference", consecutiveDriftCount: 0 };
  }

  const threshold = readSaturationThreshold();
  if (threshold <= 0) {
    return { saturated: false, reason: "saturation check disabled", consecutiveDriftCount: 0 };
  }

  try {
    const trend = await getMetricsTrend(DOC_SATURATION_LOOKBACK);
    let consecutive = 0;
    for (const m of trend) {
      // Skip cycles for other anchors — they don't break the run.
      const sameAnchor =
        (m.anchorType === "doc" || m.anchorType === "priorities-doc") &&
        m.anchorReference === anchorReference;
      if (!sameAnchor) {
        // A merged cycle for any anchor signals real progress; reset.
        const merged = (typeof m.tasksMerged === "number" ? m.tasksMerged : parseInt(m.tasksMerged ?? "0", 10) || 0) > 0;
        if (merged) break;
        continue;
      }

      const reason = typeof m.abandonReason === "string" ? m.abandonReason.trim() : "";
      const isDriftRejected = reason.length > 0 && DRIFT_ABANDON_PATTERNS.some((p) => p.test(reason));
      if (isDriftRejected) {
        consecutive++;
        if (consecutive >= threshold) {
          return {
            saturated: true,
            reason: `${consecutive} consecutive drift-rejected cycles on doc anchor "${anchorReference}"`,
            consecutiveDriftCount: consecutive,
          };
        }
      } else {
        // Same anchor, but cycle ended without drift rejection — either
        // merged or some other failure mode. Either way, the saturation
        // signal we care about (repeated drift on a stale doc) is broken.
        break;
      }
    }
    return {
      saturated: false,
      reason: consecutive > 0
        ? `only ${consecutive} consecutive drift-rejected cycles (threshold ${threshold})`
        : "no recent drift-rejected cycles for this anchor",
      consecutiveDriftCount: consecutive,
    };
  } catch (err: any) {
    console.error(`[AnchorActionability] doc-saturation scan failed (proceeding): ${err?.message ?? err}`);
    return { saturated: false, reason: "scan failed", consecutiveDriftCount: 0 };
  }
}

function readSaturationThreshold(): number {
  const raw = process.env.HYDRA_DOC_SATURATION_THRESHOLD;
  if (raw === undefined || raw === "") return DOC_SATURATION_DEFAULT_THRESHOLD;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return DOC_SATURATION_DEFAULT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Test surface — exported for white-box testing of the matcher only.
// ---------------------------------------------------------------------------

export const __test__ = {
  tokenSet,
  containsAll,
  GATED_ANCHOR_TYPES,
  MERGED_TITLE_LOOKBACK,
  DOC_SATURATION_LOOKBACK,
  DOC_SATURATION_DEFAULT_THRESHOLD,
  DRIFT_ABANDON_PATTERNS,
  readSaturationThreshold,
};
