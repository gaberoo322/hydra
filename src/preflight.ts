// ---------------------------------------------------------------------------
// Preflight, high-risk review, and skeptic agent logic
// Extracted from control-loop.ts — deterministic gates + nano-model safety review
// ---------------------------------------------------------------------------

import { runAgent, findPersonality } from "./codex-runner.ts";
import { loadAgentMemory, formatMemoryForPrompt } from "./agent-memory.ts";
import { getTracker } from "./task-tracker.ts";

// ---------------------------------------------------------------------------
// Operator-blocked detection
// ---------------------------------------------------------------------------
//
// When a cycle fails, check if the failure pattern suggests the operator
// needs to intervene (missing API key, auth failure, etc.) rather than
// retrying the same work. If detected, route to the Blocked lane instead
// of returning to Backlog where it would just fail again.

export const BLOCKED_PATTERNS = [
  /api[_ ]?key/i,
  /unauthorized/i,
  /authentication.*fail/i,
  /EACCES/,
  /permission denied/i,
  /credentials/i,
  /secret.*missing/i,
  /token.*expired/i,
  /env.*not set/i,
  /missing.*env/i,
  /CORS.*blocked/i,
  /rate.*limit.*exceeded/i,
  /quota.*exceeded/i,
  /subscription.*required/i,
  /DATABASE_URL/,
  /KALSHI_API/,
  /POLYMARKET_API/,
  /ODDS_API/,
  /expected string.*received undefined/i,
  /Invalid input.*expected.*string/i,
  /ECONNREFUSED.*5432/,  // Postgres connection refused
  /connection.*refused.*database/i,
];

