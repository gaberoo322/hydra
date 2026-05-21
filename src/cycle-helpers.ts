/**
 * cycle-helpers.ts — Anchor pre-validation (post-ADR-0006 residue).
 *
 * Almost everything that used to live here was tied to the in-process control
 * loop removed by ADR-0006. What remains is `isAnchorStale()` — still imported
 * by `test/anchor-prevalidation.test.mts` but with no live production caller.
 * Keeping the function for now until a follow-up decides whether anchor
 * staleness should be re-wired into the current dispatch path or retired
 * along with its test.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getRecentReportIds, getRealityReport } from "./redis-adapter.ts";

/**
 * Pre-validate an anchor before invoking the planner. Returns a skip reason
 * string if the anchor is stale/completed, or null if it should proceed.
 *
 * Checks:
 * 1. Reference matches a completed item in priorities.md
 * 2. Queue item is marked COMPLETED: in its reference
 * 3. Reference is a duplicate of another item already in the work queue
 */
export async function isAnchorStale(anchor: any): Promise<string | null> {
  const ref = (anchor.reference || "").toLowerCase().trim();
  if (!ref) return null;

  // Check for COMPLETED: prefix in queue items
  if (ref.startsWith("completed:")) {
    return "Queue item already marked as completed";
  }

  // Check for duplicate of recently-merged task (last 10 cycle reports)
  try {
    const reportIds = await getRecentReportIds(10);
    for (const rid of reportIds) {
      const raw = await getRealityReport(rid);
      if (!raw) continue;
      try {
        const report = JSON.parse(raw);
        if (report.task?.finalState !== "merged") continue;
        const mergedTitle = (report.task?.title || "").toLowerCase().trim();
        if (!mergedTitle || mergedTitle.length < 10) continue;

        // Word-overlap similarity (same approach as priorities.md check)
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const mergedWords = new Set<string>(mergedTitle.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || mergedWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => mergedWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, mergedWords.size);
        if (similarity > 0.6) {
          return `Duplicates recently merged task: "${mergedTitle.slice(0, 80)}"`;
        }
      } catch { /* intentional: skip unparseable reports */ }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Recent-merge duplicate check failed (proceeding): ${err.message}`);
  }

  // Check against completed items in priorities.md
  try {
    const CONFIG_DIR = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");
    const priorities = await readFile(join(CONFIG_DIR, "direction", "priorities.md"), "utf-8");

    // Extract the "What's been completed" section
    const completedMatch = priorities.match(/# What's been completed[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (completedMatch) {
      const completedLines = completedMatch[1]
        .split("\n")
        .map(l => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
        .filter(l => l.length > 10);

      for (const completed of completedLines) {
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const compWords = new Set<string>(completed.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || compWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => compWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, compWords.size);
        if (similarity > 0.6) {
          return `Matches completed item: "${completed.slice(0, 80)}"`;
        }
      }
    }

    // Also check "What NOT to work on" section
    const notWorkMatch = priorities.match(/# What NOT to work on[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (notWorkMatch) {
      const notWorkLines = notWorkMatch[1]
        .split("\n")
        .map(l => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
        .filter(l => l.length > 10);

      for (const blocked of notWorkLines) {
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const blockWords = new Set<string>(blocked.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || blockWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => blockWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, blockWords.size);
        if (similarity > 0.6) {
          return `Matches 'do not work on': "${blocked.slice(0, 80)}"`;
        }
      }
    }
  } catch (err: any) {
    // priorities.md may be missing on fresh installs; log non-ENOENT failures so
    // a stuck reader is observable, but never block the cycle on this check.
    if (err?.code !== "ENOENT") {
      console.error(`[ControlLoop] priorities.md duplicate-check read failed (proceeding): ${err?.message ?? err}`);
    }
  }

  return null;
}
