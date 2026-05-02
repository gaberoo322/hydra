/**
 * planner-prompt.ts — Planner agent prompt construction, schema, and validation.
 *
 * Extracted from control-loop.ts. Contains:
 * - PLANNER_OUTPUT_SCHEMA (JSON Schema for structured planner output)
 * - VALID_RISK_VALUES
 * - validateTaskSchema() — deterministic schema validation
 * - buildResearchContext() — formats research context for planner prompt
 * - runPlannerAgent() — full planner agent orchestration
 *
 * Depends on: codex-runner, agent-memory, plan-cache, metrics, task-tracker,
 *             grounding (summarizeForPrompt), backlog (dynamic import)
 */

import { runAgent, findPersonality } from "./codex-runner.ts";
import { formatMemoryForPrompt } from "./agent-memory.ts";
import { getCachedPlan, cachePlan } from "./plan-cache.ts";
import { getTracker } from "./task-tracker.ts";
import { summarizeForPrompt } from "./grounding.ts";
import { buildPlannerContext } from "./context-builder.ts";
import type { PlannerContext } from "./context-builder.ts";

// ---------------------------------------------------------------------------
// Deterministic task schema validation — replaces LLM-based structural checks
// ---------------------------------------------------------------------------

const VALID_RISK_VALUES = ["low", "medium", "high"];

// JSON Schema for structured planner output — passed to Codex SDK's outputSchema
// to eliminate parsing failures and ensure valid JSON on every call.
// OpenAI structured output requires: additionalProperties=false on every object,
// ALL properties in required (use ["type", "null"] for optional fields).
export const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    noWork: { type: "boolean" },
    reason: { type: ["string", "null"] },
    title: { type: "string" },
    description: { type: "string" },
    taskType: { type: "string", enum: ["build", "fix", "test", "refactor", "docs"] },
    anchorType: { type: "string" },
    anchorReference: { type: "string" },
    whyNow: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    scopeBoundary: {
      type: "object",
      additionalProperties: false,
      properties: {
        in: { type: "array", items: { type: "string" } },
        out: { type: "array", items: { type: "string" } },
      },
      required: ["in", "out"],
    },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    verificationPlan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          expected: { type: "string" },
          label: { type: "string" },
        },
        required: ["command", "expected", "label"],
      },
    },
  },
  required: [
    "noWork", "reason", "title", "description", "taskType",
    "anchorType", "anchorReference", "whyNow", "confidence", "risk",
    "scopeBoundary", "acceptanceCriteria", "verificationPlan",
  ],
};

