/**
 * Target-backlog-findings aggregator (issue #617, PRD #615).
 *
 * Returns issues labeled `target-backlog` that were opened inside the
 * window AND haven't been routed by sweep yet. "Not routed" = NOT closed
 * AND NOT labeled `in-progress`. These are findings the dashboard wants
 * to surface so the operator can see net-new diagnostics from the
 * `hydra-target-discover` skill that still need triage.
 *
 * # Design contract
 *
 * - **Pure filter core.** `filterUnroutedFindings` is exported separately
 *   so tests can pin the filter behavior without subprocess setup.
 * - **Never throws.** Sub-fetch failure degrades to `[]`.
 * - **Window-based.** Caller passes `windowHours` (1..168). 24h is the
 *   sensible default for an overnight runtime-diagnostics sweep.
 */

import { listIssuesBySearchOrEmpty, type IssueRow } from "../github/issues.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Finding {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
  /** Excerpt of the body — first paragraph or first 240 chars, whichever shorter. */
  excerpt: string;
}

export interface TargetFindingsDeps {
  now?: Date;
  githubRepo?: string;
  /**
   * Override the GitHub Issue/PR Read seam reader (issue #908/#915). Tests
   * inject this to avoid spawning `gh`; production uses the real seam reader,
   * which returns the canonical {@link IssueRow} shape (no local argv/parser).
   */
  listIssuesBySearchOrEmpty?: typeof listIssuesBySearchOrEmpty;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getNewTargetFindings(
  windowHours: number,
  deps: TargetFindingsDeps = {},
): Promise<Finding[]> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const listBySearch = deps.listIssuesBySearchOrEmpty ?? listIssuesBySearchOrEmpty;

  const sinceDate = windowStart.toISOString().split("T")[0];
  const rows = await listBySearch(
    `created:>=${sinceDate}`,
    "target-backlog-findings",
    { label: "target-backlog", state: "all", repo: deps.githubRepo },
  );
  return filterUnroutedFindings(rows, windowStart);
}

// ---------------------------------------------------------------------------
// Pure filter — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Filters the seam's {@link IssueRow} rows
 * to the un-routed subset:
 *
 *   - `state` is OPEN
 *   - no `in-progress` label
 *   - `createdAt` strictly within the window
 *
 * Sorted newest-first so the dashboard shows the freshest diagnostics
 * at the top of the section. The canonical-field parse (number/labels/state
 * normalization) is done by the seam's `parseIssueRows` upstream.
 */
export function filterUnroutedFindings(
  rows: readonly IssueRow[],
  windowStart: Date,
): Finding[] {
  const startMs = windowStart.getTime();
  const out: Finding[] = [];
  for (const row of rows) {
    const createdMs = Date.parse(row.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < startMs) continue;
    // The seam upper-cases `state`; OPEN-only here.
    if (row.state !== "OPEN") continue;
    if (row.labels.includes("in-progress")) continue;
    out.push({
      number: row.number,
      title: row.title,
      url: row.url,
      createdAt: row.createdAt,
      labels: [...row.labels],
      excerpt: excerptOf(row.body),
    });
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out;
}

/**
 * Pure helper — exported for tests. Returns the first non-empty paragraph
 * of a markdown body, trimmed and clamped to 240 chars. Front-matter and
 * blockquote prefixes are kept as-is so the operator sees the original
 * voice of the finding.
 */
export function excerptOf(body: string): string {
  if (!body) return "";
  const paragraphs = body.split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 240) return trimmed;
    return trimmed.slice(0, 237) + "...";
  }
  return "";
}
