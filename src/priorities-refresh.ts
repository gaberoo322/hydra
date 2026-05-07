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
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getCumulativeAccomplishments, getMetricsTrend } from "./metrics.ts";
import { _admin, addItem } from "./backlog.ts";
const { getBacklogCounts, loadBacklog, blockItemById } = _admin;
import { groundProject, summarizeForPrompt } from "./grounding.ts";
import { redisKeys } from "./redis-keys.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const DIRECTION_DIR = join(CONFIG_PATH, "direction");
const USER_PRIORITIES_FILE = join(DIRECTION_DIR, "user-priorities.md");
const PRIORITIES_FILE = join(DIRECTION_DIR, "priorities.md");
const ROADMAP_FILE = join(DIRECTION_DIR, "roadmap.md");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");
const ROADMAP_DELIMITER = "\n---ROADMAP_UPDATE---\n";

/**
 * Refresh direction/priorities.md based on operator north star + system state.
 *
 * @param {object} opts
 * @param {object} opts.grounding - Pre-computed grounding report (optional, avoids re-running tests)
 * @param {string} opts.trigger - What triggered this refresh ("stale", "research", "manual")
 * @returns {{ ok: boolean, error?: string, priorities?: string }}
 */
export async function refreshPriorities(opts: Record<string, any> = {}) {
  const trigger = opts.trigger || "manual";
  console.log(`[PrioritiesRefresh] Starting (trigger: ${trigger})`);

  // 1. Read operator vision (preferred) or north star (fallback)
  let userPriorities = "";
  try {
    userPriorities = await readFile(join(DIRECTION_DIR, "vision.md"), "utf-8");
    console.log(`[PrioritiesRefresh] Loaded operator vision (vision.md)`);
  } catch {
    try {
      userPriorities = await readFile(USER_PRIORITIES_FILE, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        console.log(`[PrioritiesRefresh] No vision.md or user-priorities.md found — skipping refresh`);
        return { ok: false, error: "No vision or priorities file found." };
      }
      throw err;
    }
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
    // @ts-expect-error — migrate to proper types
      accomplishments = acc.map(a => `- "${a.title}" (${a.anchorType}, ${a.cycleId})`).join("\n");
    }
  } catch (err: any) {
    console.error(`[PrioritiesRefresh] Failed to load accomplishments: ${err.message}`);
  }

  // 4. Get metrics trend
  let metricsContext = "";
  try {
    const trend = await getMetricsTrend(10);
    const merged = trend.filter(m => m.tasksMerged > 0).length;
    const failed = trend.filter(m => m.tasksFailed > 0).length;
    metricsContext = `Last 10 cycles: ${merged} merged, ${failed} failed.`;
  } catch { /* intentional: metrics trend is optional context for priorities refresh */ }

  // 5. Get backlog state
  let backlogContext = "";
  try {
    const counts = await getBacklogCounts();
    const lanes = await loadBacklog();
    backlogContext = `Triage: ${counts.triage || 0}, Backlog: ${counts.backlog} items, Queued: ${counts.queued}, Blocked: ${counts.blocked || 0}, In Progress: ${counts.inProgress}, Done: ${counts.done}`;
    // @ts-expect-error — migrate to proper types
    if ((lanes.triage || []).length > 0) {
    // @ts-expect-error — migrate to proper types
      backlogContext += "\nTriage (awaiting review):\n" + lanes.triage.map(i => `- ${i.title}`).join("\n");
    }
    // @ts-expect-error — migrate to proper types
    if (lanes.queued.length > 0) {
    // @ts-expect-error — migrate to proper types
      backlogContext += "\nQueued items:\n" + lanes.queued.map(i => `- ${i.title}`).join("\n");
    }
    // @ts-expect-error — migrate to proper types
    if ((lanes.blocked || []).length > 0) {
    // @ts-expect-error — migrate to proper types
      backlogContext += "\nBlocked items (need operator):\n" + (lanes.blocked || []).map(i => `- ${i.title} — ${i.meta?.blockedReason || "unknown"}`).join("\n");
    }
  } catch {}

  // 6. Get compact grounding (use pre-computed if available to avoid re-running tests)
  let groundingContext = "";
  try {
    const grounding = opts.grounding || await groundProject(PROJECT_WORKSPACE);
    groundingContext = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
  } catch (err: any) {
    console.error(`[PrioritiesRefresh] Grounding failed: ${err.message}`);
  }

  // 7. Read latest research findings from Redis (if any)
  let researchContext = "";
  try {
    const { findKeys: findRedisKeys, getString: getRedisString } = await import("./redis-adapter.ts");
    const keys = await findRedisKeys(redisKeys.researchReport("*"));
    if (keys.length > 0) {
      const latestKey = keys.sort().pop();
      const raw = await getRedisString(latestKey);
      if (raw) {
        const content = typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw).content || raw : raw;
        const oppsMatch = content.match(/## (?:Ranked |Top )?Opportunities[\s\S]*?(?=##|$)/i);
        if (oppsMatch) researchContext = oppsMatch[0].slice(0, 1500);
      }
    }
  } catch {}

  // 7.5. Read current roadmap (milestone tracking)
  let roadmapContext = "";
  try {
    roadmapContext = await readFile(ROADMAP_FILE, "utf-8");
    console.log(`[PrioritiesRefresh] Loaded roadmap.md`);
  } catch { /* no roadmap file is fine */ }

  // 7.6. Read data assets manifest (what data is available)
  let dataAssetsContext = "";
  try {
    dataAssetsContext = await readFile(join(DIRECTION_DIR, "data-assets.md"), "utf-8");
    console.log(`[PrioritiesRefresh] Loaded data-assets.md`);
  } catch { /* intentional: no data-assets file is fine */ }

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
    dataAssetsContext ? `## DATA ASSETS (what data is available for features)\n${dataAssetsContext.slice(0, 2000)}\n` : "",
    `## CURRENT PRIORITIES.MD (may be stale)`,
    currentPriorities ? currentPriorities.slice(0, 2000) : "No existing priorities file.",
    ``,
    roadmapContext ? `## CURRENT ROADMAP (milestone tracking)\n${roadmapContext.slice(0, 3000)}\n` : "",
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
    ``,
    roadmapContext ? [
      `THEN, after the priorities content, output the exact line:`,
      `---ROADMAP_UPDATE---`,
      `Followed by the COMPLETE updated roadmap.md content.`,
      `Update the roadmap by:`,
      `- Checking off epics (\`- [ ]\` → \`- [x]\`) that match completed work`,
      `- Marking a milestone \`status: complete\` with \`completed: YYYY-MM-DD\` when ALL its epics are checked`,
      `- Advancing the next planned milestone to \`status: active\` with \`started: YYYY-MM-DD\` when the prior active milestone completes`,
      `- Marking blocked epics (\`- [-]\`) for items that need operator intervention`,
      `- Leaving future planned milestones unchanged unless you have clear evidence to update them`,
      `- Preserving the exact format: ## heading, status/started/completed metadata lines, description, then checklist`,
    ].join("\n") : "",
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
    let fullOutput = result.output.trim();
    if (fullOutput.startsWith("```")) {
      fullOutput = fullOutput.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }

    // 10.5. Split priorities and roadmap if delimiter is present
    let content = fullOutput;
    let roadmapUpdate = "";
    const delimIdx = fullOutput.indexOf(ROADMAP_DELIMITER.trim());
    if (delimIdx !== -1) {
      content = fullOutput.slice(0, delimIdx).trim();
      roadmapUpdate = fullOutput.slice(delimIdx + ROADMAP_DELIMITER.trim().length).trim();
      // Strip code fences from roadmap section too
      if (roadmapUpdate.startsWith("```")) {
        roadmapUpdate = roadmapUpdate.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      }
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

    // 12. Write priorities.md
    await writeFile(PRIORITIES_FILE, finalContent + "\n");
    console.log(`[PrioritiesRefresh] Updated priorities.md (${finalContent.split("\n").length} lines, trigger: ${trigger})`);

    // 12.5. Write roadmap.md if the agent produced an update
    if (roadmapUpdate.length > 50 && roadmapUpdate.includes("## M")) {
      try {
        await writeFile(ROADMAP_FILE, roadmapUpdate + "\n");
        console.log(`[PrioritiesRefresh] Updated roadmap.md (${roadmapUpdate.split("\n").length} lines)`);
      } catch (err: any) {
        console.error(`[PrioritiesRefresh] Roadmap write failed: ${err.message}`);
      }
    } else if (roadmapUpdate) {
      console.log(`[PrioritiesRefresh] Roadmap update skipped — output too short or malformed`);
    }

    // 13. Sync [BLOCKED] items from priorities to backlog
    try {
      await syncBlockedItemsToBacklog(finalContent);
    } catch (err: any) {
      console.error(`[PrioritiesRefresh] Blocked item sync failed: ${err.message}`);
    }

    return { ok: true, priorities: finalContent, trigger, duration: result.duration };
  } catch (err: any) {
    console.error(`[PrioritiesRefresh] Agent call failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Parse [BLOCKED] items from priorities.md and move matching backlog items
 * to the blocked lane with a structured reason.
 */
async function syncBlockedItemsToBacklog(prioritiesContent: string) {
  // Parse blocked items: look for "## N) [BLOCKED] Title" headers
  // followed by "- Blocked on ..." or "- BLOCKED (...)" reason lines
  const blockedItems: Array<{ title: string; reason: string }> = [];
  const lines = prioritiesContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^##\s*\d+\)\s*(.+?)\s*\[BLOCKED\]\s*$/i)
      || lines[i].match(/^##\s*\d+\)\s*\[BLOCKED\]\s*(.+)/i);
    if (!headerMatch) continue;

    const title = headerMatch[1].trim();
    // Look for "Blocked on" / "BLOCKED (" reason in the next few lines
    let reason = "Requires operator intervention";
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const reasonMatch = lines[j].match(/^\s*-\s*Blocked on[^:]*:\s*(.+)/i)
        || lines[j].match(/^\s*-?\s*Blocked:\s*(.+)/i)
        || lines[j].match(/^\s*-\s*BLOCKED\s*\([^)]*\):\s*(.+)/i);
      if (reasonMatch) {
        reason = reasonMatch[1].trim();
        break;
      }
      // Stop scanning if we hit the next section
      if (lines[j].startsWith("## ") || lines[j].startsWith("# ")) break;
    }
    blockedItems.push({ title, reason });
  }

  if (blockedItems.length === 0) return;

  // Load all backlog items across ALL lanes (including done — items may have
  // been prematurely completed when the infrastructure was built but the
  // operator action hasn't happened yet).
  const lanes = await loadBacklog();
  const activeCandidates: Array<{ id: string; title: string; lane: string }> = [];
  const doneCandidates: Array<{ id: string; title: string; lane: string }> = [];
  for (const lane of ["triage", "backlog", "queued", "inProgress"]) {
    for (const item of ((lanes as any)[lane] || [])) {
      activeCandidates.push({ id: item.id, title: item.title, lane });
    }
  }
  for (const item of ((lanes as any).done || [])) {
    doneCandidates.push({ id: item.id, title: item.title, lane: "done" });
  }
  // Also check already-blocked items so we don't create duplicates
  const blockedCandidates: Array<{ id: string; title: string; lane: string }> = [];
  for (const item of ((lanes as any).blocked || [])) {
    blockedCandidates.push({ id: item.id, title: item.title, lane: "blocked" });
  }

  for (const blocked of blockedItems) {
    // 1. Already in blocked lane? Skip.
    const alreadyBlocked = findBestMatch(blocked.title, blockedCandidates);
    if (alreadyBlocked) {
      continue;
    }

    // 2. Match in active lanes? Move to blocked.
    const activeMatch = findBestMatch(blocked.title, activeCandidates);
    if (activeMatch) {
      const moved = await blockItemById(activeMatch.id, blocked.reason);
      if (moved) {
        console.log(`[PrioritiesRefresh] Synced blocked: "${activeMatch.title}" → blocked lane (reason: ${blocked.reason})`);
        const idx = activeCandidates.indexOf(activeMatch);
        if (idx !== -1) activeCandidates.splice(idx, 1);
      }
      continue;
    }

    // 3. Match in done lane? Move back to blocked (prematurely completed).
    const doneMatch = findBestMatch(blocked.title, doneCandidates);
    if (doneMatch) {
      const moved = await blockItemById(doneMatch.id, blocked.reason);
      if (moved) {
        console.log(`[PrioritiesRefresh] Reopened done item as blocked: "${doneMatch.title}" (reason: ${blocked.reason})`);
        const idx = doneCandidates.indexOf(doneMatch);
        if (idx !== -1) doneCandidates.splice(idx, 1);
      }
      continue;
    }

    // 4. No match anywhere — create a new blocked item.
    const result = await addItem({
      title: blocked.title,
      source: "priorities-sync",
      category: "operator-blocked",
      description: `Blocked: ${blocked.reason}`,
      lane: "blocked",
    });
    if (result.added) {
      console.log(`[PrioritiesRefresh] Created blocked item: "${blocked.title}" (${result.id}, reason: ${blocked.reason})`);
      // Also set the blocked metadata
      await blockItemById(result.id, blocked.reason);
    }
  }
}

/**
 * Score how well two titles match using normalized word overlap.
 * Returns the best-matching candidate if above threshold, or null.
 */
function findBestMatch(
  blockedTitle: string,
  candidates: Array<{ id: string; title: string; lane: string }>,
): { id: string; title: string; lane: string } | null {
  const blockedWords = new Set(
    blockedTitle.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2),
  );
  if (blockedWords.size === 0) return null;

  let bestScore = 0;
  let bestMatch: (typeof candidates)[number] | null = null;

  for (const candidate of candidates) {
    const candidateWords = new Set(
      candidate.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2),
    );

    // Count words in common
    let overlap = 0;
    for (const word of blockedWords) {
      if (candidateWords.has(word)) overlap++;
    }

    // Score: overlap / max(size of either set) — penalizes wildly different lengths
    const score = overlap / Math.max(blockedWords.size, candidateWords.size);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  // Require at least 40% word overlap to avoid false positives
  return bestScore >= 0.4 ? bestMatch : null;
}
