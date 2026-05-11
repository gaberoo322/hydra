/**
 * Proposals Manager — Redis-backed
 *
 * Manages Meta agent improvement proposals in Redis instead of the filesystem.
 * Proposals flow: pending → approved | rejected.
 * Approved proposals older than 7 days are auto-archived.
 *
 * Redis schema:
 *   hydra:proposals:{proposalId}  → Hash: proposal fields
 *   hydra:proposals:index         → Sorted Set: proposalId scored by timestamp
 */

import { readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { STREAMS } from "./event-bus.ts";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { redisKeys } from "./redis-keys.ts";
import { getTargetName } from "./target-config.ts";
import {
  getProposalHash,
  saveProposalHash,
  getProposalIdsDesc,
  getProposalIdsAsc,
  deleteProposal,
  removeProposalFromIndex,
  getProposalIdsByTimeRange,
  getRecentReportIdsDesc,
  getRealityReport,
  getRecentMetricIdsDesc,
  getCycleCostMicrodollars,
} from "./redis-adapter.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

// Allowed target files for auto-application (relative to config dir, without .md)
const ALLOWED_TARGETS = new Set([
  "agents/planner", "agents/executor", "agents/skeptic", "agents/meta",
  "feedback/to-planner", "feedback/to-executor", "feedback/to-skeptic",
  "direction/goals", "direction/tech-preferences", "direction/proposal-policy",
]);

function generateProposalId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0].replace(/-/g, "");
  const time = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `proposal-${date}-${time}-${rand}`;
}

async function getProposal(proposalId) {
  const data = await getProposalHash(proposalId);
  if (!data || Object.keys(data).length === 0) return null;
  // Parse JSON fields
  if (data.evidence) try { data.evidence = JSON.parse(data.evidence); } catch { (data as any).evidence = []; }
  return data;
}

async function saveProposal(record) {
  const toStore = { ...record };
  if (Array.isArray(toStore.evidence)) toStore.evidence = JSON.stringify(toStore.evidence);
  await saveProposalHash(record.proposalId, toStore);
}

/**
 * Run the Meta agent to analyze cycle reports and generate proposals.
 * Gathers comprehensive system context: metrics, reality reports, backlog,
 * agent memory rules, spending, and grounding state.
 */
