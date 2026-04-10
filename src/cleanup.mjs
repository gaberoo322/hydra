/**
 * Report Cleanup
 *
 * Deletes stale auto-generated files to prevent unbounded vault growth.
 *
 *   cycle-summaries/  — raw Codex agent outputs. Delete after 2 days.
 *                       (Rarely read by operators; useful data is in reality-reports.)
 *   reality-reports/  — structured cycle outcomes. Keep last 50.
 *                       (Control loop reads the latest for continuity.)
 *   archive/          — previously archived files. Delete after 7 days.
 *
 * Runs on startup and then daily.
 */

import { readdir, unlink, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { archiveApprovedProposals } from "./proposals.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");

const CYCLE_SUMMARIES_DIR = join(HYDRA_PATH, "reports", "cycle-summaries");
const REALITY_REPORTS_DIR = join(HYDRA_PATH, "reports", "reality-reports");
const RESEARCH_DIR = join(HYDRA_PATH, "reports", "research");

const CYCLE_SUMMARIES_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const REALITY_REPORTS_KEEP = 50; // keep most recent 50
const RESEARCH_REPORTS_KEEP = 20; // keep most recent 20

/**
 * Delete files older than maxAgeMs from a directory.
 */
async function deleteOldFiles(dir, maxAgeMs, extensions = [".md"]) {
  try {
    const files = await readdir(dir);
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (!extensions.some(ext => file.endsWith(ext))) continue;
      try {
        const fileStat = await stat(join(dir, file));
        if (now - fileStat.mtimeMs > maxAgeMs) {
          await unlink(join(dir, file));
          deleted++;
        }
      } catch {}
    }

    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Keep only the N most recent files in a directory, delete the rest.
 */
async function keepRecentFiles(dir, keepCount, extensions = [".json"]) {
  try {
    const files = await readdir(dir);
    const matching = files.filter(f => extensions.some(ext => f.endsWith(ext)));

    if (matching.length <= keepCount) return 0;

    // Sort by mtime descending (newest first)
    const withStats = [];
    for (const file of matching) {
      try {
        const fileStat = await stat(join(dir, file));
        withStats.push({ file, mtime: fileStat.mtimeMs });
      } catch {}
    }
    withStats.sort((a, b) => b.mtime - a.mtime);

    // Delete everything beyond keepCount
    let deleted = 0;
    for (const { file } of withStats.slice(keepCount)) {
      try {
        await unlink(join(dir, file));
        deleted++;
      } catch {}
    }
    return deleted;
  } catch {
    return 0;
  }
}

async function runCleanup() {
  const results = [];

  // Cycle summaries: delete after 2 days (raw agent outputs, low retention value)
  const summaries = await deleteOldFiles(CYCLE_SUMMARIES_DIR, CYCLE_SUMMARIES_MAX_AGE_MS);
  if (summaries > 0) results.push(`${summaries} cycle-summaries`);

  // Reality reports: keep last 50 (control loop reads latest for continuity)
  const reports = await keepRecentFiles(REALITY_REPORTS_DIR, REALITY_REPORTS_KEEP);
  if (reports > 0) results.push(`${reports} reality-reports`);

  // Research reports: keep last 20 (strategist reads latest, ~46K each)
  const research = await keepRecentFiles(RESEARCH_DIR, RESEARCH_REPORTS_KEEP, [".json", ".md"]);
  if (research > 0) results.push(`${research} research-reports`);

  if (results.length > 0) {
    console.log(`[Cleanup] Deleted: ${results.join(", ")}`);
  }
}

function startCleanupSchedule() {
  // Run immediately on startup
  runCleanup();
  archiveApprovedProposals();

  // Then daily
  setInterval(() => {
    runCleanup();
    archiveApprovedProposals();
  }, 24 * 60 * 60 * 1000);
  console.log("[Cleanup] Scheduled (daily): cycle-summaries 2d, reality-reports keep 50, archive 7d");
}

export { startCleanupSchedule, runCleanup };
