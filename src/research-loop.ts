/**
 * Research Loop
 *
 * Runs a research cycle: 3 parallel researchers → strategist synthesis → auto-queue.
 * Produces a ranked opportunity report without making any code changes.
 *
 * Flow:
 * 1. Load project goals and app metrics
 * 2. Ground the target project
 * 3. Run domain, technical, and market researchers in parallel
 * 4. Strategist synthesizes into ranked opportunity report
 * 5. High-confidence items auto-queue for execution
 * 6. Store report in Redis
 * 7. Notify operator
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { groundProject, summarizeForPrompt } from "./grounding.ts";
import { loadProjectGoals, summarizeGoalsForPrompt, loadAppMetrics } from "./project-goals.ts";
import { analyzeCodebase, formatStateForPrompt } from "./codebase-analyzer.ts";
import { getTracker } from "./task-tracker.ts";
import { getCumulativeAccomplishments, getMetricsTrend } from "./metrics.ts";
import { STREAMS } from "./event-bus.ts";
import { addToBacklog } from "./backlog.ts";
import { createSpec } from "./specs.ts";

import Redis from "ioredis";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");
const METHODOLOGY_DIR = join(CONFIG_PATH, "research");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const RESEARCH_INDEX_KEY = "hydra:reports:research:index";
const researchKey = (id) => `hydra:reports:research:${id}`;
let _researchRedis = null;
function getResearchRedis() {
  if (!_researchRedis) _researchRedis = new Redis(REDIS_URL);
  return _researchRedis;
}

function generateResearchId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `research-${date}-${hour}${min}`;
}

/**
 * Load methodology overrides written by the Research Architect.
 * These are appended to researcher prompts to improve quality over time.
 */