async function runMetaAnalysis(eventBus, event) {
  const trigger = event?.payload?.trigger || "manual";
  console.log(`[Meta] Starting analysis (trigger: ${trigger})...`);

  const contextSections = [];

  // 1. Hard metrics — 20 cycles of trend data + aggregate stats
  try {
    const { getMetricsTrend, getAggregateStats } = await import("./metrics.ts");
    const trend = await getMetricsTrend(20);
    const stats = await getAggregateStats(20);
    contextSections.push([
      `## Cycle Metrics (last ${trend.length} cycles)`,
      `Merged: ${stats.mergedRate}% | Failed: ${stats.failedRate}% | Abandoned: ${stats.abandonedRate}% | Regression: ${stats.regressionRate}%`,
      `Average cycle duration: ${stats.avgDurationHuman}`,
      "",
      "### Per-cycle detail:",
      ...trend.map((m) => `- ${m.cycleId}: ${m.tasksMerged ? "MERGED" : m.tasksFailed ? "FAILED" : "ABANDONED"} | "${m.taskTitle}" | tests:${m.testsBefore}→${m.testsAfter} | anchor:${m.anchorType} | risk:${m.rollbackRisk || "?"} | ${m.totalDurationMs}ms`),
    ].join("\n"));
  } catch { contextSections.push("## Cycle Metrics\n(unavailable)"); }

  // 2. Reality reports — detailed post-cycle reports with grounding, verification, merge info
  try {
    const reportIds = await getRecentReportIdsDesc(10);
    const reports = [];
    for (const id of reportIds) {
      const raw = await getRealityReport(id);
      if (raw) {
        const report = JSON.parse(raw);
        reports.push(`- **${report.cycleId || id}**: task="${report.task?.title || "?"}" state=${report.task?.finalState || "?"} | grounding: ${report.grounding?.before?.passed ?? "?"}→${report.grounding?.after?.passed ?? "?"} tests | verification: ${report.verification?.allPassed ? "PASS" : "FAIL"} | regression: ${report.regressionIntroduced ? "YES" : "no"}`);
      }
    }
    if (reports.length > 0) {
      contextSections.push(`## Reality Reports (last ${reports.length})\n${reports.join("\n")}`);
    }
  } catch { /* intentional: reality reports optional — meta context proceeds without */ }

  // 3. Spending — cost trends
  try {
    const cycleIds = await getRecentMetricIdsDesc(20);
    let totalCost = 0;
    let cyclesWithCost = 0;
    for (const cid of cycleIds) {
      const costMicro = parseInt(await getCycleCostMicrodollars(cid) || "0");
      if (costMicro > 0) { totalCost += costMicro / 1_000_000; cyclesWithCost++; }
    }
    if (cyclesWithCost > 0) {
      contextSections.push(`## Spending\nTotal: $${totalCost.toFixed(2)} across ${cyclesWithCost} cycles | Avg: $${(totalCost / cyclesWithCost).toFixed(3)}/cycle`);
    }
  } catch { /* intentional: spending metrics optional — meta context proceeds without */ }

  // 4. Backlog state — what's queued, blocked, in progress
  try {
    const { _admin: backlogAdmin } = await import("./backlog.ts");
    const backlog = await backlogAdmin.loadBacklog();
    const counts: Record<string, any> = {};
    for (const lane of ["backlog", "queued", "blocked", "inProgress", "done"]) {
      counts[lane] = ((backlog as any)[lane] || []).length;
    }
    const blockedItems = ((backlog as any).blocked || []).map((i: any) => `"${i.title || i}"`).slice(0, 5);
    contextSections.push([
      "## Backlog State",
      `Backlog: ${counts.backlog} | Queued: ${counts.queued} | Blocked: ${counts.blocked} | In Progress: ${counts.inProgress} | Done: ${counts.done}`,
      blockedItems.length > 0 ? `Blocked items: ${blockedItems.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  } catch { /* intentional: backlog snapshot optional — meta context proceeds without */ }

  // 5. Agent memory — learned prevention rules (WHEN/CHECK/BECAUSE)
  try {
    const { loadAgentMemory } = await import("./learning.ts");
    const agentRules = [];
    for (const agent of ["planner", "executor", "skeptic"]) {
      const memory = await loadAgentMemory(agent);
      if (memory && memory.trim()) {
        const ruleCount = (memory.match(/WHEN:/g) || []).length;
        agentRules.push(`- **${agent}**: ${ruleCount} prevention rules`);
      }
    }
    if (agentRules.length > 0) {
      contextSections.push(`## Agent Memory (learned rules)\n${agentRules.join("\n")}`);
    }
  } catch { /* intentional: agent memory optional — meta context proceeds without */ }

  // 6. Current agent config files — so Meta knows what it's proposing changes to
  try {
    const agentConfigs = [];
    for (const agent of ["planner", "executor", "skeptic"]) {
      const content = await readFile(join(CONFIG_PATH, `agents/${agent}.md`), "utf-8");
      // Include first 30 lines (identity + core rules) not the full file
      const preview = content.split("\n").slice(0, 30).join("\n");
      agentConfigs.push(`### ${agent}.md (first 30 lines)\n\`\`\`\n${preview}\n\`\`\``);
    }
    contextSections.push(`## Current Agent Personalities\n${agentConfigs.join("\n\n")}`);
  } catch { /* intentional: agent config files optional — meta context proceeds without */ }

  // 7. Feedback files — current operator guidance
  try {
    const feedbackSummary = [];
    for (const target of ["to-planner", "to-executor", "to-skeptic"]) {
      const content = await readFile(join(CONFIG_PATH, `feedback/${target}.md`), "utf-8");
      const lineCount = content.split("\n").length;
      feedbackSummary.push(`- **${target}.md**: ${lineCount} lines`);
    }
    contextSections.push(`## Operator Feedback Files\n${feedbackSummary.join("\n")}`);
  } catch { /* intentional: feedback files optional — meta context proceeds without */ }

  // 8. Recent proposals — so Meta doesn't re-propose the same things
  try {
    const recent = await listProposals();
    if (recent.length > 0) {
      const proposalLines = recent.slice(0, 15).map(p =>
        `- [${p.status}] "${p.title}" → ${p.targetFile || "?"} (${p.risk} risk)${p.status === "rejected" ? ` — rejected: ${p.rejectionReason || "no reason"}` : ""}${p.applied === "true" ? " — APPLIED" : ""}`
      );
      contextSections.push(`## Recent Proposals (do NOT re-propose these)\n${proposalLines.join("\n")}\n\nDo not propose anything that duplicates or closely resembles an existing approved, applied, or rejected proposal. If a proposal was rejected, do not re-propose it unless you have new evidence that was not available when it was rejected.`);
    }
  } catch { /* intentional: prior proposals optional — meta context proceeds without */ }

  // 9. System architecture summary
  contextSections.push([
    "## System Architecture",
    `Hydra runs a 3-agent control loop on the ${getTargetName()} codebase:`,
    "1. **Grounding**: npm test + tsc (read-only repo inspection)",
    "2. **Planner** (frontier model): proposes 1 bounded task from anchor (queue > failing-test > prior-failure > backlog > priorities > research)",
    "3. **Skeptic** (codex model): challenges the plan (skipped for quick-fix/research tasks)",
    "4. **Executor** (codex model): implements on feature branch",
    "5. **Verification**: npm test + tsc + npm run build (hard verification, not an agent)",
    "6. **Merge**: git merge --no-ff to main",
    "7. **Report + compound learnings**: reality report + WHEN/CHECK/BECAUSE rules extracted",
    "",
    "Config files live in ~/hydra/config/ (git-tracked). State is in Redis.",
    "Agent personalities: config/agents/{planner,executor,skeptic}.md",
    "Feedback files: config/feedback/{to-planner,to-executor,to-skeptic}.md",
    "Direction files: config/direction/{vision,goals,priorities,tech-preferences}.md",
  ].join("\n"));

  // Build the prompt
  const prompt = [
    `## Trigger: ${trigger}`,
    "",
    ...contextSections,
    "",
    "## Your Task",
    "Analyze the data above. Identify the highest-impact improvements to Hydra's effectiveness.",
    "Consider: cycle success rate, failure patterns, cost efficiency, agent behavior, backlog health, and system architecture.",
    "",
    "When everything is working well, look for optimization opportunities:",
    "- Can cycles run faster? Are agents over-scoped or under-scoped?",
    "- Are there recurring patterns in task types that suggest specialization?",
    "- Are agent personalities or feedback files stale, redundant, or missing guidance?",
    "- Is spending efficient? Are expensive models used where cheaper ones would suffice?",
    "- Are blocked items stuck? Should priorities shift?",
    "",
    "Output ONLY valid JSON as specified in your personality file.",
  ].join("\n");

  const personality = await findPersonality("meta");

  const result = await runAgent({
    agentName: "meta",
    personality,
    prompt,
    model: "frontier",
    taskId: `meta-analysis-${Date.now()}`,
    correlationId: event?.correlationId || "manual",
  });

  let metaOutput: Record<string, any> = {};
  try {
    metaOutput = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try { metaOutput = JSON.parse(match[0]); } catch { /* intentional: fallback JSON parse from regex match, proceed with empty metaOutput */ }
    }
  }

  const createdProposals: any[] = [];
  for (const proposal of metaOutput.proposals || []) {
    const created: any = await createProposal(proposal, event?.correlationId, eventBus);
    createdProposals.push(created);

    if (created.dedupRejected) continue; // skip dedup-rejected proposals
    if (created.type === "personality" && created.risk === "low") {
      console.log(`[Meta] Auto-approving low-risk personality proposal ${created.proposalId}: ${created.title}`);
      await approveProposal(created.proposalId, eventBus);
    }
  }

  console.log(`[Meta] Created ${createdProposals.length} proposals (${createdProposals.filter(p => p.status === "approved").length} auto-approved)`);
  return { metaOutput, proposals: createdProposals };
}

