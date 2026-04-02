/**
 * Research Architect
 *
 * Periodically reviews research quality vs execution outcomes
 * and updates researcher methodology to improve over time.
 *
 * Runs after every N research cycles (default: 3) when there are
 * enough execution outcomes to evaluate.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent } from "./codex-runner.mjs";
import { getMetricsTrend } from "./metrics.mjs";
import { STREAMS } from "./event-bus.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const RESEARCH_DIR = join(HYDRA_PATH, "reports", "research");
const METHODOLOGY_DIR = join(HYDRA_PATH, "research-methodology");
const ARCHITECT_REPORTS_DIR = join(HYDRA_PATH, "reports", "architect-reviews");

const MIN_RESEARCH_CYCLES = 3; // Minimum research reports before running architect
const MIN_EXECUTION_CYCLES = 5; // Minimum execution cycles to evaluate outcomes

/**
 * Run the Research Architect to evaluate and improve research methodology.
 *
 * @param {EventBus} eventBus
 * @returns {ArchitectReport}
 */
export async function runArchitectReview(eventBus) {
  const startTime = Date.now();
  console.log("[Architect] Starting methodology review...");

  // Load recent research reports
  let researchReports = [];
  try {
    const files = (await readdir(RESEARCH_DIR))
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 10);

    for (const file of files) {
      try {
        const raw = await readFile(join(RESEARCH_DIR, file), "utf-8");
        researchReports.push(JSON.parse(raw));
      } catch {}
    }
  } catch {}

  if (researchReports.length < MIN_RESEARCH_CYCLES) {
    console.log(`[Architect] Only ${researchReports.length} research reports — need ${MIN_RESEARCH_CYCLES} before reviewing`);
    return { skipped: true, reason: `Insufficient research data (${researchReports.length}/${MIN_RESEARCH_CYCLES})` };
  }

  // Load execution outcomes
  const executionMetrics = await getMetricsTrend(30);
  if (executionMetrics.length < MIN_EXECUTION_CYCLES) {
    console.log(`[Architect] Only ${executionMetrics.length} execution cycles — need ${MIN_EXECUTION_CYCLES} before reviewing`);
    return { skipped: true, reason: `Insufficient execution data (${executionMetrics.length}/${MIN_EXECUTION_CYCLES})` };
  }

  // Load current methodology overrides
  const currentMethodology = {};
  for (const researcher of ["domain-researcher", "technical-researcher", "market-researcher"]) {
    try {
      currentMethodology[researcher] = await readFile(join(METHODOLOGY_DIR, `${researcher}.md`), "utf-8");
    } catch {
      currentMethodology[researcher] = "(no overrides yet)";
    }
  }

  // Build context for the architect agent
  // Summarize research recommendations and their outcomes
  const researchSummary = researchReports.map(r => ({
    researchId: r.researchId,
    timestamp: r.timestamp,
    autoQueued: r.autoQueued,
    topOpportunities: (r.synthesis?.opportunities || []).slice(0, 5).map(o => ({
      title: o.title,
      rank: o.rank,
      adjustedScore: o.adjustedScore,
      confidence: o.confidence,
      complexity: o.complexity,
      autoQueue: o.autoQueue,
      category: o.category,
    })),
  }));

  const executionSummary = executionMetrics.map(m => ({
    cycleId: m.cycleId,
    merged: m.tasksMerged > 0,
    failed: m.tasksFailed > 0,
    rolledBack: m.rolledBack === "true",
    taskTitle: m.taskTitle,
    anchorType: m.anchorType,
    testsBefore: m.testsBefore,
    testsAfter: m.testsAfter,
    regression: m.regressionIntroduced === true || m.regressionIntroduced === "true",
  }));

  // Cross-reference: which research recommendations were executed?
  const researchTitles = new Set();
  for (const r of researchReports) {
    for (const opp of (r.synthesis?.opportunities || [])) {
      researchTitles.add(opp.title);
    }
  }
  const executedFromResearch = executionMetrics.filter(m =>
    m.taskTitle && researchTitles.has(m.taskTitle)
  );

  const prompt = [
    "## Research Reports (most recent first)",
    JSON.stringify(researchSummary, null, 2).slice(0, 4000),
    "",
    "## Execution Outcomes (most recent first)",
    JSON.stringify(executionSummary, null, 2).slice(0, 3000),
    "",
    `## Cross-Reference: ${executedFromResearch.length} of ${executionMetrics.length} execution cycles came from research recommendations`,
    executedFromResearch.length > 0
      ? executedFromResearch.map(m => `- "${m.taskTitle}": ${m.merged ? "MERGED" : m.failed ? "FAILED" : "OTHER"}`).join("\n")
      : "(no research recommendations have been executed yet — evaluate research quality from the reports alone)",
    "",
    "## Current Methodology Overrides",
    ...Object.entries(currentMethodology).map(([k, v]) => `### ${k}\n${v}`),
    "",
    "## Instructions",
    `Review the research quality and execution outcomes above.`,
    `Evaluate calibration: are confidence scores accurate? Are complexity estimates realistic?`,
    `Identify patterns: which researcher provides the most actionable insights?`,
    `Propose specific methodology updates to improve research quality.`,
    `Output ONLY valid JSON as specified in your personality file.`,
  ].join("\n");

  const personality = join(process.cwd(), "config", "research-architect.md");
  const result = await runAgent({
    agentName: "research-architect",
    personality,
    prompt,
    model: "frontier",
    taskId: "architect-review",
    correlationId: `architect-${Date.now()}`,
  });

  let review = null;
  try { review = JSON.parse(result.output); } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) { try { review = JSON.parse(match[0]); } catch {} }
  }

  if (!review) {
    console.error("[Architect] Failed to parse architect output");
    return { error: "Failed to parse architect output", researchId: null };
  }

  // Apply methodology updates
  let updatesApplied = 0;
  if (review.methodologyUpdates?.length > 0) {
    await mkdir(METHODOLOGY_DIR, { recursive: true });

    for (const update of review.methodologyUpdates) {
      const target = update.target;
      if (!target || !update.change) continue;

      const filePath = join(METHODOLOGY_DIR, `${target}.md`);
      let existing = "";
      try { existing = await readFile(filePath, "utf-8"); } catch {}

      const timestamp = new Date().toISOString().split("T")[0];
      const newContent = existing
        ? `${existing}\n\n## Update ${timestamp}\n${update.change}\nReason: ${update.reason || "architect review"}`
        : `# Methodology Updates for ${target}\n\n## Update ${timestamp}\n${update.change}\nReason: ${update.reason || "architect review"}`;

      await writeFile(filePath, newContent);
      updatesApplied++;
      console.log(`[Architect] Updated methodology for ${target}: ${update.change.slice(0, 100)}`);
    }
  }

  // Store architect report
  await mkdir(ARCHITECT_REPORTS_DIR, { recursive: true });
  const reportFile = `architect-${new Date().toISOString().split("T")[0]}.json`;
  const fullReport = {
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    researchCyclesReviewed: researchReports.length,
    executionCyclesReviewed: executionMetrics.length,
    updatesApplied,
    review,
    costUsd: result.costUsd || 0,
  };
  await writeFile(join(ARCHITECT_REPORTS_DIR, reportFile), JSON.stringify(fullReport, null, 2));

  // Notify
  if (eventBus) {
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "architect:review_completed",
      source: "research-architect",
      payload: {
        researchCyclesReviewed: researchReports.length,
        executionCyclesReviewed: executionMetrics.length,
        updatesApplied,
        calibration: review.calibration?.overallCalibration || "unknown",
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`,
      },
    });
  }

  console.log(`[Architect] Review complete — ${updatesApplied} methodology updates applied`);
  return fullReport;
}