export function looksOperatorBlocked(verification) {
  if (!verification?.steps) return null;
  for (const step of verification.steps) {
    if (step.passed) continue;
    const output = (step.stderr || "") + " " + (step.stdout || "");
    for (const pattern of BLOCKED_PATTERNS) {
      const match = output.match(pattern);
      if (match) {
        return `${step.label}: ${match[0]}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan-vs-actual reconciliation (PAUL UNIFY pattern)
// ---------------------------------------------------------------------------
//
// After verification passes, diff the planned scope (task.scopeBoundary.in)
// against the actual files changed (verification.filesChanged). This catches:
//   - Scope creep: executor touched files outside the plan
//   - Scope gaps: planned files that weren't modified (potentially incomplete)
//
// Test files (.test.) are excluded from both checks: test creation is always
// expected and test gaps are benign (test files may not need modification).
//
// Results are informational (logged + included in reality report), not
// blocking — the merge proceeds regardless. If scope creep is detected,
// a prevention rule is recorded for the planner.

export function reconcilePlanVsActual(task, verification) {
  const plannedFiles = new Set(task.scopeBoundary?.in || []);
  const actualFiles = new Set(verification.filesChanged || []);

  const result = {
    scopeCreep: [],
    scopeGaps: [],
    aligned: true,
    warnings: [],
  };

  // Skip reconciliation if planner didn't specify a scope (nothing to compare)
  if (plannedFiles.size === 0) {
    return result;
  }

  // Scope creep: actual files not in planned scope (test files excluded — always OK)
  for (const f of actualFiles) {
    if (plannedFiles.has(f)) continue;
    // @ts-expect-error — migrate to proper types
    if (f.includes(".test.")) continue;
    result.scopeCreep.push(f);
  }

  // Scope gaps: planned source files (not test files) that weren't changed
  for (const f of plannedFiles) {
    if (actualFiles.has(f)) continue;
    // @ts-expect-error — migrate to proper types
    if (f.includes(".test.")) continue;
    result.scopeGaps.push(f);
  }

  if (result.scopeCreep.length > 0) {
    result.warnings.push(`Scope creep: ${result.scopeCreep.length} file(s) changed outside planned scope: ${result.scopeCreep.join(", ")}`);
    result.aligned = false;
  }
  if (result.scopeGaps.length > 0) {
    result.warnings.push(`Potentially incomplete: ${result.scopeGaps.length} planned file(s) not modified: ${result.scopeGaps.join(", ")}`);
    result.aligned = false;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scope-adaptive planning — classify task complexity (PAUL pattern)
// ---------------------------------------------------------------------------
//
// PAUL auto-routes by complexity: quick-fix gets compressed ceremony (skip
// skeptic, lighter planner prompt), standard gets full ceremony, complex
// logs a warning. The classification runs AFTER the planner outputs a task
// so we have scopeBoundary and acceptanceCriteria to measure.
//
// Anchor-level pre-routing: only failing-test anchors are inherently
// quick-fix (narrow scope, known target, deterministic fix). Prior-failure
// anchors get full ceremony since the previous approach already failed.
// These also get a cheaper planner model and compressed prompt (see runPlannerAgent).

export function classifyTaskComplexity(task, anchor) {
  // Only genuinely targeted anchors skip ceremony
  if (anchor.type === "failing-test") {
    return "quick-fix";
  }

  const filesInScope = task.scopeBoundary?.in?.length || 0;
  const criteriaCount = task.acceptanceCriteria?.length || 0;

  // Quick-fix: single-file, minimal criteria only
  if (filesInScope <= 1 && criteriaCount <= 2) {
    return "quick-fix";
  }

  // Complex: large scope — warn, may benefit from splitting
  if (filesInScope > 5 || criteriaCount > 8) {
    return "complex";
  }

  return "standard";
}

// ---------------------------------------------------------------------------
// Deterministic preflight checklist — replaces the skeptic agent for low/medium risk
// Catches: duplicates, scope issues, grounding contradictions, verification gaps
// ---------------------------------------------------------------------------

export async function preflightCheck(task, grounding, groundingSummary) {
  const flags: string[] = [];

  // 1. Duplicate check — compare against recent cycle history in Redis
  try {
    const r = getTracker().redis;
    const recentIds = await r.zrevrange("hydra:reports:reality:index", 0, 9);
    for (const id of recentIds) {
      const raw = await r.get(`hydra:reports:reality:${id}`);
      if (!raw) continue;
      const report = JSON.parse(raw);
      const priorTitle = report.task?.title || "";
      const priorState = report.task?.finalState || "";

      // Skip merged tasks — it's valid to do related work after a merge
      if (priorState === "merged") continue;

      // Word overlap similarity (same algorithm as detectDrift)
      const currentWords = new Set(task.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      const priorWords = new Set(priorTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      if (currentWords.size > 0 && priorWords.size > 0) {
        const intersection = [...currentWords].filter((w) => priorWords.has(w));
        const similarity = intersection.length / Math.max(currentWords.size, priorWords.size);
        if (similarity > 0.7) {
          flags.push(`duplicate of recent abandoned cycle ${id} ("${priorTitle}", ${Math.round(similarity * 100)}% similar)`);
          break;
        }
      }
    }
  } catch (err: any) {
    console.error(`[Preflight] Duplicate check failed: ${err.message}`);
  }

  // 2. Scope check — reject >10 files (architecture theater)
  const filesInScope = task.scopeBoundary?.in?.length || 0;
  if (filesInScope > 10) {
    flags.push(`scope too broad: ${filesInScope} files (max 10)`);
  }

  // 3. Grounding contradiction — tests are failing but task is not fixing them
  //    Also allow tasks that look like test fixes even if they came from the
  //    work queue (anchorType "user-request") — the operator queued them to fix tests.
  const testFixAnchorTypes = new Set(["failing-test", "prior-failure", "reframe"]);
  const looksLikeTestFix = /\b(fix|repair|isolat|failing|broken)\b.*\btest/i.test(task.title || "")
    || /\btest.*\b(fix|repair|isolat|failing|broken)\b/i.test(task.title || "");
  if (grounding.testReport.failed > 0 && !testFixAnchorTypes.has(task.anchorType) && !looksLikeTestFix) {
    flags.push(`${grounding.testReport.failed} test(s) currently failing but task is not fixing them — fix tests first`);
  }

  // 4. Verification plan sanity — each step must have a command
  const badSteps = (task.verificationPlan || []).filter((s) => !s.command || typeof s.command !== "string");
  if (badSteps.length > 0) {
    flags.push(`${badSteps.length} verification step(s) missing a command`);
  }

  return { pass: flags.length === 0, flags };
}

// ---------------------------------------------------------------------------
// Lightweight nano-model review — only for high-risk tasks
// Narrow prompt: "does grounding contradict this change?"
// Uses nano tier (~$0.20/1M tokens) instead of codex (~$1.75/1M)
// ---------------------------------------------------------------------------

export async function runHighRiskReview(cycleId, task, grounding, groundingSummary, ovSession = null) {
  const prompt = [
    `You are a safety reviewer for an autonomous coding system.`,
    `A high-risk task is about to be executed. Your job is to check whether the grounding report contradicts this change.`,
    ``,
    `## TASK`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Risk: ${task.risk}`,
    `Scope: ${JSON.stringify(task.scopeBoundary?.in || [])}`,
    `Verification: ${JSON.stringify(task.verificationPlan || [])}`,
    ``,
    `## GROUNDING (current repo state)`,
    groundingSummary.slice(0, 1500),
    ``,
    `## YOUR CHECK`,
    `Answer these questions:`,
    `1. Does the grounding report show evidence that contradicts this task being safe?`,
    `2. Does the verification plan actually cover the high-risk paths being changed?`,
    `3. Are there failing tests that this task could make worse?`,
    ``,
    `If you find a SPECIFIC contradiction or safety concern, reject. Otherwise approve.`,
    `Do NOT reject for stylistic or scope-narrowing reasons — only for safety.`,
    ``,
    `Output ONLY valid JSON:`,
    `{ "verdict": "approve" | "reject", "reason": "..." }`,
  ].join("\n");

  const personality = await findPersonality("skeptic");

  const result = await runAgent({
    agentName: "skeptic",
    personality,
    prompt,
    model: "nano",
    taskId: "high-risk-review",
    correlationId: cycleId,
  });

  let verdict = { verdict: "approve", reason: "High-risk review produced no parseable output — defaulting to approve (verification will catch issues)" };
  try {
    verdict = JSON.parse(result.output);
  } catch {
    const match = result.output?.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        verdict = JSON.parse(match[0]);
      } catch (err: any) {
        console.error(`[ControlLoop] High-risk review output unparseable — defaulting to approve: ${err.message}`);
      }
    }
  }

  await getTracker().logAgentRun(cycleId, "skeptic", "high-risk-review", result.duration, verdict.verdict, result.usage, result.costUsd);
  return verdict;
}

