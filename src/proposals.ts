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
import Redis from "ioredis";
import { STREAMS } from "./event-bus.ts";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { redisKeys } from "./redis-keys.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

// Allowed target files for auto-application (relative to config dir, without .md)
const ALLOWED_TARGETS = new Set([
  "agents/planner", "agents/executor", "agents/skeptic", "agents/meta",
  "feedback/to-planner", "feedback/to-executor", "feedback/to-skeptic",
  "direction/goals", "direction/tech-preferences", "direction/proposal-policy",
]);

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const INDEX_KEY = redisKeys.proposalsIndex();
const proposalKey = (id) => redisKeys.proposal(id);

let redis = null;
function getRedis() {
  if (!redis) redis = new Redis(REDIS_URL);
  return redis;
}

function generateProposalId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0].replace(/-/g, "");
  const time = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `proposal-${date}-${time}-${rand}`;
}

async function getProposal(proposalId) {
  const data = await getRedis().hgetall(proposalKey(proposalId));
  if (!data || Object.keys(data).length === 0) return null;
  // Parse JSON fields
  if (data.evidence) try { data.evidence = JSON.parse(data.evidence); } catch { data.evidence = []; }
  return data;
}

async function saveProposal(record) {
  const r = getRedis();
  const toStore = { ...record };
  if (Array.isArray(toStore.evidence)) toStore.evidence = JSON.stringify(toStore.evidence);
  await r.hset(proposalKey(record.proposalId), toStore);
  await r.zadd(INDEX_KEY, Date.now(), record.proposalId);
}

/**
 * Run the Meta agent to analyze cycle reports and generate proposals.
 * Gathers comprehensive system context: metrics, reality reports, backlog,
 * agent memory rules, spending, and grounding state.
 */
