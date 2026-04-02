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
 * 6. Store report in vault
 * 7. Notify operator
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent, findPersonality } from "./codex-runner.mjs";
import { groundProject, summarizeForPrompt } from "./grounding.mjs";
import { loadProjectGoals, summarizeGoalsForPrompt, loadAppMetrics } from "./project-goals.mjs";
import { getTracker } from "./task-tracker.mjs";
import { getCumulativeAccomplishments } from "./metrics.mjs";
import { sendNotification } from "./notify.mjs";
import { STREAMS } from "./event-bus.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");
const RESEARCH_DIR = join(HYDRA_PATH, "reports", "research");
const METHODOLOGY_DIR = join(HYDRA_PATH, "research-methodology");

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
    const files = (await readdir(RESEARCH_DIR))
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const content = await readFile(join(RESEARCH_DIR, files[0]), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
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

async function runDomainResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport) {
  const methodology = await loadMethodologyOverrides("domain-researcher");

  const prompt = [
    goalsPrompt,
    "",
    groundingSummary.slice(0, 3000),
    "",
    accomplishments ? `## Already Accomplished (do not re-recommend)\n${accomplishments}\n` : "",
    lastReport?.domainResearch ? `## Previous Domain Research Findings (build on these, don't repeat)\n${JSON.stringify(lastReport.domainResearch).slice(0, 2000)}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    "## Instructions",
    "Research the problem domain described in the project goals above.",
    "Use web search to find current strategies, best practices, and competitive intelligence.",
    "Focus your research on areas aligned with the focus weights.",
    "Output ONLY valid JSON as specified in your personality file.",
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "domain-researcher.md");
  const result = await runAgent({
    agentName: "domain-researcher",
    personality,
    prompt,
    model: "frontier",
    taskId: "domain-research",
    correlationId: researchId,
  });

  return { raw: result, parsed: parseAgentJson(result.output), costUsd: result.costUsd, duration: result.duration };
}

async function runTechnicalResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport) {
  const methodology = await loadMethodologyOverrides("technical-researcher");

  const prompt = [
    goalsPrompt,
    "",
    groundingSummary, // Full grounding for technical researcher
    "",
    accomplishments ? `## Already Accomplished\n${accomplishments}\n` : "",
    lastReport?.technicalResearch ? `## Previous Technical Findings (note what changed)\n${JSON.stringify(lastReport.technicalResearch).slice(0, 2000)}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    "## Instructions",
    "Analyze the target project's codebase thoroughly.",
    "The grounding report above shows real test results, file structure, and git state.",
    "Assess architecture fitness, tech debt, reliability gaps, and test coverage against the project goals.",
    "Focus your analysis on areas aligned with the focus weights.",
    "You may use web search to research best practices for the technologies in use.",
    "Output ONLY valid JSON as specified in your personality file.",
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "technical-researcher.md");
  const result = await runAgent({
    agentName: "technical-researcher",
    personality,
    prompt,
    model: "frontier",
    taskId: "technical-research",
    correlationId: researchId,
    workDir: PROJECT_WORKSPACE, // Give technical researcher access to the codebase
  });

  return { raw: result, parsed: parseAgentJson(result.output), costUsd: result.costUsd, duration: result.duration };
}

async function runMarketResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport) {
  const methodology = await loadMethodologyOverrides("market-researcher");

  const prompt = [
    goalsPrompt,
    "",
    groundingSummary.slice(0, 2000),
    "",
    lastReport?.marketResearch ? `## Previous Market Research (check for changes)\n${JSON.stringify(lastReport.marketResearch).slice(0, 2000)}\n` : "",
    methodology ? `## Methodology Updates (from Research Architect)\n${methodology}\n` : "",
    "",
    "## Instructions",
    "Research the external landscape for the project described in the goals above.",
    "Use web search to find current API documentation, platform changes, market conditions, and new opportunities.",
    "Focus on platforms and integrations relevant to the project goals.",
    "Check for recent API changes, deprecations, new endpoints, and rate limit updates.",
    "Output ONLY valid JSON as specified in your personality file.",
  ].filter(Boolean).join("\n");

  const personality = join(process.cwd(), "config", "market-researcher.md");
  const result = await runAgent({
    agentName: "market-researcher",
    personality,
    prompt,
    model: "frontier",
    taskId: "market-research",
    correlationId: researchId,
  });

  return { raw: result, parsed: parseAgentJson(result.output), costUsd: result.costUsd, duration: result.duration };
}

