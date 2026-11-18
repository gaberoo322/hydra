/**
 * Rank 5 `parked-over-cap` line (issue #4626): ONE aggregate draft once the
 * hitl-grill lane holds >= HITL_GRILL_CAP rows. Extracted from
 * src/attention.ts (issue #5615).
 */

import { HITL_GRILL_CAP, HITL_GRILL_LABEL } from "../schemas/autopilot-board.ts";
import {
  listIssuesByLabel,
  type IssueReadResult,
  type IssueRow,
} from "../github/issues.ts";
import { projectHitlGrillLane } from "../autopilot/work-projections.ts";
import { logger } from "../logger.ts";
import { settle, type BucketRead } from "./draft.ts";

/** Rank-5 injection slice (see AttentionFeedDeps). */
export interface ParkedBucketDeps {
  /** Rank-5 hitl-grill lane read (issue #4626). Default: listIssuesByLabel(HITL_GRILL_LABEL, {repo}). */
  readHitlGrillIssues?: () => Promise<IssueReadResult<IssueRow>>;
}

/**
 * Rank 5 (issue #4626): one aggregate `parked-over-cap:cap` draft iff the open
 * hitl-grill lane holds >= HITL_GRILL_CAP rows. Same projection as
 * GET /autopilot/hitl-grill (projectHitlGrillLane). Never throws; a failed or
 * rejected read names `hitl-grill` (UNKNOWN), never an asserted zero.
 */
export async function readParked(
  deps: ParkedBucketDeps,
  repo: string,
  nowDate: Date,
): Promise<BucketRead> {
  const readLane =
    deps.readHitlGrillIssues ?? (() => listIssuesByLabel(HITL_GRILL_LABEL, { repo }));
  const result = await settle(readLane);
  if (result.status === "rejected") {
    logger.error({ err: result.reason }, "[attention] hitl-grill lane read threw");
    return { drafts: [], scanned: 0, sourceErrors: ["hitl-grill"] };
  }
  const read = result.value;
  if (read.ok !== true) {
    logger.error({ code: read.code }, "[attention] hitl-grill lane read failed");
    return { drafts: [], scanned: 0, sourceErrors: ["hitl-grill"] };
  }
  const rows = projectHitlGrillLane(read.rows);
  const scanned = read.rows.length;
  if (rows.length < HITL_GRILL_CAP) return { drafts: [], scanned, sourceErrors: [] };
  const capped = Date.parse(rows[HITL_GRILL_CAP - 1].createdAt);
  const crossedAt = Number.isFinite(capped)
    ? new Date(capped).toISOString()
    : nowDate.toISOString();
  return {
    scanned,
    sourceErrors: [],
    drafts: [
      {
        key: "parked-over-cap:cap",
        context: {},
        base: {
          id: "parked-over-cap:cap",
          signal: "blocked-on-human",
          title: `Parked ideas over cap: ${rows.length} / ${HITL_GRILL_CAP}`,
          url: "/work",
          dismissed: false,
          observedValue: rows.length,
          threshold: HITL_GRILL_CAP,
          thresholdLabel: `parked ≥ ${HITL_GRILL_CAP}`,
          crossedAt,
          detail: rows
            .slice(0, 3)
            .map((r) => `#${r.number} ${r.title}`)
            .join("; "),
        },
      },
    ],
  };
}
