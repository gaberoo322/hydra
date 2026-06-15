/**
 * Roadmap config reader — typed reader for `config/direction/roadmap.md`.
 *
 * This module owns *planning-document* reads (config files on disk), as opposed
 * to the Backlog Module (`src/backlog/`), which owns *kanban-lane state* (Redis).
 * `getCurrentMilestoneProgress` lived in `src/backlog/reads.ts` until #1927 moved
 * it here: that module's contract is "non-mutating Redis queries the dashboard
 * and scheduler consume", and a direct `fs.readFile` of a config file violated it.
 *
 * Path-resolution mirrors `src/project-goals.ts` / `src/outcomes.ts`: the config
 * root is `HYDRA_CONFIG_PATH`, falling back to `~/hydra/config`. This is the
 * natural expansion point for any future roadmap-derived metric (e.g. "days since
 * last milestone completion") — those land here, not in the Backlog Module.
 *
 * Per CLAUDE.md fail-loud: a missing roadmap.md is the legitimate "no active
 * milestone yet" path (stay quiet); any other read/parse fault is logged.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const ROADMAP_FILE = join(CONFIG_PATH, "direction", "roadmap.md");

/**
 * Parse the active milestone from roadmap.md and return progress.
 */
export async function getCurrentMilestoneProgress() {
  try {
    const roadmap = await readFile(ROADMAP_FILE, "utf-8");
    const blocks = roadmap.split(/^## /m).filter(Boolean);
    for (const block of blocks) {
      if (!block.includes("status: active")) continue;
      const nameMatch = block.match(/^(.+)\n/);
      const name = nameMatch ? nameMatch[1].trim() : "Unknown";
      const lines = block.split("\n");
      const epics = lines.filter(l => /^- \[[ x\-]\]/.test(l));
      const done = epics.filter(l => l.startsWith("- [x]")).length;
      const blocked = epics.filter(l => l.startsWith("- [-]")).length;
      const total = epics.length;
      const remaining = epics
        .filter(l => l.startsWith("- [ ]"))
        .map(l => l.replace(/^- \[ \] /, "").trim());
      return {
        name,
        total,
        done,
        blocked,
        remaining: total - done - blocked,
        remainingTitles: remaining,
        pctComplete: total > 0 ? Math.round((done / total) * 100) : 0,
      };
    }
    return null;
  } catch (err: any) {
    // A missing roadmap.md is the legitimate "no active milestone yet" path —
    // stay quiet. Anything else (parse/permission/etc.) is a real fault that
    // must not be swallowed silently (CLAUDE.md fail-loud; issue #1122).
    if (err?.code !== "ENOENT") {
      console.error("[config/roadmap] getCurrentMilestoneProgress failed reading roadmap.md", err);
    }
    return null;
  }
}