// ---------------------------------------------------------------------------
// Dedup helpers (AC1)
// ---------------------------------------------------------------------------

const DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Compute word-overlap ratio between two titles.
 * Returns a number 0–1 representing fraction of shared words.
 */
function titleOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  const minSize = Math.min(wordsA.size, wordsB.size);
  return overlap / minSize;
}

/**
 * Check if a proposal with similar title+targetFile already exists within the last 30 days.
 * Returns { duplicate: true, existingId, existingTitle, reason } or { duplicate: false }.
 */
async function checkDuplicate(title: string, targetFile: string): Promise<
  { duplicate: true; existingId: string; existingTitle: string; reason: string } |
  { duplicate: false }
> {
  const now = Date.now();
  const cutoff = now - DEDUP_WINDOW_MS;
  const recentIds = await getProposalIdsByTimeRange(cutoff, now);

  for (const id of recentIds) {
    const existing = await getProposal(id);
    if (!existing) continue;

    const overlap = titleOverlap(title, existing.title || "");
    const targetMatch = targetFile && existing.targetFile
      ? targetFile === existing.targetFile
      : false;

    // Match if >70% word overlap AND same targetFile (when both present)
    if (overlap > 0.7 && (targetMatch || (!targetFile && !existing.targetFile))) {
      return {
        duplicate: true,
        existingId: id,
        existingTitle: existing.title,
        reason: `title overlap ${Math.round(overlap * 100)}%${targetMatch ? " + same targetFile" : ""}`,
      };
    }
  }

  return { duplicate: false };
}

