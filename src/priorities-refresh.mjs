/**
 * Priorities Refresh
 *
 * Auto-generates direction/priorities.md by reading the operator's north
 * star (user-priorities.md), recent accomplishments, current repo state,
 * and backlog, then calling a nano-model agent to produce actionable,
 * specific priorities.
 *
 * Triggered by:
 *   - Scheduler: after every research cycle (new findings inform priorities)
 *   - Control loop: when priorities doc is flagged as stale (5+ uses)
 *   - API: POST /priorities/refresh (manual trigger)
 *
 * The operator writes user-priorities.md (rarely changes).
 * This module writes priorities.md (changes frequently, auto-updated).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent, findPersonality } from "./codex-runner.mjs";
import { getCumulativeAccomplishments, getMetricsTrend } from "./metrics.mjs";
import { getBacklogCounts, loadBacklog } from "./backlog.mjs";
import { groundProject, summarizeForPrompt } from "./grounding.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const DIRECTION_DIR = join(HYDRA_PATH, "direction");
const USER_PRIORITIES_FILE = join(DIRECTION_DIR, "user-priorities.md");
const PRIORITIES_FILE = join(DIRECTION_DIR, "priorities.md");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

/**
 * Refresh direction/priorities.md based on operator north star + system state.
 *
 * @param {object} opts
 * @param {object} opts.grounding - Pre-computed grounding report (optional, avoids re-running tests)
 * @param {string} opts.trigger - What triggered this refresh ("stale", "research", "manual")
 * @returns {{ ok: boolean, error?: string, priorities?: string }}
 */
