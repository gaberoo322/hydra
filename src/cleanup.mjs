/**
 * Report Cleanup
 *
 * Archives cycle reports older than 7 days to reports/archive/.
 * Runs on startup and then daily.
 */

import { readdir, rename, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { archiveApprovedProposals } from "./proposals.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const REPORTS_DIR = join(HYDRA_PATH, "reports", "cycle-summaries");
const ARCHIVE_DIR = join(HYDRA_PATH, "reports", "archive");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function archiveOldReports() {
  try {
    const files = await readdir(REPORTS_DIR);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const now = Date.now();
    let archived = 0;

    await mkdir(ARCHIVE_DIR, { recursive: true });

    for (const file of mdFiles) {
      try {
        const fileStat = await stat(join(REPORTS_DIR, file));
        if (now - fileStat.mtimeMs > MAX_AGE_MS) {
          await rename(join(REPORTS_DIR, file), join(ARCHIVE_DIR, file));
          archived++;
        }
      } catch {}
    }

    if (archived > 0) {
      console.log(`[Cleanup] Archived ${archived} reports older than 7 days`);
    }
  } catch (err) {
    console.error(`[Cleanup] Failed:`, err.message);
  }
}

function startCleanupSchedule() {
  // Run immediately on startup
  archiveOldReports();
  archiveApprovedProposals();

  // Then daily
  setInterval(() => {
    archiveOldReports();
    archiveApprovedProposals();
  }, 24 * 60 * 60 * 1000);
  console.log("[Cleanup] Report + proposal archival scheduled (daily, 7-day retention)");
}

export { startCleanupSchedule, archiveOldReports };
