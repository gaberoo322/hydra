import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EventBus, STREAMS } from "./event-bus.mjs";
import { runAgent, findPersonality } from "./codex-runner.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const ORCHESTRATOR_PATH = process.env.HYDRA_ORCHESTRATOR_PATH || resolve(process.env.HOME, "hydra");
const PROPOSALS_DIR = join(HYDRA_PATH, "reports", "proposals");
const APPROVED_DIR = join(PROPOSALS_DIR, "approved");

// In-memory proposal registry
const proposals = new Map();
let proposalCounter = 0;

/**
 * Run the Meta agent to analyze cycle reports and generate proposals.
 */
async function runMetaAnalysis(eventBus, event) {
  console.log("[Meta] Analyzing cycle reports for improvement opportunities...");

  // Gather recent cycle reports
  const reportsDir = join(HYDRA_PATH, "reports", "cycle-summaries");
  let reportFiles = [];
  try {
    const files = await readdir(reportsDir);
    reportFiles = files.filter((f) => f.endsWith(".md")).sort().slice(-10);
  } catch {}

  let reportContent = "";
  for (const file of reportFiles) {
    try {
      const content = await readFile(join(reportsDir, file), "utf-8");
      reportContent += `\n### ${file}\n${content.substring(0, 2000)}\n`;
    } catch {}
  }

  // Load orchestrator source for Meta to understand the system
  let orchestratorSource = "";
  const srcFiles = ["index.mjs", "event-bus.mjs", "cycle.mjs", "pipeline.mjs", "codex-runner.mjs"];
  for (const file of srcFiles) {
    try {
      const content = await readFile(join(ORCHESTRATOR_PATH, "src", file), "utf-8");
      orchestratorSource += `\n### ${file}\n\`\`\`javascript\n${content.substring(0, 3000)}\n\`\`\`\n`;
    } catch {}
  }

  // Load agent personalities
  let personalities = "";
  const configDir = join(HYDRA_PATH, "agent-config");
  try {
    const configFiles = await readdir(configDir);
    for (const file of configFiles.filter((f) => f.endsWith(".md"))) {
      try {
        const content = await readFile(join(configDir, file), "utf-8");
        personalities += `\n### ${file}\n${content.substring(0, 500)}\n`;
      } catch {}
    }
  } catch {}

  // Load hard metrics instead of raw agent reports (V2 redesign: Meta analyzes numbers, not prose)
  let metricsContext = "";
  try {
    const { getMetricsTrend, getAggregateStats } = await import("./metrics.mjs");
    const trend = await getMetricsTrend(10);
    const stats = await getAggregateStats(10);
    metricsContext = [
      `## Measured Cycle Metrics (last ${trend.length} cycles)`,
      `Merged rate: ${stats.mergedRate}%`,
      `Failed rate: ${stats.failedRate}%`,
      `Abandoned rate: ${stats.abandonedRate}%`,
      `Regression rate: ${stats.regressionRate}%`,
      `Average cycle duration: ${stats.avgDurationHuman}`,
      "",
      "### Per-cycle detail:",
      ...trend.map((m) => `- ${m.cycleId}: ${m.tasksMerged ? "merged" : m.tasksFailed ? "failed" : "abandoned"} | "${m.taskTitle}" | tests:${m.testsBefore}→${m.testsAfter} | anchor:${m.anchorType} | risk:${m.rollbackRisk || "?"} | ${m.totalDurationMs}ms`),
    ].join("\n");
  } catch {
    metricsContext = "(No metrics available — system may be using legacy pipeline)";
  }

  const prompt = [
    "You are the Meta agent. You analyze MEASURED OUTCOMES only — not agent prose, not self-reported summaries.",
    "You receive hard metrics from recent cycles. Propose improvements based ONLY on these numbers.",
    "",
    metricsContext,
    "",
    reportContent ? `## Raw Cycle Reports (for context only — trust the metrics above, not these summaries)\n${reportContent.substring(0, 3000)}` : "",
    "",
    "## Instructions",
    "1. Identify 1-3 patterns from the METRICS that suggest real problems",
    "2. For each, propose a concrete change with expected measurable impact",
    "3. Do NOT propose speculative process changes without metric evidence",
    "4. Do NOT propose changes that add ceremony without reducing failure rate or regression rate",
    "5. Output ONLY valid JSON as specified in your personality",
  ].filter(Boolean).join("\n");

  const personality = await findPersonality("meta");
  const result = await runAgent({
    agentName: "meta",
    personality,
    prompt,
    model: "nano",
    taskId: `meta-analysis-${Date.now()}`,
    correlationId: event?.correlationId || "manual",
  });

  // Parse Meta output
  let metaOutput = {};
  try {
    metaOutput = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try { metaOutput = JSON.parse(match[0]); } catch {}
    }
  }

  // Create proposals from Meta's output, auto-triage low-risk ones
  const createdProposals = [];
  for (const proposal of metaOutput.proposals || []) {
    const created = await createProposal(proposal, event?.correlationId, eventBus);
    createdProposals.push(created);

    // Auto-approve low-risk personality proposals
    if (created.type === "personality" && created.risk === "low") {
      console.log(`[Meta] Auto-approving low-risk personality proposal #${created.id}: ${created.title}`);
      await approveProposal(created.id, eventBus);
    }
  }

  console.log(`[Meta] Created ${createdProposals.length} proposals (${createdProposals.filter(p => p.status === "approved").length} auto-approved)`);
  return { metaOutput, proposals: createdProposals };
}