export async function refreshPriorities(opts = {}) {
  const trigger = opts.trigger || "manual";
  console.log(`[PrioritiesRefresh] Starting (trigger: ${trigger})`);

  // 1. Read operator's north star
  let userPriorities = "";
  try {
    userPriorities = await readFile(USER_PRIORITIES_FILE, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`[PrioritiesRefresh] No user-priorities.md found — skipping refresh`);
      return { ok: false, error: "No user-priorities.md found. Create direction/user-priorities.md with your north star goals." };
    }
    throw err;
  }

  // 2. Read current priorities (so the agent can see what's there)
  let currentPriorities = "";
  try {
    currentPriorities = await readFile(PRIORITIES_FILE, "utf-8");
  } catch { /* no existing file is fine */ }

  // 3. Get recent accomplishments
  let accomplishments = "";
  try {
    const acc = await getCumulativeAccomplishments(20);
    if (acc.length > 0) {
      accomplishments = acc.map(a => `- "${a.title}" (${a.anchorType}, ${a.cycleId})`).join("\n");
    }
  } catch (err) {
    console.error(`[PrioritiesRefresh] Failed to load accomplishments: ${err.message}`);
  }

  // 4. Get metrics trend
  let metricsContext = "";
  try {
    const trend = await getMetricsTrend(10);
    const merged = trend.filter(m => m.tasksMerged > 0).length;
    const failed = trend.filter(m => m.tasksFailed > 0).length;
    metricsContext = `Last 10 cycles: ${merged} merged, ${failed} failed.`;
  } catch {}

  // 5. Get backlog state
  let backlogContext = "";
  try {
    const counts = await getBacklogCounts();
    const lanes = await loadBacklog();
    backlogContext = `Backlog: ${counts.backlog} items, Queued: ${counts.queued}, Blocked: ${counts.blocked || 0}, In Progress: ${counts.inProgress}, Done: ${counts.done}`;
    if (lanes.queued.length > 0) {
      backlogContext += "\nQueued items:\n" + lanes.queued.map(i => `- ${i.title}`).join("\n");
    }
    if ((lanes.blocked || []).length > 0) {
      backlogContext += "\nBlocked items (need operator):\n" + (lanes.blocked || []).map(i => `- ${i.title} — ${i.meta?.blockedReason || "unknown"}`).join("\n");
    }
  } catch {}

  // 6. Get compact grounding (use pre-computed if available to avoid re-running tests)
  let groundingContext = "";
  try {
    const grounding = opts.grounding || await groundProject(PROJECT_WORKSPACE);
    groundingContext = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
  } catch (err) {
    console.error(`[PrioritiesRefresh] Grounding failed: ${err.message}`);
  }

  // 7. Read latest research findings (if any)
  let researchContext = "";
  try {
    const researchDir = join(HYDRA_PATH, "reports", "research");
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(researchDir)).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 1);
    if (files.length > 0) {
      const content = await readFile(join(researchDir, files[0]), "utf-8");
      // Extract just the opportunity list, not the full report
      const oppsMatch = content.match(/## (?:Ranked |Top )?Opportunities[\s\S]*?(?=##|$)/i);
      if (oppsMatch) {
        researchContext = oppsMatch[0].slice(0, 1500);
      }
    }
  } catch {}

  // 8. Build the prompt
  const prompt = [
    `## YOUR JOB`,
    `You are the Priorities Agent. Read the operator's north star goals and the current system state, then produce an updated priorities.md that drives the system toward the operator's goals.`,
    ``,
    `## OPERATOR'S NORTH STAR (this is what they want — follow it)`,
    userPriorities.slice(0, 3000),
    ``,
    `## RECENT ACCOMPLISHMENTS (what's already done — do NOT re-propose)`,
    accomplishments || "No recent accomplishments found.",
    ``,
    `## CURRENT BACKLOG STATE`,
    backlogContext || "No backlog data available.",
    ``,
    `## METRICS`,
    metricsContext || "No metrics available.",
    ``,
    `## CURRENT REPO STATE`,
    groundingContext || "No grounding data available.",
    ``,
    researchContext ? `## LATEST RESEARCH FINDINGS\n${researchContext}\n` : "",
    ``,
    `## CURRENT PRIORITIES.MD (may be stale)`,
    currentPriorities ? currentPriorities.slice(0, 2000) : "No existing priorities file.",
    ``,
    `## INSTRUCTIONS`,
    `Write an updated priorities.md that:`,
    `1. Directly serves the operator's north star goals — not your own ideas`,
    `2. Removes items that are already accomplished`,
    `3. Promotes items that are closest to the operator's "what done looks like"`,
    `4. Includes concrete, specific tasks (not vague direction)`,
    `5. Keeps the format that the Planner agent expects (markdown with clear sections)`,
    `6. Starts with "Current state" summary so the planner knows where things stand`,
    `7. Lists 5-10 actionable items in priority order`,
    `8. Marks items that need operator intervention (API keys, credentials) as BLOCKED`,
    `9. Includes "What's been completed" section so the planner doesn't re-propose done work`,
    `10. Is concise — under 150 lines`,
    ``,
    `Output the COMPLETE priorities.md file content. No JSON wrapping. No code fences. Just the markdown.`,
  ].filter(Boolean).join("\n");

  // 9. Call the agent
  try {
    const result = await runAgent({
      agentName: "planner",
      personality: await findPersonality("planner"),
      prompt,
      model: "codex",
      taskId: "priorities-refresh",
      correlationId: `priorities-refresh-${Date.now()}`,
    });

    if (!result.output || result.output.trim().length < 50) {
      console.error(`[PrioritiesRefresh] Agent produced empty or too-short output`);
      return { ok: false, error: "Agent produced insufficient output" };
    }

    // Guard: reject raw Codex error streams that look like JSON events
    if (result.output.includes('"type":"error"') || result.output.includes('"type":"turn.failed"')) {
      console.error(`[PrioritiesRefresh] Agent returned error stream, not markdown: ${result.output.slice(0, 200)}`);
      return { ok: false, error: "Agent returned error stream instead of markdown" };
    }

    // 10. Clean up the output — remove code fences if the agent wrapped it
    let content = result.output.trim();
    if (content.startsWith("```")) {
      content = content.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }

    // 11. Add metadata header
    const date = new Date().toISOString().split("T")[0];
    const header = [
      `---`,
      `updated: ${date}`,
      `refreshedBy: priorities-agent`,
      `trigger: ${trigger}`,
      `status: active`,
      `tags: [hydra, hydra/direction]`,
      `---`,
      ``,
    ].join("\n");

    const finalContent = content.startsWith("---") ? content : header + content;

    // 12. Write the file
    await writeFile(PRIORITIES_FILE, finalContent + "\n");
    console.log(`[PrioritiesRefresh] Updated priorities.md (${finalContent.split("\n").length} lines, trigger: ${trigger})`);

    return { ok: true, priorities: finalContent, trigger, duration: result.duration };
  } catch (err) {
    console.error(`[PrioritiesRefresh] Agent call failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