// ---------------------------------------------------------------------------
// Metrics snapshot helpers (AC2 / AC3)
// ---------------------------------------------------------------------------

/**
 * Capture current system metrics for proposal impact measurement.
 */
async function captureMetricsSnapshot(): Promise<{
  mergeRate: number;
  failureRate: number;
  avgDuration: number;
  capturedAt: string;
}> {
  try {
    const { getAggregateStats } = await import("./metrics.ts");
    const stats = await getAggregateStats(20);
    return {
      mergeRate: stats.mergedRate ?? 0,
      failureRate: stats.failedRate ?? 0,
      avgDuration: stats.avgDurationMs ?? 0,
      capturedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    console.error(`[Proposals] Failed to capture metrics snapshot: ${err.message}`);
    return {
      mergeRate: 0,
      failureRate: 0,
      avgDuration: 0,
      capturedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check if enough cycles have elapsed since a proposal was applied,
 * then capture post-metrics and calculate impact delta.
 *
 * Returns the impact result or an error object. Does not throw.
 */
async function checkProposalImpact(proposalId: string): Promise<
  { measured: true; impact: { mergeRateDelta: number; failureRateDelta: number; avgDurationDelta: number }; proposal: any } |
  { measured: false; reason: string }
> {
  const record = await getProposal(proposalId);
  if (!record) return { measured: false, reason: `Proposal ${proposalId} not found` };
  if (record.applied !== "true") return { measured: false, reason: `Proposal ${proposalId} was not applied` };
  if (!record.appliedAt) return { measured: false, reason: `Proposal ${proposalId} has no appliedAt timestamp` };

  // Check if 3+ cycles have run since appliedAt
  try {
    const { getMetricsTrend } = await import("./metrics.ts");
    const trend = await getMetricsTrend(20);
    const appliedMs = new Date(record.appliedAt).getTime();
    const cyclesSinceApplied = trend.filter((m: any) => {
      const cycleMs = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return cycleMs > appliedMs;
    }).length;

    if (cyclesSinceApplied < 3) {
      return { measured: false, reason: `Only ${cyclesSinceApplied} cycles since application (need 3)` };
    }
  } catch (err: any) {
    console.error(`[Proposals] Failed to check cycle count for impact: ${err.message}`);
    return { measured: false, reason: `Failed to check cycle count: ${err.message}` };
  }

  // Already measured?
  if (record.postMetrics) {
    try {
      const existing = typeof record.postMetrics === "string"
        ? JSON.parse(record.postMetrics) : record.postMetrics;
      const impact = typeof record.impact === "string"
        ? JSON.parse(record.impact) : record.impact;
      return { measured: true, impact, proposal: record };
    } catch { /* intentional: re-measure if parsing fails */ }
  }

  const postMetrics = await captureMetricsSnapshot();
  let preMetrics = { mergeRate: 0, failureRate: 0, avgDuration: 0 };
  try {
    preMetrics = typeof record.preMetrics === "string"
      ? JSON.parse(record.preMetrics) : (record.preMetrics || preMetrics);
  } catch { /* intentional: use zeros if pre-metrics missing/corrupt */ }

  const impact = {
    mergeRateDelta: postMetrics.mergeRate - preMetrics.mergeRate,
    failureRateDelta: postMetrics.failureRate - preMetrics.failureRate,
    avgDurationDelta: postMetrics.avgDuration - preMetrics.avgDuration,
  };

  record.postMetrics = JSON.stringify(postMetrics);
  record.impact = JSON.stringify(impact);
  await saveProposal(record);

  console.log(`[Proposals] Impact measured for ${proposalId}: mergeRate ${impact.mergeRateDelta > 0 ? "+" : ""}${impact.mergeRateDelta}%, failureRate ${impact.failureRateDelta > 0 ? "+" : ""}${impact.failureRateDelta}%`);
  return { measured: true, impact, proposal: record };
}

/**
 * Create a proposal and store it in Redis.
 * Checks for duplicates before creating (AC1).
 */
async function createProposal(proposal, correlationId, eventBus) {
  // AC1: dedup check — reject if a similar proposal exists within last 30 days
  const dedupResult = await checkDuplicate(proposal.title || "", proposal.targetFile || "");
  if (dedupResult.duplicate) {
    console.log(`[Proposals] Dedup rejected: "${proposal.title}" matches "${dedupResult.existingTitle}" (${dedupResult.reason})`);
    return {
      proposalId: null,
      title: proposal.title,
      status: "rejected",
      rejectionReason: `Duplicate of proposal ${dedupResult.existingId}: ${dedupResult.existingTitle}`,
      dedupRejected: true,
    };
  }

  const proposalId = generateProposalId();

  const record = {
    proposalId,
    title: proposal.title,
    type: proposal.type || "personality",
    targetFile: proposal.targetFile || "",
    impact: proposal.impact || "unknown",
    risk: proposal.risk || "medium",
    diff: proposal.diff || "",
    appendLines: proposal.appendLines || "",
    evidence: proposal.evidence || [],
    status: "pending",
    createdAt: new Date().toISOString(),
    correlationId: correlationId || "manual",
  };

  await saveProposal(record);

  if (eventBus) {
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "proposal:created",
      source: "meta",
      correlationId,
      payload: {
        proposalId,
        title: proposal.title,
        type: record.type,
        risk: record.risk,
        impact: proposal.impact,
      },
    });
  }

  console.log(`[Proposals] Created ${proposalId}: ${proposal.title} (${record.type}, ${record.risk} risk)`);
  return record;
}

/**
 * Apply an approved proposal by modifying the target config file.
 * Only applies proposals with a valid targetFile and appendLines.
 * Returns { applied: true, targetFile } on success, { applied: false, reason } otherwise.
 */
async function applyProposal(record) {
  const target = record.targetFile;
  if (!target) return { applied: false, reason: "no targetFile specified" };
  if (!ALLOWED_TARGETS.has(target)) return { applied: false, reason: `targetFile "${target}" is not in the allowed list` };

  const filePath = join(CONFIG_PATH, `${target}.md`);

  // Verify the file exists before modifying
  try {
    await readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return { applied: false, reason: `target file does not exist: ${filePath}` };
    throw err;
  }

  const lines = record.appendLines;
  if (!lines || !lines.trim()) return { applied: false, reason: "no appendLines content to apply" };

  await appendFile(filePath, `\n${lines.trim()}\n`);
  console.log(`[Proposals] Applied changes to ${filePath}`);
  return { applied: true, targetFile: target };
}

/**
 * Approve a proposal.
 */
async function approveProposal(proposalId, eventBus) {
  const record = await getProposal(proposalId);
  if (!record) return { error: `Proposal ${proposalId} not found` };
  if (record.status !== "pending") return { error: `Proposal ${proposalId} is already ${record.status}` };

  record.status = "approved";
  record.approvedAt = new Date().toISOString();

  // AC2: capture pre-application metrics snapshot
  try {
    const preMetrics = await captureMetricsSnapshot();
    record.preMetrics = JSON.stringify(preMetrics);
  } catch (err: any) {
    console.error(`[Proposals] Failed to capture pre-metrics for ${proposalId}: ${err.message}`);
  }

  // Attempt to auto-apply the proposal
  let applicationResult = { applied: false, reason: "skipped" };
  try {
    // @ts-expect-error — migrate to proper types
    applicationResult = await applyProposal(record);
    record.applied = applicationResult.applied ? "true" : "false";
    if (applicationResult.applied) {
      record.appliedAt = new Date().toISOString();
    }
    record.applicationNote = applicationResult.applied
    // @ts-expect-error — migrate to proper types
      ? `Applied to ${applicationResult.targetFile}`
      : applicationResult.reason;
  } catch (err: any) {
    record.applied = "false";
    record.applicationNote = `Error: ${err.message}`;
    console.error(`[Proposals] Failed to apply ${proposalId}: ${err.message}`);
  }

  // If the proposal wasn't auto-applied (orchestrator changes, missing appendLines, etc.),
  // create a backlog item so Hydra can implement it as a code task.
  let backlogItemId: string | number | null = null;
  if (!applicationResult.applied) {
    try {
      const { addItem: addToBacklog } = await import("./backlog.ts");
      const descParts = [`Approved proposal: ${record.proposalId}`];
      if (record.diff) descParts.push(`## What to change\n${record.diff}`);
      if (record.impact) descParts.push(`## Expected impact\n${record.impact}`);
      if (record.targetFile) descParts.push(`## Target\n${record.targetFile}`);

      const result = await addToBacklog({
        title: record.title,
        category: "hydra",
        source: "proposal",
        description: descParts.join("\n\n"),
        labels: ["proposal", record.type || "config"],
        priority: record.risk === "low" ? 3 : 2,
      });
      if (result.added) {
        backlogItemId = result.id ?? null;
        record.backlogItemId = String(result.id);
        console.log(`[Proposals] Created backlog item ${result.id} for unapplied proposal ${proposalId}`);
      }
    } catch (err: any) {
      console.error(`[Proposals] Failed to create backlog item for ${proposalId}: ${err.message}`);
    }
  }

  await saveProposal(record);

  if (eventBus) {
    await eventBus.publish(STREAMS.PROPOSALS, {
      type: "proposal:approved",
      source: "orchestrator",
      correlationId: record.correlationId,
      payload: { proposalId, title: record.title, applied: applicationResult.applied, backlogItemId },
    });
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "proposal:approved",
      source: "orchestrator",
      payload: { proposalId, title: record.title, applied: applicationResult.applied, backlogItemId },
    });
  }

    // @ts-expect-error — migrate to proper types
  console.log(`[Proposals] Approved ${proposalId}: ${record.title} (applied: ${applicationResult.applied}${applicationResult.applied ? ` → ${applicationResult.targetFile}` : `: ${applicationResult.reason}`}${backlogItemId ? `, backlog: ${backlogItemId}` : ""})`);
  return { approved: true, applied: applicationResult.applied, backlogItemId, proposal: record };
}

