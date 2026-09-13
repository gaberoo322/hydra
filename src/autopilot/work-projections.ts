/**
 * autopilot/work-projections — the pure /work-page + hitl-grill projections
 * (issue #4408).
 *
 * The eight functions here (`deriveWorkLane`, `toWorkQueueRow`,
 * `compareWorkQueueRows`, `evaluatePromoteEligibility`,
 * `computeRelabelTransitions`, `parseParkReason`, `toHitlGrillRow`,
 * `compareHitlGrillRows`) plus the `PromoteEligibility` type are the
 * side-effect-free projections behind the /work page's three reads and four
 * board actions (issues #4010, #4028): operator-lane resolution, queue row
 * shaping + ordering, the promote-refusal decision table, the relabel
 * transition plan, and the parked-idea lane's row shaping + ordering. They
 * have no HTTP surface and no Express dependency — their natural home is the
 * `autopilot` domain, NOT the Express route file that serves them.
 *
 * This leaf was extracted verbatim from `src/api/autopilot-board.ts`,
 * mirroring the `board-state.ts` extraction (issue #3505) rather than
 * inventing a new pattern: the route file's own header already documents that
 * the pure board-state bucketing math belongs in the `autopilot` domain
 * because "the bucketing math itself has no Express dependency" — this is
 * that principle applied to the /work feature that landed later (#4010) and
 * re-bundled pure math inside the router. A future consumer of these
 * projections (a CLI, a second route, a test harness) imports them without
 * `express` or any router wiring in the import closure.
 *
 * The route file (`src/api/autopilot-board.ts`) is now a thin HTTP adapter
 * that imports these projections. The function signatures and behaviour are
 * unchanged — this is a relocation to the right depth, not a rewrite.
 */

import {
  WORK_QUEUE_LANES,
  RELABEL_TARGETS,
  HITL_GRILL_LABEL,
  type WorkQueueLane,
  type WorkQueueRow,
  type BoardActionReason,
  type RelabelTarget,
  type HitlGrillRow,
} from "../schemas/autopilot-board.ts";
import type { IssueRow } from "../github/issues.ts";
import { extractStrictBlockerRefs } from "../github/blockers.ts";
import { hasScopeSection } from "../scope-section.ts";

// ---------------------------------------------------------------------------
// Pure /work projections (issue #4010) — exported for the route and tests
// ---------------------------------------------------------------------------

/**
 * Resolve an issue's operator lane from its labels: the FIRST
 * {@link WORK_QUEUE_LANES} entry present (the order encodes precedence —
 * `ready-for-agent` outranks a stray `needs-triage` because the dispatch
 * signal is the stronger claim). Null when the issue carries no operator lane
 * (agent-owned `in-progress`/`needs-qa`, classification-only labels, …).
 */
export function deriveWorkLane(labels: readonly string[]): WorkQueueLane | null {
  for (const lane of WORK_QUEUE_LANES) {
    if (labels.includes(lane)) return lane;
  }
  return null;
}

/**
 * Project one open {@link IssueRow} into a {@link WorkQueueRow}, or null when
 * it carries no operator lane. `openBlockers` is the endpoint-resolved OPEN
 * strict-blocker set (only meaningful for `ready-for-agent` rows — the same
 * population `resolveOpenBlockers` resolves); per-row numbers are this row's
 * strict refs intersected with that set, self-references excluded.
 */
export function toWorkQueueRow(
  row: IssueRow,
  openBlockers: ReadonlySet<number>,
): WorkQueueRow | null {
  const lane = deriveWorkLane(row.labels);
  if (lane === null) return null;
  const rowBlockers =
    lane === "ready-for-agent" && openBlockers.size > 0
      ? extractStrictBlockerRefs(row.body).filter(
          (n) => n !== row.number && openBlockers.has(n),
        )
      : [];
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    labels: row.labels,
    lane,
    updatedAt: row.updatedAt ?? "",
    openBlockers: rowBlockers,
    glmEligible: row.labels.includes("glm-eligible"),
  };
}

/**
 * Queue ordering: by lane in {@link WORK_QUEUE_LANES} order (the
 * ready-for-agent queue first), then oldest-updated first within a lane.
 */
export function compareWorkQueueRows(a: WorkQueueRow, b: WorkQueueRow): number {
  const laneDelta =
    WORK_QUEUE_LANES.indexOf(a.lane) - WORK_QUEUE_LANES.indexOf(b.lane);
  if (laneDelta !== 0) return laneDelta;
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  // Unparseable timestamps sort LAST (never ahead of a dated row).
  const na = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const nb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  return na - nb;
}