// ---------------------------------------------------------------------------
// Legacy skeptic agent — kept for reference but no longer called by the control loop.
// The preflight + high-risk review pipeline above replaces it.
// ---------------------------------------------------------------------------

export async function runSkepticAgent(cycleId, task, grounding, groundingSummary, ovSession = null) {
  // Load skeptic memory + OV context in parallel
  const [skepticMemory, ovCtx] = await Promise.all([
    loadAgentMemory("skeptic"),
    ovSession?.getAgentContext?.("skeptic", { reference: task.title, whyNow: task.anchorReference }) || Promise.resolve({ formatted: "" }),
  ]);
  const skepticKnowledge = ovCtx.formatted || "";
  let recentHistory = "";
  try {
    const Redis = (await import("ioredis")).default;
    const rConn = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
    const recentIds = await rConn.zrevrange("hydra:reports:reality:index", 0, 4);
    for (const id of recentIds) {
      const raw = await rConn.get(`hydra:reports:reality:${id}`);
      if (raw) {
        const report = JSON.parse(raw);
        recentHistory += `- ${report.cycleId}: "${report.task?.title}" (${report.task?.finalState})\n`;
      }
    }
    rConn.disconnect();
  } catch (err: any) {
    console.error(`[ControlLoop] Skeptic failed to load recent cycle history: ${err.message}`);
  }

  const prompt = [
    `You are the Skeptic. Your job is to CHALLENGE this proposed task. You have VETO power.`,
    "",
    `## PROPOSED TASK`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Anchor: [${task.anchorType}] ${task.anchorReference}`,
    task.anchorType === "doc" ? `(NOTE: This is a config document maintained by the operator. It exists outside the workspace but IS a valid anchor.)` : "",
    task.anchorType === "codebase-health" ? `(NOTE: This is a codebase health task. The goal is REDUCTIVE — make the codebase smaller, more modular, or better documented. Do NOT add new functionality. Validate that the proposed change genuinely improves maintainability.)` : "",
    `Why now: ${task.whyNow}`,
    `Confidence: ${task.confidence}`,
    `Scope: IN=${JSON.stringify(task.scopeBoundary?.in || [])} OUT=${JSON.stringify(task.scopeBoundary?.out || [])}`,
    `Acceptance Criteria: ${JSON.stringify(task.acceptanceCriteria || [])}`,
    `Verification Plan: ${JSON.stringify(task.verificationPlan || [])}`,
    "",
    groundingSummary.slice(0, 2000),
    "",
    recentHistory ? `## RECENT CYCLE HISTORY (check for duplicates)\n${recentHistory}` : "",
    "",
    formatMemoryForPrompt(skepticMemory, "skeptic"),
    "",
    skepticKnowledge,
    "",
    `## YOUR CHALLENGE CHECKLIST`,
    `1. Is this task ANCHORED to real evidence? (not inferred strategy)`,
    `2. Is this a DUPLICATE of recent work? (check history above)`,
    `3. Is the scope BOUNDED? (not too broad, not architecture theater)`,
    `4. Does the verificationPlan actually PROVE completion?`,
    `5. Is this the SMALLEST useful task? (could it be narrower?)`,
    `6. Does the grounding report support this being needed?`,
    "",
    `Output ONLY valid JSON:`,
    `{ "verdict": "approve" | "reject", "reason": "..." }`,
  ].filter(Boolean).join("\n");

  const personality = await findPersonality("skeptic");

  const result = await runAgent({
    agentName: "skeptic",
    personality,
    prompt,
    model: "codex",
    taskId: "skeptic",
    correlationId: cycleId,
  });

  let verdict = { verdict: "reject", reason: "Skeptic produced no parseable output — fail safe" };
  try {
    verdict = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        verdict = JSON.parse(match[0]);
      } catch (err: any) {
        console.error(`[ControlLoop] Skeptic output unparseable even after regex — failing safe to reject: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Skeptic output contained no JSON object — failing safe to reject`);
    }
  }

  await getTracker().logAgentRun(cycleId, "skeptic", "skeptic", result.duration, verdict.verdict, result.usage, result.costUsd);
  return verdict;
}