// ---------------------------------------------------------------------------
// Strategist synthesis
// ---------------------------------------------------------------------------

async function runStrategistSynthesis(researchId, goals, goalsPrompt, domainFindings, technicalFindings, marketFindings, appMetrics, accomplishments) {
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
  const result = await runAgent({
    agentName: "research-strategist",
    personality,
    prompt,
    model: "frontier",
    taskId: "research-synthesis",
    correlationId: researchId,
  });

  return { raw: result, parsed: parseAgentJson(result.output), costUsd: result.costUsd, duration: result.duration };
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
export async function runResearchLoop(eventBus, opts = {}) {
  const researchId = generateResearchId();
  const startTime = Date.now();
  console.log(`[Research] Starting research cycle ${researchId}`);

  // Step 1: Load project goals
  const goals = await loadProjectGoals();
  if (!goals) {
    console.error("[Research] No project goals found — create direction/goals.md in the vault");
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

  // Step 3: Load context
  const [appMetrics, lastReport, accomplishmentsRaw] = await Promise.all([
    loadAppMetrics(),
    loadLastResearchReport(),
    getCumulativeAccomplishments(20),
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
    runDomainResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport),
    runTechnicalResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport),
    runMarketResearcher(researchId, goals, goalsPrompt, groundingSummary, accomplishments, lastReport),
  ]);

  const researchDuration = Date.now() - startTime;
  console.log(`[Research] All researchers complete (${Math.round(researchDuration / 1000)}s)`);
  console.log(`[Research] Domain: ${domainResult.parsed ? "OK" : "FAILED TO PARSE"} (${domainResult.duration}ms)`);
  console.log(`[Research] Technical: ${technicalResult.parsed ? "OK" : "FAILED TO PARSE"} (${technicalResult.duration}ms)`);
  console.log(`[Research] Market: ${marketResult.parsed ? "OK" : "FAILED TO PARSE"} (${marketResult.duration}ms)`);

  // Step 5: Strategist synthesis
  console.log("[Research] Synthesizing findings...");
  const synthesisResult = await runStrategistSynthesis(
    researchId, goals, goalsPrompt,
    domainResult.parsed, technicalResult.parsed, marketResult.parsed,
    appMetrics, accomplishments,
  );
  console.log(`[Research] Synthesis: ${synthesisResult.parsed ? "OK" : "FAILED TO PARSE"} (${synthesisResult.duration}ms)`);

  const synthesis = synthesisResult.parsed;
  const totalDuration = Date.now() - startTime;
  const totalCost = (domainResult.costUsd || 0) + (technicalResult.costUsd || 0) +
                    (marketResult.costUsd || 0) + (synthesisResult.costUsd || 0);

  // Step 6: Auto-queue high-confidence opportunities
  let autoQueued = 0;
  if (synthesis?.opportunities) {
    for (const opp of synthesis.opportunities) {
      if (opp.autoQueue) {
        await getTracker().redis.rpush("hydra:anchors:work-queue", JSON.stringify({
          reference: opp.title,
          reason: `Research ${researchId}: ${opp.rationale?.slice(0, 200) || "auto-queued from research"}`,
          context: JSON.stringify({
            researchId,
            rank: opp.rank,
            adjustedScore: opp.adjustedScore,
            category: opp.category,
            acceptanceCriteria: opp.acceptanceCriteria,
            complexity: opp.complexity,
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
      synthesisMs: synthesisResult.duration,
    },
    cost: {
      totalUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
      domain: domainResult.costUsd || 0,
      technical: technicalResult.costUsd || 0,
      market: marketResult.costUsd || 0,
      synthesis: synthesisResult.costUsd || 0,
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
    opportunityCount: synthesis?.opportunities?.length || 0,
  };

  // Write report to vault
  await mkdir(RESEARCH_DIR, { recursive: true });
  await writeFile(
    join(RESEARCH_DIR, `${researchId}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(`[Research] Report saved to ${RESEARCH_DIR}/${researchId}.json`);

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
    const files = (await readdir(RESEARCH_DIR))
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, count);

    const reports = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(RESEARCH_DIR, file), "utf-8");
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
      } catch {}
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
