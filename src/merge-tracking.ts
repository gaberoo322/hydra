/**
 * merge-tracking.ts — Track merged commits and correlate with reverts.
 *
 * Extracted from the removed in-cycle adversarial agent in issue #344 (Phase A codex-removal).
 * The in-cycle adversarial agent was removed, but the merge-tracking and
 * revert-correlation logic is preserved because:
 *   - Redis schema `hydra:adversarial:*` is still consumed by digest +
 *     dashboard (precision stats over time).
 *   - The nightly replacement skill
 *     (docs/operator-playbooks/hydra-target-adversarial.md) will refresh
 *     stats out-of-band; until that lands, post-merge.ts still tracks
 *     merges so the schema isn't orphaned.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pushTrackedMerge, getTrackedMerges, setAdversarialStats } from "./redis-adapter.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types — preserved for compatibility with stored Redis entries.
// ---------------------------------------------------------------------------

export type AdversarialFinding = {
  file: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggestedTest?: string;
};

type TrackedMerge = {
  cycleId: string;
  commitSha: string;
  findingsCount: number;
  findings: AdversarialFinding[];
  mergedAt: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a merged commit for later revert-correlation.
 * Maintains a rolling window of 50 tracked merges.
 */
export async function trackMergedCommit(
  cycleId: string,
  commitSha: string,
  findings: AdversarialFinding[],
): Promise<void> {
  try {
    const entry: TrackedMerge = {
      cycleId,
      commitSha,
      findingsCount: findings.length,
      findings: findings.slice(0, 10),
      mergedAt: new Date().toISOString(),
    };
    await pushTrackedMerge(JSON.stringify(entry), 50);
  } catch (err: any) {
    console.error(`[MergeTracking] Failed to track merge: ${err.message}`);
  }
}

/**
 * Check recent git history for reverts of tracked commits.
 * Updates precision stats: true positives (findings + reverted),
 * false negatives (no findings + reverted), true negatives (no findings + not reverted).
 */
export async function checkRevertCorrelation(projectDir: string): Promise<{
  truePositives: number;
  falseNegatives: number;
  totalReverts: number;
  precision: number | null;
}> {
  try {
    const rawEntries = await getTrackedMerges();
    if (rawEntries.length === 0) return { truePositives: 0, falseNegatives: 0, totalReverts: 0, precision: null };

    let truePositives = 0;
    let falseNegatives = 0;
    let totalReverts = 0;

    for (const raw of rawEntries) {
      try {
        const entry: TrackedMerge = JSON.parse(raw);
        const { stdout: revertCheck } = await execFileAsync(
          "git", ["log", "--oneline", "--since=14 days ago", "--grep", `Revert.*${entry.commitSha.slice(0, 7)}`],
          { cwd: projectDir, timeout: 5000 },
        ).catch(() => ({ stdout: "" }));

        const wasReverted = revertCheck.trim().length > 0;
        if (wasReverted) {
          totalReverts++;
          if (entry.findingsCount > 0) {
            truePositives++;
          } else {
            falseNegatives++;
          }
        }
      } catch { /* intentional: skip unparseable entries */ }
    }

    const stats = { truePositives, falseNegatives, totalReverts, checkedAt: new Date().toISOString() };
    const precision = totalReverts > 0 ? truePositives / totalReverts : null;
    await setAdversarialStats(JSON.stringify({ ...stats, precision }));

    if (totalReverts > 0) {
      console.log(`[MergeTracking] Revert correlation: ${truePositives} true positives, ${falseNegatives} false negatives out of ${totalReverts} reverts (precision: ${precision !== null ? Math.round(precision * 100) + "%" : "N/A"})`);
    }

    return { truePositives, falseNegatives, totalReverts, precision };
  } catch (err: any) {
    console.error(`[MergeTracking] Revert correlation check failed: ${err.message}`);
    return { truePositives: 0, falseNegatives: 0, totalReverts: 0, precision: null };
  }
}
