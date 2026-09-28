/**
 * src/glm/eligibility.ts — the ONE GLM-lane eligibility predicate
 * (ADR-0040 Decision 4 + Decision 5; wayfinder #4517, epic #4681, issue #4684).
 *
 * Before this module, "which lane owns this issue?" was restated at several
 * sites: `isGlmWithheldFromClaude` (board-state count), `isGlmEligibleCandidate`
 * (the eligibility sweep), the drainer's jq picker, and `collect-state.sh`'s
 * grill-exemption python. This module encodes ADR-0040's ruling table ONCE as
 * two pure functions:
 *
 * - {@link glmLane} — the label-only lane ruling (rows 1, 8, 9, 11 + the
 *   ready-for-agent gate). Board-state and the sweep delegate to it.
 * - {@link glmPickVerdict} — the full "may the drainer pick this row now?"
 *   verdict (rows 2–7): lane, `track:` title, open strict blocker, open /
 *   merged PR, grill exemption, design-concept artifact freshness. It has no
 *   live consumer in this slice; the drainer adopts it later (epsilon).
 *
 * {@link glmGrillExemption} is the grill-exemption arm, exported separately so
 * a cross-language parity test (`test/glm-eligibility.test.mts`) can pin it
 * against `collect-state.sh`'s MECHANICAL / TRIVIAL python snippets, which are
 * extracted from the script and executed at test time.
 *
 * # Purity contract
 *
 * No I/O: no `node:fs`, no `node:child_process`, no `fetch`, no
 * `process.env`, no `Date.now()` (the clock is `ctx.now`). Imports are pure
 * leaves only. Every label name comes from `src/board-labels.ts` — this file
 * carries NO label string literal of its own.
 */

import { ORCH_BOARD_LABELS } from "../board-labels.ts";
import {
  referencedIssues,
  mergedPrReferences,
  type PrRefRow,
} from "../github/pr-refs.ts";
import { extractStrictBlockerRefs } from "../github/blockers.ts";
import { DESIGN_CONCEPT_MAX_AGE_MS } from "../design-concept-gate.ts";

// ---------------------------------------------------------------------------
// glmLane — the label-only lane ruling
// ---------------------------------------------------------------------------

/** Which authoring lane owns a row: the GLM drainer, Claude `dev_orch`, or neither. */
export type GlmLaneName = "glm" | "claude" | "neither";

/**
 * Machine-readable reason for a {@link glmLane} ruling (one per precedence arm).
 * Deliberately NOT spelled like a label name — this module carries no label
 * string literal of its own (INV-1).
 */
export type GlmLaneReason =
  | "not-ready-for-agent"
  | "claude-pinned"
  | "claimed"
  | "target-scope"
  | "partition-inactive"
  | "glm-owned"
  | "not-glm-owned";

export interface GlmLaneResult {
  lane: GlmLaneName;
  reason: GlmLaneReason;
}

/**
 * Rule on which lane owns a row, from its labels and the GLM partition's
 * liveness. Precedence, first match wins:
 *
 *  (a) no `ready-for-agent`                 -> neither  (not a dispatch candidate)
 *  (b) `glm-ab-control` or `glm-withhold`   -> claude   (row 1, #4649)
 *  (c) `in-progress` or `target-backlog`    -> neither  (rows 8, 9)
 *  (d) partition inactive                   -> claude   (row 11, fail-open #3754)
 *  (e) `glm-eligible`                       -> glm
 *  (f) otherwise                            -> claude
 */
export function glmLane(
  labels: readonly string[],
  partitionActive: boolean,
): GlmLaneResult {
  const has = (l: string): boolean => labels.includes(l);
  if (!has(ORCH_BOARD_LABELS.ready_for_agent)) {
    return { lane: "neither", reason: "not-ready-for-agent" };
  }
  if (has(ORCH_BOARD_LABELS.glm_ab_control) || has(ORCH_BOARD_LABELS.glm_withhold)) {
    return { lane: "claude", reason: "claude-pinned" };
  }
  if (has(ORCH_BOARD_LABELS.in_progress)) {
    return { lane: "neither", reason: "claimed" };
  }
  if (has(ORCH_BOARD_LABELS.target_backlog)) {
    return { lane: "neither", reason: "target-scope" };
  }
  if (!partitionActive) {
    return { lane: "claude", reason: "partition-inactive" };
  }
  if (has(ORCH_BOARD_LABELS.glm_eligible)) {
    return { lane: "glm", reason: "glm-owned" };
  }
  return { lane: "claude", reason: "not-glm-owned" };
}

// ---------------------------------------------------------------------------
// glmGrillExemption — the grill-clear arm (collect-state parity)
// ---------------------------------------------------------------------------

/**
 * The `cleanup-scan` reason value IS the label name (the row is exempt because
 * it carries that label), so it is typed and produced from the label constant
 * rather than re-spelled as a literal here.
 */
type CleanupScanReason = typeof ORCH_BOARD_LABELS.cleanup_scan;
const CLEANUP_SCAN_REASON: CleanupScanReason = ORCH_BOARD_LABELS.cleanup_scan;

/** Why a row needs no design-concept artifact, or `null` when it must be grilled. */
export type GlmGrillExemption = CleanupScanReason | "track-title" | "expected-tier-t1";