/** Refusal outcome of {@link evaluatePromoteEligibility}. */
export type PromoteEligibility =
  | { eligible: true }
  | { eligible: false; reason: BoardActionReason; detail: string };

/**
 * The promote-to-ready-for-agent gate (ADR-0034 §7's traps, issue #4010):
 *
 *   1. the issue is CLOSED                → refuse (`closed`);
 *   2. it already carries ready-for-agent → refuse (`already-ready`);
 *   3. its body lacks a `## Files in scope` section
 *      (via the ONE shared parser, `hasScopeSection`/`extractScopeFromBody`)
 *                                         → refuse (`missing-scope-section` —
 *                                           applying the label anyway is what
 *                                           issue-label-validation reverts);
 *   4. it cites an OPEN strict blocker     → refuse (`blocked`).
 *
 * Pure: `openBlockers` is pre-resolved by the caller so this stays
 * decision-table testable.
 */
export function evaluatePromoteEligibility(
  row: IssueRow,
  openBlockers: ReadonlySet<number>,
): PromoteEligibility {
  if (row.state === "CLOSED") {
    return {
      eligible: false,
      reason: "closed",
      detail: "issue is closed — reopen it before promoting",
    };
  }
  if (row.labels.includes("ready-for-agent")) {
    return {
      eligible: false,
      reason: "already-ready",
      detail: "issue already carries ready-for-agent",
    };
  }
  if (!hasScopeSection(row.body)) {
    return {
      eligible: false,
      reason: "missing-scope-section",
      detail:
        "issue body has no ## Files in scope section — issue-label-validation would revert ready-for-agent (#396)",
    };
  }
  const openRefs = extractStrictBlockerRefs(row.body).filter(
    (n) => n !== row.number && openBlockers.has(n),
  );
  if (openRefs.length > 0) {
    return {
      eligible: false,
      reason: "blocked",
      detail: `blocked by open issue${openRefs.length > 1 ? "s" : ""} #${openRefs.join(", #")}`,
    };
  }
  return { eligible: true };
}

/** The label transitions a relabel performs: lanes to drop + whether to add. */
export function computeRelabelTransitions(
  currentLabels: readonly string[],
  target: RelabelTarget,
): { remove: string[]; add: boolean } {
  const remove = RELABEL_TARGETS.filter(
    (lane) => lane !== target && currentLabels.includes(lane),
  );
  return { remove, add: !currentLabels.includes(target) };
}

// ---------------------------------------------------------------------------
// Pure hitl-grill projections (issue #4028 slice 4) — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parse a parked idea's reason out of its body. The shipped producers write a
 * blockquoted `> Reason: <…>` line (`docs/operator-playbooks/
 * hydra-architecture-scan.md` step 4c park-body schema); an explicit
 * `Recommendation strength:` line anywhere wins first so a future producer
 * that emits the literal field is picked up without a lane rewrite. Blank
 * when neither marker is present — never a fabricated reason.
 */
export function parseParkReason(body: string): string {
  const strength = body.match(/^\s*>?\s*Recommendation strength:\s*(.+?)\s*$/m);
  if (strength !== null) return strength[1];
  const parked = body.match(/^\s*>\s*Reason:\s*(.+?)\s*$/m);
  if (parked !== null) return parked[1];
  return "";
}

/**
 * Project one issue into a {@link HitlGrillRow}, or null when it is not an
 * OPEN issue carrying the {@link HITL_GRILL_LABEL} park label (the label read
 * is label-filtered and open-by-construction; the guard is the defensive
 * boundary so a future reader change cannot silently widen the lane).
 * Provenance is every label except the lane label itself — the pilot producer
 * always attaches `architecture-scan` alongside, and filtering (not
 * hardcoding one producer) generalizes to the other feeders in epic #4024.
 */
export function toHitlGrillRow(row: IssueRow): HitlGrillRow | null {
  if (row.state === "CLOSED") return null;
  if (!row.labels.includes(HITL_GRILL_LABEL)) return null;
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    provenance: row.labels.filter((l) => l !== HITL_GRILL_LABEL),
    reason: parseParkReason(row.body),
    createdAt: row.createdAt ?? "",
  };
}

/**
 * Lane ordering: oldest `createdAt` first — these are ideas waiting for a
 * verdict, not queue rows the autopilot updates in place. Unparseable
 * timestamps sort LAST (never ahead of a dated row).
 */
export function compareHitlGrillRows(a: HitlGrillRow, b: HitlGrillRow): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const na = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const nb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  return na - nb;
}