/**
 * Reject a proposal.
 */
async function rejectProposal(proposalId, reason, eventBus) {
  const record = await getProposal(proposalId);
  if (!record) return { error: `Proposal ${proposalId} not found` };
  if (record.status !== "pending") return { error: `Proposal ${proposalId} is already ${record.status}` };

  record.status = "rejected";
  record.rejectedAt = new Date().toISOString();
  record.rejectionReason = reason || "No reason given";
  await saveProposal(record);

  if (eventBus) {
    await eventBus.publish(STREAMS.PROPOSALS, {
      type: "proposal:rejected",
      source: "orchestrator",
      payload: { proposalId, title: record.title, reason: record.rejectionReason },
    });
  }

  console.log(`[Proposals] Rejected ${proposalId}: ${record.title}`);
  return { rejected: true, proposal: record };
}

/**
 * List proposals from Redis.
 */
async function listProposals(status?) {
  const ids = await getProposalIdsDesc();
  const all = [];
  for (const id of ids) {
    const p = await getProposal(id);
    if (p) all.push(p);
  }
  if (status) return all.filter((p) => p.status === status);
  return all;
}

/**
 * No-op — kept for backward compatibility with index.mjs.
 * Proposal approvals are handled via the dashboard and API.
 */
function watchApprovals() {
}

/**
 * Clean up old proposals — delete rejected/archived proposals older than 30 days.
 */
async function archiveApprovedProposals() {
  const ids = await getProposalIdsAsc();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const id of ids) {
    const p = await getProposal(id);
    if (!p) { await removeProposalFromIndex(id); continue; }
    if (p.status === "rejected" || p.status === "approved") {
      const ts = new Date(p.rejectedAt || p.approvedAt || p.createdAt).getTime();
      if (ts < cutoff) {
        await deleteProposal(id);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[Proposals] Cleaned ${cleaned} old proposals`);
  }
}

export {
  runMetaAnalysis,
  createProposal,
  approveProposal,
  rejectProposal,
  listProposals,
  watchApprovals,
  archiveApprovedProposals,
  checkProposalImpact,
  checkDuplicate,
  titleOverlap,
  captureMetricsSnapshot,
};