async function loadMethodologyOverrides(researcherName) {
  try {
    const content = await readFile(join(METHODOLOGY_DIR, `${researcherName}.md`), "utf-8");
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Load the most recent research report for continuity.
 */
async function loadLastResearchReport() {
  try {
    const r = getResearchRedis();
    const ids = await r.zrevrange(RESEARCH_INDEX_KEY, 0, 0);
    if (ids.length === 0) return null;
    const raw = await r.get(researchKey(ids[0]));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Score outcomes of the previous research cycle's recommendations.
 * Checks what happened to each item: merged, failed, abandoned, still-queued.
 * Returns a formatted scorecard for the Director to learn from.
 */
async function scoreLastResearchOutcomes(): Promise<string> {
  try {
    const lastReport = await loadLastResearchReport();
    if (!lastReport?.synthesis?.opportunities) return "";

    const titles = (lastReport.synthesis.opportunities as any[]).map(o => o.title);
    if (titles.length === 0) return "";

    // Check metrics for matching task titles
    const trend = await getMetricsTrend(50);
    const merged: string[] = [];
    const failed: string[] = [];
    const abandoned: string[] = [];
    const stillQueued: string[] = [];

    for (const title of titles) {
      const titleLower = title.toLowerCase();
      const match = trend.find(m => {
        const taskTitle = (m.taskTitle || "").toLowerCase();
        // Fuzzy match: check if significant words overlap
        const titleWords = new Set(titleLower.split(/\s+/).filter((w: string) => w.length > 3));
        const taskWords = new Set(taskTitle.split(/\s+/).filter((w: string) => w.length > 3));
        if (titleWords.size === 0 || taskWords.size === 0) return false;
        const overlap = [...titleWords].filter((w: string) => taskWords.has(w)).length;
        return overlap / Math.max(titleWords.size, taskWords.size) > 0.5;
      });

      if (match) {
        if (parseInt(match.tasksMerged as string) > 0) merged.push(title);
        else if (parseInt(match.tasksFailed as string) > 0) failed.push(title);
        else if (parseInt(match.tasksAbandoned as string) > 0) abandoned.push(title);
      } else {
        stillQueued.push(title);
      }
    }

    const total = titles.length;
    const mergeRate = total > 0 ? Math.round((merged.length / total) * 100) : 0;

    const lines = [
      `## PREVIOUS RESEARCH OUTCOMES (learn from these)`,
      `Research cycle ${lastReport.researchId} produced ${total} items. Merge rate: ${mergeRate}%`,
    ];

    if (merged.length > 0) {
      lines.push(`\nMerged (${merged.length} — these were GOOD suggestions):`);
      for (const t of merged.slice(0, 5)) lines.push(`  + ${t}`);
    }
    if (failed.length > 0) {
      lines.push(`\nFailed (${failed.length} — these were POORLY SCOPED, avoid similar):`);
      for (const t of failed) lines.push(`  - ${t}`);
    }
    if (abandoned.length > 0) {
      lines.push(`\nAbandoned (${abandoned.length} — skeptic rejected, NOT ACTIONABLE):`);
      for (const t of abandoned) lines.push(`  - ${t}`);
    }
    if (stillQueued.length > 0) {
      lines.push(`\nStill queued (${stillQueued.length} — not yet attempted):`);
      for (const t of stillQueued.slice(0, 3)) lines.push(`  ? ${t}`);
    }

    if (mergeRate < 50 && total >= 3) {
      lines.push(`\nWARNING: Less than half of last research suggestions merged. Improve suggestion quality by:`);
      lines.push(`- Making items more specific and bounded (single file or module)`);
      lines.push(`- Aligning more tightly with the operator vision's decision vectors`);
      lines.push(`- Avoiding broad multi-file proposals that the executor struggles to complete`);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Parse JSON from agent output, handling markdown fences and JSON lines.
 */
function parseAgentJson(output) {
  // Try direct parse
  try { return JSON.parse(output); } catch {}

  // Try extracting from markdown fences
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  // Try extracting the largest JSON object
  const match = output.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Individual researcher runners
// ---------------------------------------------------------------------------

async function runDomainResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport, codebaseState = "", journal = "") {
  const methodology = await loadMethodologyOverrides("domain-researcher");

  const prompt = [
    goalsPrompt,
    "",
    groundingSummary.slice(0, 3000),
    "",
    codebaseState ? `${codebaseState}\n` : "",
    accomplishments ? `## Already Accomplished (do not re-recommend)\n${accomplishments}\n` : "",
    lastReport?.domainResearch ? `## Previous Domain Research Findings (build on these, don't repeat)\n${JSON.stringify(lastReport.domainResearch).slice(0, 2000)}\n` : "",
    journal ? `## Research Journal (areas already explored — go DEEPER on promising leads, AVOID recently explored areas, EXPLORE new frontiers)\n${journal.slice(0, 2000)}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    "## Instructions",
    "Research the problem domain described in the project goals above.",
    "Use web search to find current strategies, best practices, and competitive intelligence.",
    "Focus on finding NEW FEATURES and CAPABILITIES to build — not defensive hardening.",
    "Focus your research on areas aligned with the focus weights.",
    "Consult the Research Journal above: deepen promising leads, avoid areas on cooldown, explore new frontiers.",
    "Output ONLY valid JSON as specified in your personality file.",
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "domain-researcher.md");
  const result: any = await runAgent({
    agentName: "domain-researcher",
    personality,
    prompt,
    model: "frontier",
    taskId: "domain-research",
    correlationId: researchId,
  });

  return { raw: result, parsed: parseAgentJson(result.output), costUsd: (result as any).costUsd, duration: (result as any).duration };
}

async function runTechnicalResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport, codebaseState = "", journal = "") {
  const methodology = await loadMethodologyOverrides("technical-researcher");

  const prompt = [
    goalsPrompt,
    "",
    groundingSummary, // Full grounding for technical researcher
    "",
    accomplishments ? `## Already Accomplished\n${accomplishments}\n` : "",
    lastReport?.technicalResearch ? `## Previous Technical Findings (note what changed)\n${JSON.stringify(lastReport.technicalResearch).slice(0, 2000)}\n` : "",
    journal ? `## Research Journal (areas already explored — go DEEPER on promising leads, EXPLORE new technical frontiers)\n${journal.slice(0, 2000)}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    "## Instructions",
    "Analyze the target project's codebase thoroughly.",
    "The grounding report above shows real test results, file structure, and git state.",
    "Assess architecture fitness, tech debt, reliability gaps, and test coverage against the project goals.",
    "Focus your analysis on areas aligned with the focus weights.",
    "Consult the Research Journal above: deepen promising technical leads, explore new frontiers.",
    "You may use web search to research best practices for the technologies in use.",
    "Output ONLY valid JSON as specified in your personality file.",
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "technical-researcher.md");
  const result: any = await runAgent({
    agentName: "technical-researcher",
    personality,
    prompt,
    model: "frontier",
    taskId: "technical-research",
    correlationId: researchId,
    workDir: PROJECT_WORKSPACE, // Give technical researcher access to the codebase
  });

  return { raw: result, parsed: parseAgentJson((result as any).output), costUsd: (result as any).costUsd, duration: (result as any).duration };
}

async function runMarketResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport, codebaseState = "", journal = "") {
  const methodology = await loadMethodologyOverrides("market-researcher");

  const prompt = [
    goalsPrompt,
    "",
    groundingSummary.slice(0, 2000),
    "",
    lastReport?.marketResearch ? `## Previous Market Research (check for changes)\n${JSON.stringify(lastReport.marketResearch).slice(0, 2000)}\n` : "",
    journal ? `## Research Journal (areas already explored — investigate NEW market developments, avoid re-researching recent findings)\n${journal.slice(0, 2000)}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    "## Instructions",
    "Research the external landscape for the project described in the goals above.",
    "Use web search to find current API documentation, platform changes, market conditions, and new opportunities.",
    "Focus on platforms and integrations relevant to the project goals.",
    "Check for recent API changes, deprecations, new endpoints, and rate limit updates.",
    "Consult the Research Journal above: investigate new market developments, avoid areas recently covered.",
    "Output ONLY valid JSON as specified in your personality file.",
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "market-researcher.md");
      const result: any = await runAgent({
    agentName: "market-researcher",
    personality,
    prompt,
    model: "frontier",
    taskId: "market-research",
    correlationId: researchId,
  });

  return { raw: result, parsed: parseAgentJson((result as any).output), costUsd: (result as any).costUsd, duration: (result as any).duration };
}

// ---------------------------------------------------------------------------
// Strategist synthesis
// ---------------------------------------------------------------------------

async function runStrategistSynthesis(researchId, goals, goalsPrompt, domainFindings, technicalFindings, marketFindings, appMetrics, accomplishments) {
  const methodology = await loadMethodologyOverrides("research-strategist");

  const prompt = [
    goalsPrompt,
    "",
    "## Domain Research Findings",
    JSON.stringify(domainFindings || { error: "Domain researcher produced no output" }, null, 2).slice(0, 4000),
    "",
    "## Technical Research Findings",
    JSON.stringify(technicalFindings || { error: "Technical researcher produced no output" }, null, 2).slice(0, 4000),
    "",
    "## Market Research Findings",
    JSON.stringify(marketFindings || { error: "Market researcher produced no output" }, null, 2).slice(0, 4000),
    "",
    appMetrics ? `## Current App Metrics\n${JSON.stringify(appMetrics.data, null, 2).slice(0, 2000)}\n` : "",
    accomplishments ? `## Already Accomplished (do not re-recommend)\n${accomplishments}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    `## Instructions`,
    `Research cycle ID: ${researchId}`,
    `Synthesize the three research streams above into a single ranked opportunity report.`,
    `Score each opportunity against the focus weights in the project goals.`,
    `Use the scoring formula from your personality: weighted impact * confidence * complexity adjustments.`,
    `Mark opportunities as autoQueue: true if they meet the auto-queue threshold.`,
    `Output ONLY valid JSON as specified in your personality file.`,
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "research-strategist.md");
      const result: any = await runAgent({
    agentName: "research-strategist",
    personality,
    prompt,
    model: "frontier",
    taskId: "research-synthesis",
    correlationId: researchId,
  });

  return { raw: result, parsed: parseAgentJson((result as any).output), costUsd: (result as any).costUsd, duration: (result as any).duration };
}

// ---------------------------------------------------------------------------
// Main research loop
// ---------------------------------------------------------------------------

/**
 * Run a full research cycle.
 *
 * @param {EventBus} eventBus
 * @param {object} opts - { focusOverride?: object }
 * @returns {ResearchReport}
 */
export async function runResearchLoop(eventBus,  opts: Record<string, any> = {}) {
  const researchId = generateResearchId();
  const startTime = Date.now();
  console.log(`[Research] Starting research cycle ${researchId}`);

  // Step 1: Load project goals
  const goals = await loadProjectGoals();
  if (!goals) {
    console.error("[Research] No project goals found — create config/direction/goals.md");
    return { error: "No project goals document found", researchId };
  }

  // Apply focus weight override if provided
  if (opts.focusOverride && typeof opts.focusOverride === "object") {
    Object.assign(goals.weights, opts.focusOverride);
  }

  const goalsPrompt = summarizeGoalsForPrompt(goals);
  console.log(`[Research] Loaded goals: ${goals.name} (${goals.metrics.length} metrics, ${Object.keys(goals.weights).length} weights)`);

  // Step 2: Ground the project
  console.log("[Research] Grounding project...");
  const grounding = await groundProject(PROJECT_WORKSPACE);
  const groundingSummary = summarizeForPrompt(grounding);
  console.log(`[Research] Grounded: ${grounding.testReport.passed} tests passing, ${grounding.fileCount} files`);

  // Step 2.5: Analyze codebase structure
  console.log("[Research] Analyzing codebase...");
  const codebaseState = await analyzeCodebase(PROJECT_WORKSPACE);
  const codebasePrompt = formatStateForPrompt(codebaseState);
  console.log(`[Research] Codebase analyzed: ${codebaseState.apiRoutes.length} routes, ${codebaseState.runners.length} runners, ${codebaseState.gaps.length} gaps`);

  // Step 3: Load operator vision + context
  let vision = "";
  try {
    vision = await readFile(join(CONFIG_PATH, "direction", "vision.md"), "utf-8");
    if (vision) {
          (goals as any).userPriorities = vision; // backward compat for goalsPrompt
      console.log("[Research] Loaded operator vision (vision.md)");
    }
  } catch {
    // Fall back to user-priorities.md if vision.md doesn't exist yet
    try {
      vision = await readFile(join(CONFIG_PATH, "direction", "user-priorities.md"), "utf-8");
          if (vision) (goals as any).userPriorities = vision;
      console.log("[Research] Loaded operator priorities (user-priorities.md fallback)");
    } catch {}
  }

  // Load current roadmap for Director milestone sync
  let roadmapContent = "";
  try {
    roadmapContent = await readFile(join(CONFIG_PATH, "direction", "roadmap.md"), "utf-8");
    console.log("[Research] Loaded roadmap.md for Director context");
  } catch { /* no roadmap file is fine */ }

  // Load research journal — persistent memory of what's been explored
  let journalContent = "";
  try {
    journalContent = await readFile(join(CONFIG_PATH, "direction", "research-journal.md"), "utf-8");
    console.log("[Research] Loaded research-journal.md");
  } catch { /* no journal file is fine — first run */ }

  const [appMetrics, lastReport, accomplishmentsRaw, researchScorecard] = await Promise.all([
    loadAppMetrics(),
    loadLastResearchReport(),
    getCumulativeAccomplishments(20),
    scoreLastResearchOutcomes(),
  ]);

  const accomplishments = accomplishmentsRaw.length > 0
    ? accomplishmentsRaw.map(a => `- "${a.title}"`).join("\n")
    : "";

  if (appMetrics) {
    console.log(`[Research] Loaded app metrics from ${appMetrics.source}`);
  }

  // Step 4: Run three researchers in parallel
  console.log("[Research] Running domain, technical, and market researchers in parallel...");
  const [domainResult, technicalResult, marketResult] = await Promise.all([
    runDomainResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport, codebasePrompt, journalContent),
    runTechnicalResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport, codebasePrompt, journalContent),
    runMarketResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport, codebasePrompt, journalContent),
  ]);

  const researchDuration = Date.now() - startTime;
  console.log(`[Research] All researchers complete (${Math.round(researchDuration / 1000)}s)`);
  console.log(`[Research] Domain: ${domainResult.parsed ? "OK" : "FAILED TO PARSE"} (${domainResult.duration}ms)`);
  console.log(`[Research] Technical: ${technicalResult.parsed ? "OK" : "FAILED TO PARSE"} (${technicalResult.duration}ms)`);
  console.log(`[Research] Market: ${marketResult.parsed ? "OK" : "FAILED TO PARSE"} (${marketResult.duration}ms)`);

  // Step 5: Director synthesis — replaces the old strategist.
  // The Director reads vision + codebase state + all research and produces
  // both a ranked opportunity list AND the complete priorities.md content.
  console.log("[Research] Director synthesizing vision + codebase state + research...");

  const directorPrompt = [
    `## OPERATOR VISION`,
    vision.slice(0, 2000),
    "",
    codebasePrompt,
    "",
    `## DOMAIN RESEARCH FINDINGS`,
    JSON.stringify(domainResult.parsed || { error: "No output" }, null, 2).slice(0, 4000),
    "",
    `## TECHNICAL RESEARCH FINDINGS`,
    JSON.stringify(technicalResult.parsed || { error: "No output" }, null, 2).slice(0, 4000),
    "",
    `## MARKET RESEARCH FINDINGS`,
    JSON.stringify(marketResult.parsed || { error: "No output" }, null, 2).slice(0, 4000),
    "",
    appMetrics ? `## APP METRICS\n${JSON.stringify(appMetrics.data, null, 2).slice(0, 2000)}\n` : "",
    accomplishments ? `## ALREADY ACCOMPLISHED (do NOT re-recommend)\n${accomplishments}\n` : "",
    researchScorecard || "",
    "",
    roadmapContent ? `## CURRENT ROADMAP (milestone tracking)\n${roadmapContent.slice(0, 3000)}\n` : "",
    journalContent ? `## RESEARCH JOURNAL (what's been explored — update this)\n${journalContent.slice(0, 2000)}\n` : "",
    `## INSTRUCTIONS`,
    `Research cycle ID: ${researchId}`,
    `Synthesize the operator vision, codebase state, and all three research streams.`,
    `Produce a JSON object with:`,
    `1. "priorities" — the COMPLETE markdown content for priorities.md (as a raw string, NOT a description of what you did)`,
    `2. "opportunities" — ranked feature opportunities with title, description, category, impact, feasibility, alignmentScore, reasoning, autoQueue`,
    `3. "summary" — one paragraph synthesis`,
    `4. "researchHighlights" — notable findings from this research cycle`,
    roadmapContent ? `5. "roadmap" — the COMPLETE updated roadmap.md content. Check off epics that match accomplished work (- [ ] → - [x]). Mark milestones status: complete with completed: YYYY-MM-DD when ALL epics are done. Advance next planned milestone to status: active with started: YYYY-MM-DD. Mark blocked epics as - [-]. Preserve the exact format.` : "",
    `6. "journalUpdate" — the COMPLETE updated research-journal.md content. Update it by:`,
    `   - Moving areas you researched THIS cycle into "Explored Areas" with today's date, depth level (surface/moderate/deep), key findings, and a cooldown date (7 days for surface, 14 for moderate, 30 for deep)`,
    `   - Moving promising findings that need deeper investigation into "Promising Leads"`,
    `   - Adding any new ideas discovered during research to "Unexplored Frontiers"`,
    `   - Removing items from "Unexplored Frontiers" that were explored this cycle`,
    `   - Keep the markdown format with section headers and bullet points`,
    ``,
    `CRITICAL: The "priorities" field must contain the ACTUAL markdown content that the planner will read.`,
    `It must start with "# Current state" and list numbered priority tasks.`,
    `Do NOT write a description of what you did. Write the actual file content.`,
    ``,
    `Output ONLY valid JSON. No code fences.`,
  ].filter(Boolean).join("\n");

  const directorPersonality = join(CONFIG_PATH, "research", "director.md");
      const synthesisResult = await runAgent({
    agentName: "director",
    personality: directorPersonality,
    prompt: directorPrompt,
    model: "frontier",
    taskId: "director-synthesis",
    correlationId: researchId,
  });
  console.log(`[Research] Director: ${(synthesisResult as any).output ? "OK" : "EMPTY"} (${(synthesisResult as any).duration}ms)`);

  const synthesis = parseAgentJson((synthesisResult as any).output);

  // Write priorities.md from Director output
  let prioritiesRefreshed = false;
  if (synthesis?.priorities && typeof synthesis.priorities === "string" && synthesis.priorities.length > 50) {
    try {
      let content = synthesis.priorities.trim();
      if (content.startsWith("```")) {
        content = content.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      }

      // Validate it looks like actual priorities content, not meta-commentary
      if (content.includes("# Current state") || content.includes("# Priority") || content.includes("## 1.")) {
        const date = new Date().toISOString().split("T")[0];
        const header = content.startsWith("---") ? "" : [
          `---`,
          `updated: ${date}`,
          `refreshedBy: director`,
          `researchCycle: ${researchId}`,
          `tags: [hydra, hydra/direction]`,
          `---`,
          ``,
        ].join("\n");
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(CONFIG_PATH, "direction", "priorities.md"), header + content + "\n");
        prioritiesRefreshed = true;
        console.log(`[Research] Priorities written by Director (${content.split("\n").length} lines)`);
      } else {
        console.error("[Research] Director output looks like meta-commentary, not priorities content — skipping write");
      }
    } catch (err: any) {
      console.error(`[Research] Priorities write failed: ${err.message}`);
    }
  } else {
    console.error("[Research] Director did not produce priorities content — skipping write");
  }

  // Write roadmap.md from Director output
  if (synthesis?.roadmap && typeof synthesis.roadmap === "string" && synthesis.roadmap.length > 50) {
    try {
      let rmContent = synthesis.roadmap.trim();
      if (rmContent.startsWith("```")) {
        rmContent = rmContent.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      }
      if (rmContent.includes("## M")) {
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(CONFIG_PATH, "direction", "roadmap.md"), rmContent + "\n");
        console.log(`[Research] Roadmap updated by Director (${rmContent.split("\n").length} lines)`);
      } else {
        console.log("[Research] Director roadmap output malformed — skipping write");
      }
    } catch (err: any) {
      console.error(`[Research] Roadmap write failed: ${err.message}`);
    }
  }

  // Write research-journal.md from Director output
  if (synthesis?.journalUpdate && typeof synthesis.journalUpdate === "string" && synthesis.journalUpdate.length > 50) {
    try {
      let jContent = synthesis.journalUpdate.trim();
      if (jContent.startsWith("```")) {
        jContent = jContent.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      }
      if (jContent.includes("# Research Journal") || jContent.includes("## Explored") || jContent.includes("## Promising")) {
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(CONFIG_PATH, "direction", "research-journal.md"), jContent + "\n");
        console.log(`[Research] Journal updated by Director (${jContent.split("\n").length} lines)`);
      } else {
        console.log("[Research] Director journal output malformed — skipping write");
      }
    } catch (err: any) {
      console.error(`[Research] Journal write failed: ${err.message}`);
    }
  }

  const totalDuration = Date.now() - startTime;
  const totalCost = (domainResult.costUsd || 0) + (technicalResult.costUsd || 0) +
                        (marketResult.costUsd || 0) + ((synthesisResult as any).costUsd || 0);
      const directorCost = (synthesisResult as any).costUsd || 0;

  // Step 6: Route opportunities per the kanban-scope decision (2026-04-08).
  //
  // Research-auto-queued items (opp.autoQueue === true) go DIRECTLY to the
  // Redis work queue and skip the Kanban entirely. Research-suggested items
  // (opp.autoQueue === false) go to the Kanban ## Backlog lane where an
  // operator can review and promote them.
  //
  // This eliminates the double-write drift that caused the 2026-04-08 stale-
  // Kanban incident. See: hydra/reports/decisions/kanban-scope.md.
  let autoQueued = 0;
  if (synthesis?.opportunities) {
    for (const opp of synthesis.opportunities) {
      if (!opp.autoQueue) {
        // Not auto-queued — surface in Triage for operator review before entering backlog.
        const descParts = [];
        if (opp.rationale) descParts.push(`## Rationale\n${opp.rationale}`);
        if (opp.acceptanceCriteria) {
          const criteria = Array.isArray(opp.acceptanceCriteria)
            ? opp.acceptanceCriteria.map(c => `- [ ] ${c}`).join("\n")
            : opp.acceptanceCriteria;
          descParts.push(`## Acceptance Criteria\n${criteria}`);
        }
        if (opp.prerequisites?.length > 0) descParts.push(`## Prerequisites\n${opp.prerequisites.map(p => `- ${p}`).join("\n")}`);

        const complexityToEstimate = { trivial: 1, low: 2, medium: 3, high: 5, extreme: 8 };

        await addToBacklog({
          title: opp.title,
          category: opp.category,
          source: "research",
          adjustedScore: opp.adjustedScore,
          confidence: opp.confidence,
          complexity: opp.complexity,
          lane: "triage",
          description: descParts.join("\n\n"),
          labels: [opp.category].filter(Boolean),
          estimate: complexityToEstimate[opp.complexity?.toLowerCase()] ?? null,
        });
        continue;
      }

      // Auto-queued — route based on complexity.
      // Complex opportunities (estimatedCycles > 2 or 3+ acceptance criteria)
      // become persistent specs with decomposed tasks. Simple ones go directly
      // to the work queue as before.
      const criteria = Array.isArray(opp.acceptanceCriteria) ? opp.acceptanceCriteria : [];
      const isComplex = (opp.estimatedCycles > 2) || (criteria.length >= 3);

      if (isComplex && criteria.length >= 2) {
        // Create a persistent spec — tasks are the acceptance criteria
        try {
          const spec = await createSpec({
            title: opp.title,
            rationale: opp.rationale || opp.description || "",
            source: "research",
            sourceId: researchId,
            tasks: criteria.map((c) => ({
              title: typeof c === "string" ? c : String(c),
            })),
          });
          if (spec) {
            autoQueued++;
            console.log(`[Research] Created spec for #${opp.rank}: "${opp.title}" (${criteria.length} tasks, est. ${opp.estimatedCycles} cycles)`);
            continue;
          }
        } catch (err: any) {
          console.error(`[Research] Failed to create spec for "${opp.title}": ${err.message} — falling back to work queue`);
        }
      }

      // Simple opportunity or spec creation failed — push to work queue
      {
        await getTracker().redis.rpush("hydra:anchors:work-queue", JSON.stringify({
          reference: opp.title,
          reason: `Research ${researchId}: ${opp.rationale?.slice(0, 200) || "auto-queued from research"}`,
          context: JSON.stringify({
            researchId,
            rank: opp.rank,
            adjustedScore: opp.adjustedScore,
            confidence: opp.confidence,
            category: opp.category,
            complexity: opp.complexity,
            description: opp.description,
            rationale: opp.rationale,
            acceptanceCriteria: opp.acceptanceCriteria,
            prerequisites: opp.prerequisites,
            estimatedCycles: opp.estimatedCycles,
            sources: opp.sources,
          }),
          queuedAt: new Date().toISOString(),
          source: "research",
        }));
        autoQueued++;
        console.log(`[Research] Auto-queued #${opp.rank}: "${opp.title}" (score: ${opp.adjustedScore}, confidence: ${opp.confidence})`);
      }
    }
  }

  // Step 7: Build and store the full report
  const report = {
    researchId,
    projectName: goals.name,
    timestamp: new Date().toISOString(),
    duration: {
      totalMs: totalDuration,
      totalHuman: `${Math.round(totalDuration / 1000)}s`,
      domainMs: domainResult.duration,
      technicalMs: technicalResult.duration,
      marketMs: marketResult.duration,
          directorMs: (synthesisResult as any).duration,
    },
    cost: {
      totalUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
      domain: domainResult.costUsd || 0,
      technical: technicalResult.costUsd || 0,
      market: marketResult.costUsd || 0,
      director: directorCost,
    },
    goals: {
      name: goals.name,
      weights: goals.weights,
      metricsCount: goals.metrics.length,
      constraintsCount: goals.constraints.length,
    },
    grounding: {
      testsPassing: grounding.testReport.passed,
      testsFailing: grounding.testReport.failed,
      typecheckClean: grounding.typecheckReport.exitCode === 0,
      fileCount: grounding.fileCount,
      todoCount: grounding.todoMarkers?.length || 0,
    },
    appMetrics: appMetrics ? { source: appMetrics.source, available: true } : { available: false },
    domainResearch: domainResult.parsed,
    technicalResearch: technicalResult.parsed,
    marketResearch: marketResult.parsed,
    synthesis,
    autoQueued,
    prioritiesRefreshed,
    opportunityCount: synthesis?.opportunities?.length || 0,
    generatedTitles: (synthesis?.opportunities || []).map((o: any) => o.title),
  };

  // Write report to Redis
  const rr = getResearchRedis();
  await rr.set(researchKey(researchId), JSON.stringify(report));
  await rr.zadd(RESEARCH_INDEX_KEY, Date.now(), researchId);
  // Keep 20 most recent
  const rCount = await rr.zcard(RESEARCH_INDEX_KEY);
  if (rCount > 20) {
    const old = await rr.zrange(RESEARCH_INDEX_KEY, 0, rCount - 21);
    for (const id of old) {
      await rr.del(researchKey(id));
      await rr.zrem(RESEARCH_INDEX_KEY, id);
    }
  }
  console.log(`[Research] Report saved to Redis: ${researchId}`);

  // Step 8: Notify operator
  if (eventBus) {
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "research:completed",
      source: "research-loop",
      correlationId: researchId,
      payload: {
        researchId,
        projectName: goals.name,
        opportunityCount: report.opportunityCount,
        autoQueued,
        topOpportunities: (synthesis?.opportunities || []).slice(0, 5).map(o =>
          `#${o.rank}: ${o.title} (score: ${o.adjustedScore}, ${o.confidence} confidence)`
        ),
        summary: synthesis?.summary || "Research complete",
        duration: report.duration.totalHuman,
        cost: `$${report.cost.totalUsd.toFixed(4)}`,
      },
    });
  }

  console.log(`[Research] Cycle ${researchId} complete — ${report.opportunityCount} opportunities, ${autoQueued} auto-queued (${report.duration.totalHuman}, $${report.cost.totalUsd.toFixed(4)})`);
  return report;
}