/** A board row as the pick predicate sees it. */
export interface GlmPickRow {
  number: number;
  labels: readonly string[];
  title?: string | null;
  body?: string | null;
}

/** Same pattern as collect-state's TRIVIAL python: `Expected tier: T1` / `Expected tier: 1`. */
const EXPECTED_TIER_T1_RE = /Expected\s+tier:\s*T?1\b/i;

function isTrackTitle(title: string | null | undefined): boolean {
  return (title ?? "").trimStart().toLowerCase().startsWith("track:");
}

/**
 * The grill-exemption arm, mirroring `collect-state.sh`'s python precedence
 * EXACTLY: the `cleanup-scan` label first (unconditional — beats
 * `needs-design-concept`), then a `track:` title prefix, then an
 * `Expected tier: T1` body stamp only when `needs-design-concept` is absent.
 *
 * Note the `track-title` value here is collect-state's MECHANICAL arm (a
 * grill suppression). {@link glmPickVerdict} applies its own ABSOLUTE `track:`
 * refusal earlier, so a `cleanup-scan` + `track:` row has exemption
 * `cleanup-scan` but verdict `track-title`.
 */
export function glmGrillExemption(row: GlmPickRow): GlmGrillExemption | null {
  if (row.labels.includes(ORCH_BOARD_LABELS.cleanup_scan)) return CLEANUP_SCAN_REASON;
  if (isTrackTitle(row.title)) return "track-title";
  if (row.labels.includes(ORCH_BOARD_LABELS.needs_design_concept)) return null;
  if (EXPECTED_TIER_T1_RE.test(row.body ?? "")) return "expected-tier-t1";
  return null;
}

// ---------------------------------------------------------------------------
// glmPickVerdict — the full drainer pick verdict
// ---------------------------------------------------------------------------

/** The design-concept artifact facts the verdict needs, or `null` when none exists. */
export interface GlmPickArtifact {
  status: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface GlmPickContext {
  artifact: GlmPickArtifact | null;
  openPrs: readonly PrRefRow[];
  mergedPrs: readonly PrRefRow[];
  /** Issue numbers currently OPEN (the caller resolves blockers; this module does no I/O). */
  openBlockers: ReadonlySet<number>;
  /** Epoch milliseconds. */
  now: number;
}

export type GlmPickableReason = CleanupScanReason | "expected-tier-t1" | "approved-fresh";

export type GlmUnpickableReason =
  | "lane"
  | "track-title"
  | "open-blocker"
  | "open-pr"
  | "merged-pr"
  | "artifact-missing"
  | "artifact-draft"
  | "artifact-stale";

export type GlmPickVerdict =
  | { pickable: true; reason: GlmPickableReason }
  | { pickable: false; reason: GlmUnpickableReason };

/**
 * May the GLM drainer pick `row` right now? Check order, first match wins:
 * lane -> track-title (absolute, row 4) -> open-blocker -> open-pr ->
 * merged-pr -> cleanup-scan (pickable) -> expected-tier-t1 (pickable) ->
 * artifact-missing -> artifact-draft -> artifact-stale -> approved-fresh.
 *
 * The lane check pins `partitionActive=true`: a caller asking "may the drainer
 * pick this" is the drainer itself, so the partition is live by definition.
 * An artifact is stale when its status is anything but `approved`/`draft`, or
 * when an approved artifact is older than {@link DESIGN_CONCEPT_MAX_AGE_MS}
 * or carries a non-finite / non-positive `createdAt`.
 */
export function glmPickVerdict(row: GlmPickRow, ctx: GlmPickContext): GlmPickVerdict {
  if (glmLane(row.labels, true).lane !== "glm") {
    return { pickable: false, reason: "lane" };
  }
  if (isTrackTitle(row.title)) {
    return { pickable: false, reason: "track-title" };
  }
  for (const n of extractStrictBlockerRefs(row.body)) {
    if (n !== row.number && ctx.openBlockers.has(n)) {
      return { pickable: false, reason: "open-blocker" };
    }
  }
  if (referencedIssues(ctx.openPrs).has(row.number)) {
    return { pickable: false, reason: "open-pr" };
  }
  if (mergedPrReferences(ctx.mergedPrs).has(row.number)) {
    return { pickable: false, reason: "merged-pr" };
  }
  const exemption = glmGrillExemption(row);
  if (exemption === CLEANUP_SCAN_REASON) return { pickable: true, reason: CLEANUP_SCAN_REASON };
  if (exemption === "expected-tier-t1") return { pickable: true, reason: "expected-tier-t1" };

  const artifact = ctx.artifact;
  if (artifact === null) return { pickable: false, reason: "artifact-missing" };
  if (artifact.status === "draft") return { pickable: false, reason: "artifact-draft" };
  if (artifact.status !== "approved") return { pickable: false, reason: "artifact-stale" };
  const createdAt = artifact.createdAt;
  if (
    !Number.isFinite(createdAt) ||
    createdAt <= 0 ||
    ctx.now - createdAt > DESIGN_CONCEPT_MAX_AGE_MS
  ) {
    return { pickable: false, reason: "artifact-stale" };
  }
  return { pickable: true, reason: "approved-fresh" };
}