export function validateTaskSchema(task) {
  const errors: string[] = [];

  if (!task.verificationPlan || !Array.isArray(task.verificationPlan) || task.verificationPlan.length === 0) {
    errors.push("missing or empty verificationPlan");
  }
  if (!task.risk || !VALID_RISK_VALUES.includes(task.risk)) {
    errors.push(`missing or invalid risk classification (got "${task.risk || "undefined"}", need low|medium|high)`);
  }
  if (!task.scopeBoundary?.in || !Array.isArray(task.scopeBoundary.in) || task.scopeBoundary.in.length === 0) {
    errors.push("missing scopeBoundary.in (no files specified)");
  }
  if (!task.anchorType) {
    errors.push("missing anchorType");
  }
  if (!task.anchorReference) {
    errors.push("missing anchorReference");
  }
  if (!task.acceptanceCriteria || !Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
    errors.push("missing or empty acceptanceCriteria");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Research context formatter — gives the planner rich context from research
// ---------------------------------------------------------------------------

export function buildResearchContext(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = ["\n## RESEARCH CONTEXT (from research system — use this to guide your task)"];
  if (ctx.description) parts.push(`\n### What to build\n${ctx.description}`);
  if (ctx.rationale) parts.push(`\n### Why (research rationale)\n${ctx.rationale}`);
  if (ctx.acceptanceCriteria?.length > 0) {
    parts.push("\n### Acceptance Criteria (from research — incorporate into your task)");
    for (const c of ctx.acceptanceCriteria) parts.push(`- ${c}`);
  }
  if (ctx.complexity) parts.push(`\n### Estimated complexity: ${ctx.complexity}`);
  if (ctx.prerequisites?.length > 0) {
    parts.push(`\n### Prerequisites: ${ctx.prerequisites.join(", ")}`);
  }
  if (ctx.category) parts.push(`\n### Focus category: ${ctx.category}`);
  if (ctx.confidence) parts.push(`### Research confidence: ${ctx.confidence}`);
  if (ctx.adjustedScore) parts.push(`### Research score: ${ctx.adjustedScore}`);
  if (ctx.sources?.length > 0) parts.push(`### Identified by: ${ctx.sources.join(", ")} researchers`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Priorities formatter — puts TODOs first, caps completed list
// Prevents the completed list from dominating context and making the planner
// conclude "all work is done" when there are still active priorities.
// ---------------------------------------------------------------------------

function formatPrioritiesForPlanner(priorities: string, mode: "standard" | "reframe" = "standard"): string {
  // Split into sections: everything before "completed" and everything after
  const completedIdx = priorities.toLowerCase().indexOf("# what's been completed");
  const notWorkIdx = priorities.toLowerCase().indexOf("# what not to work on");

  let todoSection = priorities;
  let completedSection = "";
  let notWorkSection = "";

  if (completedIdx > 0) {
    todoSection = priorities.slice(0, completedIdx);
    const afterCompleted = priorities.slice(completedIdx);
    if (notWorkIdx > completedIdx) {
      completedSection = priorities.slice(completedIdx, notWorkIdx);
      notWorkSection = priorities.slice(notWorkIdx);
    } else {
      completedSection = afterCompleted;
    }
  } else if (notWorkIdx > 0) {
    todoSection = priorities.slice(0, notWorkIdx);
    notWorkSection = priorities.slice(notWorkIdx);
  }

  // Cap completed items to 5 to prevent context domination
  if (completedSection) {
    const lines = completedSection.split("\n");
    const headerLine = lines[0];
    const items = lines.slice(1).filter((l) => l.trim().startsWith("-"));
    if (items.length > 5) {
      completedSection = [
        headerLine,
        ...items.slice(0, 5),
        `- ... and ${items.length - 5} more (omitted to save context)`,
      ].join("\n");
    }
  }

  const header = mode === "reframe"
    ? "## CURRENT PRIORITIES (reframe toward one of these if the original goal is no longer viable)"
    : "## PRIORITIES — ACTIVE WORK (these need tasks proposed)";

  return [
    header,
    todoSection.slice(0, 2500),
    "",
    completedSection ? completedSection.slice(0, 500) : "",
    notWorkSection ? notWorkSection.slice(0, 500) : "",
  ].filter(Boolean).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Planner agent — proposes 1 bounded task from an anchor
// ---------------------------------------------------------------------------

export async function runPlannerAgent(cycleId, anchor, grounding, ovSession = null) {
  // Scope-adaptive planner routing (PAUL pattern):
  // Quick-fix anchors (failing-test, prior-failure) get a compressed prompt
  // and cheaper model — they don't need priorities, accomplishments, or
  // continuity because the anchor IS the entire scope.
  const isQuickFixAnchor = anchor.type === "failing-test" || anchor.type === "prior-failure";
  const isReframe = anchor.type === "reframe";
  const plannerModel = isQuickFixAnchor ? "codex" : "frontier";

  // Plan cache — skip LLM call for recurring task patterns
  const cachedTask = await getCachedPlan(anchor, grounding);
  if (cachedTask) {
    cachedTask.__plannerModel = "cached";
    cachedTask.__planCacheHit = true;
    await getTracker().logAgentRun(cycleId, "planner", "planner", 0, "cache-hit", {}, 0);
    return cachedTask;
  }

  // Load all context sources via context-builder (centralized, with graceful degradation)
  const ctx = await buildPlannerContext(anchor, grounding, ovSession);
  if (ctx.warnings.length > 0) {
    console.log(`[ControlLoop] Planner context loaded with ${ctx.warnings.length} warning(s): ${ctx.warnings.join("; ")}`);
  }
  const { priorities, feedback, plannerMemory, ovContext, milestoneContext, accomplishmentsContext, groundingSummary, continuityContext } = ctx;

  const confidence = grounding.testReport.failed > 0 ? "low"
    : (grounding.typecheckReport.exitCode !== 0 || grounding.dirtyFiles.length > 0) ? "medium"
    : "high";

  // JSON output schema (shared by both prompt paths)
  const jsonSchema = [
    `Output ONLY valid JSON:`,
    `{`,
    `  "title": "...",`,
    `  "description": "...",`,
    `  "taskType": "build",`,
    `  "anchorType": "${anchor.type}",`,
    `  "anchorReference": "${anchor.reference}",`,
    `  "whyNow": "...",`,
    `  "confidence": "${confidence}",`,
    `  "scopeBoundary": { "in": ["file1.ts", "file2.ts"], "out": ["unrelated/"] },`,
    `  "acceptanceCriteria": ["criterion 1", "criterion 2"],`,
    `  "verificationPlan": [`,
    `    { "command": "npm test", "expected": "exit code 0", "label": "tests pass" },`,
    `    { "command": "npm run typecheck", "expected": "exit code 0", "label": "typecheck" }`,
    `  ]`,
    `  NOTE: Use simple "npm test" and "npm run typecheck" — the verifier runs them in the correct app directory automatically.`,
    `}`,
  ].join("\n");

  let prompt;
  if (isReframe) {
    // Reframe prompt — a task failed multiple times, planner must diagnose and rewrite
    const ctx = anchor.context || {};
    const compactGrounding = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
    prompt = [
      `## REFRAME THIS TASK (previous approach failed ${ctx.totalAttempts || "multiple"} times)`,
      "",
      `### Original task that kept failing`,
      `Title: ${ctx.originalTitle || anchor.reference}`,
      ctx.originalDescription ? `Description: ${ctx.originalDescription}` : "",
      ctx.scopeBoundary ? `Scope: ${JSON.stringify(ctx.scopeBoundary)}` : "",
      "",
      `### Failure history`,
      `Total attempts: ${ctx.totalAttempts || "unknown"}`,
      `Last failure reason: ${ctx.lastReason || "unknown"}`,
      ctx.failedSteps?.length > 0 ? `Failed verification steps: ${ctx.failedSteps.join(", ")}` : "",
      ctx.verificationStderr ? `\nVerification error output:\n\`\`\`\n${ctx.verificationStderr.slice(0, 1000)}\n\`\`\`` : "",
      ctx.failureHistory?.length > 0 ? `\nAll attempts:\n${ctx.failureHistory.map((f, i) => `  ${i + 1}. ${f.reason} (${f.failedSteps?.join(", ") || "no details"})`).join("\n")}` : "",
      "",
      compactGrounding,
      "",
      `## INSTRUCTIONS`,
      `The previous task kept failing verification. You must DIAGNOSE why and propose a DIFFERENT approach.`,
      ``,
      `Possible root causes to consider:`,
      `- The original scope was too broad or touched files that interact in unexpected ways`,
      `- There was a pre-existing test failure unrelated to the task`,
      `- The acceptance criteria were impossible to satisfy with the verification plan`,
      `- The executor's approach was correct but a different file or test needed updating`,
      ``,
      `Your job:`,
      `1. Analyze the failure pattern — what specifically went wrong each time?`,
      `2. Propose a REFRAMED task with a different scope, approach, or decomposition`,
      `3. If the original goal is still valid, find a smaller or different path to achieve it`,
      `4. If the original goal is blocked by something outside the executor's control (e.g. pre-existing test failures, missing credentials), output { "noWork": true, "reason": "..." } explaining what the operator needs to fix`,
      ``,
      `The reframed task must be meaningfully different from the original — not just a retry with the same scope.`,
      "",
      // Include priorities so the planner knows what work remains
      priorities ? formatPrioritiesForPlanner(priorities, "reframe") : "",
      // Include accomplishments so the planner doesn't re-propose completed work
      accomplishmentsContext,
      "",
      jsonSchema,
    ].filter(Boolean).join("\n");
    console.log(`[ControlLoop] Planner using REFRAME prompt for "${ctx.originalTitle}" (${ctx.totalAttempts} prior failures)`);
  } else if (isQuickFixAnchor) {
    // Compressed prompt for quick-fix: just anchor + compact grounding + fix instructions
    const compactGrounding = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
    prompt = [
      `## FIX THIS (quick-fix — targeted repair, minimal scope)`,
      `Type: ${anchor.type}`,
      `Reference: ${anchor.reference}`,
      `Why now: ${anchor.whyNow}`,
      anchor.description ? `\nDescription:\n${anchor.description.slice(0, 1500)}` : "",
      anchor.context ? `\nContext:\n${typeof anchor.context === "string" ? anchor.context.slice(0, 1500) : JSON.stringify(anchor.context).slice(0, 1500)}` : "",
      "",
      compactGrounding,
      "",
      `## INSTRUCTIONS`,
      `This is a targeted fix. Produce exactly 1 task with the SMALLEST change that resolves the issue.`,
      `The task MUST be anchored to "${anchor.reference}".`,
      `Keep scopeBoundary narrow — ideally 1-2 files.`,
      "",
      jsonSchema,
    ].filter(Boolean).join("\n");
    console.log(`[ControlLoop] Planner using quick-fix prompt (${plannerModel} model, ~${prompt.length} chars)`);
  } else {
    // Full prompt for standard/complex tasks
    prompt = [
      `## ANCHOR (this is what you are working on)`,
      `Type: ${anchor.type}`,
      `Reference: ${anchor.reference}`,
      `Why now: ${anchor.whyNow}`,
      anchor.description ? `\nDescription:\n${anchor.description.slice(0, 2000)}` : "",
      anchor.context && anchor.type === "research" ? buildResearchContext(anchor.context) : "",
      // Spec-anchored tasks get the full spec context (task list, progress, what to do next)
      anchor.context?._specPromptContext ? `\n${anchor.context._specPromptContext}\n` : "",
      anchor.context && !anchor.context?._specPromptContext && anchor.type !== "research" ? `\nContext:\n${typeof anchor.context === "string" ? anchor.context.slice(0, 2000) : JSON.stringify(anchor.context).slice(0, 2000)}` : "",
      anchor.type === "codebase-health" ? [
        "",
        "## CODEBASE HEALTH GUIDELINES",
        "This is a maintainability task. Your goal is REDUCTIVE — make the codebase smaller, more modular, and better documented.",
        "Rules:",
        "- Split large files into focused modules with clear single responsibilities",
        "- Add a brief JSDoc header to every new module explaining: what it does, what depends on it, key constraints",
        "- Use index.ts re-exports to maintain existing import paths (no breaking changes)",
        "- Do NOT add new functionality, features, or abstractions beyond what exists",
        "- Do NOT add error handling, validation, or defensive code that wasn't there before",
        "- The test count should stay the same or decrease (consolidate redundant tests, don't add new ones)",
        "- Keep every existing import path working — consumers should not need to change",
      ].join("\n") : "",
      "",
      groundingSummary.slice(0, 4000),
      "",
      // Continuity contract — what the last cycle did, what changed since.
      // Increased from 1500 to 2500 to accommodate Recent Failures reflections.
      continuityContext ? continuityContext.slice(0, 2500) : "",
      "",
      priorities ? formatPrioritiesForPlanner(priorities) : "",
      feedback ? `## OPERATOR FEEDBACK\n${feedback.slice(0, 1000)}\n` : "",
      "",
      // Milestone context — focus on active milestone epics
      milestoneContext,
      // Cumulative accomplishments — prevent re-proposing completed work
      accomplishmentsContext,
      "",
      // Agent memory — learn from past outcomes
      formatMemoryForPrompt(plannerMemory, "planner"),
      "",
      // OpenViking compiled context (resources + memories relevant to this anchor)
      ovContext,
      "",
      `## INSTRUCTIONS`,
      `Confidence: ${confidence.toUpperCase()}. Produce exactly 1 task, or null if no actionable work exists.`,
      `The task MUST be anchored to "${anchor.reference}".`,
      `Prefer the SMALLEST code change that creates verifiable progress.`,
      `Do NOT produce architecture docs, design contracts, or research tasks unless the anchor explicitly requires it.`,
      `If the ALREADY ACCOMPLISHED list covers all priorities and you cannot find a genuine gap, output: { "noWork": true, "reason": "All current priorities appear addressed" }`,
      "",
      jsonSchema,
    ].filter(Boolean).join("\n");
  }

  const personality = await findPersonality("planner");

  const result = await runAgent({
    agentName: "planner",
    personality,
    prompt,
    model: plannerModel,
    taskId: "planner",
    correlationId: cycleId,
    outputSchema: PLANNER_OUTPUT_SCHEMA,
  });

  // Detect Codex usage-limit errors — signal the caller to pause instead of retrying
  if (result.usageLimitHit) {
    console.error(`[ControlLoop] Codex usage limit hit during planning — signaling pause`);
    // Return a sentinel object that the caller can detect
    return { __usageLimitHit: true } as any;
  }

  // Parse output — try direct parse, then regex fallback, then fail loud
  let task = null;
  try {
    task = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        task = JSON.parse(match[0]);
      } catch (err: any) {
        console.error(`[ControlLoop] Planner output unparseable even after regex extraction: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Planner output contained no JSON object`);
    }
  }

  // Handle explicit "no work" response
  if (task?.noWork) {
    console.log(`[ControlLoop] Planner says no work needed: ${task.reason || "all priorities addressed"}`);
    await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "no-work", result.usage, result.costUsd);
    return null;
  }

  // Validate required fields — deterministic schema check ($0, 0ms)
  // Catches missing risk, scope, anchor, criteria BEFORE any agent call.
  if (task) {
    // Auto-fix empty scopeBoundary.in by inferring from description/title
    if (task.scopeBoundary && (!task.scopeBoundary.in || task.scopeBoundary.in.length === 0)) {
      const inferredFiles: string[] = [];
      const text = `${task.title || ""} ${task.description || ""}`;
      // Extract file paths from the task text (e.g. "src/lib/foo.ts")
      const pathMatches = text.match(/(?:web\/)?(?:src\/[\w\-\/]+\.(?:ts|tsx|js|jsx|mts|sql))/g);
      if (pathMatches) {
        inferredFiles.push(...new Set(pathMatches));
      }
      if (inferredFiles.length > 0) {
        task.scopeBoundary.in = inferredFiles;
        console.log(`[ControlLoop] Auto-inferred scopeBoundary.in from task text: ${inferredFiles.join(", ")}`);
      }
    }

    const schemaErrors = validateTaskSchema(task);
    if (schemaErrors.length > 0) {
      console.log(`[ControlLoop] Planner task rejected — schema validation: ${schemaErrors.join("; ")}`);
      return null;
    }
  }

  await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "completed", result.usage, result.costUsd);
  if (task) task.__plannerModel = result.model;

  // Store in plan cache for future reuse
  if (task) {
    await cachePlan(anchor, task, grounding).catch((err) =>
      console.error(`[PlanCache] Store failed: ${err.message}`));
  }

  return task;
}