async function runMetaAnalysis(eventBus, event) {
  const trigger = event?.payload?.trigger || "manual";
  console.log(`[Meta] Starting analysis (trigger: ${trigger})...`);

  const r = getRedis();
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
    const reportIds = await r.zrevrange(redisKeys.realityReportIndex(), 0, 9);
    const reports = [];
    for (const id of reportIds) {
      const raw = await r.get(redisKeys.realityReport(id));
      if (raw) {
        const report = JSON.parse(raw);
        reports.push(`- **${report.cycleId || id}**: task="${report.task?.title || "?"}" state=${report.task?.finalState || "?"} | grounding: ${report.grounding?.before?.passed ?? "?"}→${report.grounding?.after?.passed ?? "?"} tests | verification: ${report.verification?.allPassed ? "PASS" : "FAIL"} | regression: ${report.regressionIntroduced ? "YES" : "no"}`);
      }
    }
    if (reports.length > 0) {
      contextSections.push(`## Reality Reports (last ${reports.length})\n${reports.join("\n")}`);
    }
  } catch { /* no reality reports */ }

  // 3. Spending — cost trends
  try {
    const cycleIds = await r.zrevrange(redisKeys.metricsIndex(), 0, 19);
    let totalCost = 0;
    let cyclesWithCost = 0;
    for (const cid of cycleIds) {
      const costMicro = parseInt(await r.hget(redisKeys.cycleCosts(cid), "costMicrodollars") || "0");
      if (costMicro > 0) { totalCost += costMicro / 1_000_000; cyclesWithCost++; }
    }
    if (cyclesWithCost > 0) {
      contextSections.push(`## Spending\nTotal: $${totalCost.toFixed(2)} across ${cyclesWithCost} cycles | Avg: $${(totalCost / cyclesWithCost).toFixed(3)}/cycle`);
    }
  } catch { /* no spending data */ }

  // 4. Backlog state — what's queued, blocked, in progress
  try {
    const { loadBacklog } = await import("./backlog.ts");
    const backlog = await loadBacklog();
    const counts: Record<string, any> = {};
    for (const lane of ["backlog", "queued", "blocked", "inProgress", "done"]) {
      counts[lane] = (backlog[lane] || []).length;
    }
    // @ts-expect-error — migrate to proper types
    const blockedItems = (backlog.blocked || []).map(i => `"${i.title || i}"`).slice(0, 5);
    contextSections.push([
      "## Backlog State",
      `Backlog: ${counts.backlog} | Queued: ${counts.queued} | Blocked: ${counts.blocked} | In Progress: ${counts.inProgress} | Done: ${counts.done}`,
      blockedItems.length > 0 ? `Blocked items: ${blockedItems.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  } catch { /* no backlog data */ }

  // 5. Agent memory — learned prevention rules (WHEN/CHECK/BECAUSE)
  try {
    const { loadAgentMemory } = await import("./agent-memory.ts");
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
  } catch { /* no agent memory */ }

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
  } catch { /* no config files */ }

  // 7. Feedback files — current operator guidance
  try {
    const feedbackSummary = [];
    for (const target of ["to-planner", "to-executor", "to-skeptic"]) {
      const content = await readFile(join(CONFIG_PATH, `feedback/${target}.md`), "utf-8");
      const lineCount = content.split("\n").length;
      feedbackSummary.push(`- **${target}.md**: ${lineCount} lines`);
    }
    contextSections.push(`## Operator Feedback Files\n${feedbackSummary.join("\n")}`);
  } catch { /* no feedback files */ }

  // 8. Recent proposals — so Meta doesn't re-propose the same things
  try {
    // @ts-expect-error — migrate to proper types
    const recent = await listProposals();
    if (recent.length > 0) {
      const proposalLines = recent.slice(0, 15).map(p =>
        `- [${p.status}] "${p.title}" → ${p.targetFile || "?"} (${p.risk} risk)${p.status === "rejected" ? ` — rejected: ${p.rejectionReason || "no reason"}` : ""}${p.applied === "true" ? " — APPLIED" : ""}`
      );
      contextSections.push(`## Recent Proposals (do NOT re-propose these)\n${proposalLines.join("\n")}\n\nDo not propose anything that duplicates or closely resembles an existing approved, applied, or rejected proposal. If a proposal was rejected, do not re-propose it unless you have new evidence that was not available when it was rejected.`);
    }
  } catch { /* no proposals */ }

  // 9. System architecture summary
  contextSections.push([
    "## System Architecture",
    "Hydra runs a 3-agent control loop on the hydra-betting codebase:",
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
      try { metaOutput = JSON.parse(match[0]); } catch {}
    }
  }

  const createdProposals = [];
  for (const proposal of metaOutput.proposals || []) {
    const created = await createProposal(proposal, event?.correlationId, eventBus);
    createdProposals.push(created);

    if (created.type === "personality" && created.risk === "low") {
      console.log(`[Meta] Auto-approving low-risk personality proposal ${created.proposalId}: ${created.title}`);
      await approveProposal(created.proposalId, eventBus);
    }
  }

  console.log(`[Meta] Created ${createdProposals.length} proposals (${createdProposals.filter(p => p.status === "approved").length} auto-approved)`);
  return { metaOutput, proposals: createdProposals };
}

/**
 * Create a proposal and store it in Redis.
 */
async function createProposal(proposal, correlationId, eventBus) {
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

  // Attempt to auto-apply the proposal
  let applicationResult = { applied: false, reason: "skipped" };
  try {
    // @ts-expect-error — migrate to proper types
    applicationResult = await applyProposal(record);
    record.applied = applicationResult.applied ? "true" : "false";
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
  let backlogItemId = null;
  if (!applicationResult.applied) {
    try {
      const { addToBacklog } = await import("./backlog.ts");
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
        backlogItemId = result.id;
        record.backlogItemId = result.id;
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
async function listProposals(status) {
  const r = getRedis();
  const ids = await r.zrevrange(INDEX_KEY, 0, -1);
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
  const r = getRedis();
  const ids = await r.zrange(INDEX_KEY, 0, -1);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const id of ids) {
    const p = await getProposal(id);
    if (!p) { await r.zrem(INDEX_KEY, id); continue; }
    if (p.status === "rejected" || p.status === "approved") {
      const ts = new Date(p.rejectedAt || p.approvedAt || p.createdAt).getTime();
      if (ts < cutoff) {
        await r.del(proposalKey(id));
        await r.zrem(INDEX_KEY, id);
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
};