/**
 * Create a proposal and write it to the vault.
 */
async function createProposal(proposal, correlationId, eventBus) {
  proposalCounter++;
  const id = proposalCounter;
  const proposalId = `proposal-${id}`;

  const record = {
    id,
    proposalId,
    title: proposal.title,
    type: proposal.type || "personality",
    impact: proposal.impact || "unknown",
    risk: proposal.risk || "medium",
    diff: proposal.diff || "",
    status: "pending",
    createdAt: new Date().toISOString(),
    correlationId,
  };

  proposals.set(id, record);

  // Write proposal to vault
  await mkdir(PROPOSALS_DIR, { recursive: true });
  const filename = `${proposalId}.md`;
  const content = [
    "---",
    `id: ${id}`,
    `proposalId: ${proposalId}`,
    `title: "${proposal.title}"`,
    `type: ${record.type}`,
    `risk: ${record.risk}`,
    `status: pending`,
    `createdAt: ${record.createdAt}`,
    `correlationId: ${correlationId || "manual"}`,
    "---",
    "",
    `# Proposal #${id}: ${proposal.title}`,
    "",
    `## Type: ${record.type}`,
    "",
    `## Impact`,
    proposal.impact || "(not specified)",
    "",
    `## Risk: ${record.risk}`,
    "",
    `## Proposed Change`,
    proposal.diff || "(not specified)",
    "",
    `## Evidence`,
    ...(proposal.evidence || []).map((e) => `- ${e}`),
    "",
    `## How to Approve`,
    `- Via API: \`curl -X POST http://localhost:4000/proposals/${id}/approve\``,
    `- Via Obsidian: Move this file to \`reports/proposals/approved/\``,
  ].join("\n");

  await writeFile(join(PROPOSALS_DIR, filename), content);

  // Publish notification
  if (eventBus) {
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "proposal:created",
      source: "meta",
      correlationId,
      payload: {
        proposalId,
        id,
        title: proposal.title,
        type: record.type,
        risk: record.risk,
        impact: proposal.impact,
      },
    });
  }

  console.log(`[Proposals] Created #${id}: ${proposal.title} (${record.type}, ${record.risk} risk)`);
  return record;
}

/**
 * Approve a proposal.
 */
async function approveProposal(id, eventBus) {
  const record = proposals.get(id);
  if (!record) return { error: `Proposal #${id} not found` };
  if (record.status !== "pending") return { error: `Proposal #${id} is already ${record.status}` };

  record.status = "approved";
  record.approvedAt = new Date().toISOString();

  // Move file to approved directory
  const filename = `${record.proposalId}.md`;
  try {
    await mkdir(APPROVED_DIR, { recursive: true });
    await rename(join(PROPOSALS_DIR, filename), join(APPROVED_DIR, filename));
  } catch {}

  // Publish approval event
  if (eventBus) {
    await eventBus.publish(STREAMS.PROPOSALS, {
      type: "proposal:approved",
      source: "orchestrator",
      correlationId: record.correlationId,
      payload: { proposalId: record.proposalId, id, title: record.title },
    });
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "proposal:approved",
      source: "orchestrator",
      payload: { id, title: record.title },
    });
  }

  console.log(`[Proposals] Approved #${id}: ${record.title}`);
  return { approved: true, proposal: record };
}

/**
 * Reject a proposal.
 */
async function rejectProposal(id, reason, eventBus) {
  const record = proposals.get(id);
  if (!record) return { error: `Proposal #${id} not found` };
  if (record.status !== "pending") return { error: `Proposal #${id} is already ${record.status}` };

  record.status = "rejected";
  record.rejectedAt = new Date().toISOString();
  record.rejectionReason = reason || "No reason given";

  if (eventBus) {
    await eventBus.publish(STREAMS.PROPOSALS, {
      type: "proposal:rejected",
      source: "orchestrator",
      payload: { id, title: record.title, reason: record.rejectionReason },
    });
  }

  console.log(`[Proposals] Rejected #${id}: ${record.title}`);
  return { rejected: true, proposal: record };
}

/**
 * List proposals.
 */
function listProposals(status) {
  const all = [...proposals.values()];
  if (status) return all.filter((p) => p.status === status);
  return all;
}

/**
 * Watch the approved directory for Obsidian-based approvals.
 * Polls every 30 seconds for new files in reports/proposals/approved/.
 */
async function watchApprovals(eventBus) {
  const knownApproved = new Set();

  // Pre-populate with existing files
  try {
    const files = await readdir(APPROVED_DIR);
    files.forEach((f) => knownApproved.add(f));
  } catch {}

  setInterval(async () => {
    try {
      const files = await readdir(APPROVED_DIR);
      for (const file of files) {
        if (knownApproved.has(file)) continue;
        knownApproved.add(file);

        // Extract proposal ID from filename
        const match = file.match(/proposal-(\d+)\.md/);
        if (match) {
          const id = parseInt(match[1]);
          const record = proposals.get(id);
          if (record && record.status === "pending") {
            console.log(`[Proposals] Detected Obsidian approval for #${id}`);
            await approveProposal(id, eventBus);
          }
        }
      }
    } catch {}
  }, 30000);
}

export {
  runMetaAnalysis,
  createProposal,
  approveProposal,
  rejectProposal,
  listProposals,
  watchApprovals,
};
