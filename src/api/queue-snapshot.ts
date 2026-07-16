/**
 * Work-queue snapshot assembly — pure formatting leaf (issue #3377).
 *
 * The Markdown-report grammar lifted out of the `GET /queue/snapshot` handler in
 * `src/api/queue.ts`. This mirrors the `digest.ts` -> `digest-format.ts` split:
 * the pure assembly grammar gets its own testable home while the route handler
 * stays a thin adapter (fan-out the three reads, call this, format per Accept).
 *
 * `buildWorkQueueSnapshot` is **pure**: it takes the three already-fetched data
 * bags plus a `now` string and returns the Markdown string — no Redis, no
 * `req`/`res`, no clock read. That makes it directly unit-testable without an
 * Express or Redis fixture. The on-wire output is byte-identical to the
 * pre-extraction inline assembly.
 */

import type { Backlog } from "../backlog/reads.ts";

/**
 * A parsed work-queue entry as the snapshot route hands it in. The queue stores
 * JSON strings; the route parses them (falling back to `{ reference: <raw> }` on
 * a parse failure), so only `reference` is guaranteed. `source` drives the
 * `[source]` provenance tag, defaulting to `"operator"` when absent (issue #1140).
 */
export interface WorkQueueSnapshotItem {
  reference: string;
  source?: string;
  [key: string]: unknown;
}

/**
 * Assemble the human-readable Markdown work snapshot.
 *
 * @param counts    Lane-depth counts (`getBacklogCounts()` shape).
 * @param backlog   Loaded lanes (`loadBacklog()` shape).
 * @param queueItems Parsed work-queue entries.
 * @param now       The report date (e.g. `new Date().toISOString().split("T")[0]`),
 *                  taken as an argument so the function stays clock-free.
 * @returns The Markdown snapshot string.
 */
export function buildWorkQueueSnapshot(
  counts: Record<string, number>,
  backlog: Backlog,
  queueItems: WorkQueueSnapshotItem[],
  now: string,
): string {
  const lines: string[] = [];
  lines.push(`# Work Snapshot (${now})`);
  lines.push("");
  lines.push(`## Lane Counts`);
  lines.push(`| Lane | Count |`);
  lines.push(`|------|-------|`);
  lines.push(`| Triage | ${counts.triage || 0} |`);
  lines.push(`| Backlog | ${counts.backlog || 0} |`);
  lines.push(`| Queued | ${counts.queued || 0} |`);
  lines.push(`| In Progress | ${counts.inProgress || 0} |`);
  lines.push(`| Blocked | ${counts.blocked || 0} |`);
  lines.push(`| Done | ${counts.done || 0} |`);
  lines.push("");

  // In-progress items
  const inProgress = backlog.inProgress;
  if (inProgress.length > 0) {
    lines.push(`## In Progress`);
    for (const item of inProgress) {
      lines.push(`- ${item.title} (${item.meta?.claimedBy || "unknown"}, started ${item.meta?.startedAt || "?"})`);
    }
    lines.push("");
  }

  // Work queue
  lines.push(`## Work Queue (${queueItems.length} items)`);
  if (queueItems.length === 0) {
    lines.push("(empty)");
  } else {
    for (const item of queueItems) {
      const source = item.source || "operator";
      lines.push(`- [${source}] ${item.reference}`);
    }
  }
  lines.push("");

  // Triage items needing review
  const triage = backlog.triage;
  if (triage.length > 0) {
    lines.push(`## Triage (${triage.length} awaiting review)`);
    for (const item of triage.slice(0, 10)) {
      lines.push(`- ${item.title} (${item.meta?.source || "unknown"}, ${item.meta?.addedAt || "?"})`);
    }
    if (triage.length > 10) lines.push(`  ... and ${triage.length - 10} more`);
    lines.push("");
  }

  // Blocked items
  const blocked = backlog.blocked;
  if (blocked.length > 0) {
    lines.push(`## Blocked (${blocked.length})`);
    for (const item of blocked) {
      lines.push(`- ${item.title} — ${item.meta?.blockedReason || "no reason"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