/**
 * Get the most recent research report.
 */
export async function getLatestResearch() {
  return loadLastResearchReport();
}

/**
 * List recent research reports (metadata only).
 */
export async function listResearchReports(count = 10) {
  try {
    const r = getResearchRedis();
    const ids = await r.zrevrange(RESEARCH_INDEX_KEY, 0, count - 1);
    const reports = [];
    for (const id of ids) {
      const raw = await r.get(researchKey(id));
      if (raw) {
        const report = JSON.parse(raw);
        reports.push({
          researchId: report.researchId,
          timestamp: report.timestamp,
          projectName: report.projectName,
          opportunityCount: report.opportunityCount,
          autoQueued: report.autoQueued,
          summary: report.synthesis?.summary,
          duration: report.duration?.totalHuman,
          cost: report.cost?.totalUsd,
        });
      }
    }
    return reports;
  } catch {
    return [];
  }
}

/**
 * Veto (remove from queue) a research-recommended item.
 */
export async function vetoOpportunity(title) {
  const tracker = getTracker();
  const items = await tracker.redis.lrange("hydra:anchors:work-queue", 0, -1);
  let removed = 0;

  for (let i = items.length - 1; i >= 0; i--) {
    try {
      const item = JSON.parse(items[i]);
      if (item.reference === title && item.source === "research") {
        await tracker.redis.lrem("hydra:anchors:work-queue", 1, items[i]);
        removed++;
      }
    } catch {}
  }

  return { vetoed: removed > 0, title, removed };
}
