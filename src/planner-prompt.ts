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
import { getContext } from "./learning.ts";
import { getCachedPlan, cachePlan, recordPlanCacheMiss } from "./plan-cache.ts";
import { getTracker } from "./task-tracker.ts";
import { summarizeForPrompt } from "./grounding.ts";
import { buildPlannerContext, reflectionMatchSource } from "./context-builder.ts";
import type { PlannerContext } from "./context-builder.ts";
import { isAnchorActionable } from "./anchor-actionability.ts";

// Mirror of the cacheable-anchor-types set in plan-cache.ts. Kept here as a
// local constant so the bookkeeping-miss attribution (issue #363) doesn't
// have to round-trip into Redis just to ask "would this anchor have been
// cached if reached?". MUST stay in sync with the CACHEABLE_TYPES Set in
// src/plan-cache.ts — if you add a type there, add it here too.
const PLAN_CACHEABLE_TYPES = new Set([
  "user-request",
  "codebase-health",
  "failing-test",
  "research",
]);

// ---------------------------------------------------------------------------
// Deterministic task schema validation — replaces LLM-based structural checks
// ---------------------------------------------------------------------------

const VALID_RISK_VALUES = ["low", "medium", "high"];

/**
 * Minimum length for a `noWork` diagnostic reason (issue #364).
 *
 * 12/18 abandonments in the issue-#364 window were the "Planner produced no
 * task" branch — frontier-model calls that returned empty/malformed JSON
 * instead of the documented structured noWork shape from `to-planner.md`.
 * Enforcing a 20-char floor on `reason` blocks "n/a", "no", "blocked" etc.
 * and forces the planner to name what was inspected and why it failed, so
 * downstream telemetry (abandonment breakdown, reframe queue, OV memory)
 * has actionable diagnostic text instead of silent churn.
 *
 * Exported so tests can assert on the same threshold the validator uses.
 */
export const NOWORK_REASON_MIN_LENGTH = 20;

// JSON Schema for structured planner output — passed to Codex SDK's outputSchema
// to eliminate parsing failures and ensure valid JSON on every call.
// OpenAI structured output requires: additionalProperties=false on every object,
// ALL properties in required (use ["type", "null"] for optional fields).
//
// Issue #364 — `reason` is required and non-nullable (was previously
// `["string", "null"]`). The model MUST emit a string; deterministic
// `validateTaskSchema()` then enforces the 20-char floor when `noWork=true`.
// We can't use OpenAI's `if/then/oneOf` constructs here because structured
// output rejects conditional shapes — the contract is "always emit reason,
// and validator decides whether the value is admissible".
export const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    noWork: { type: "boolean" },
    reason: { type: "string" },
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
        // creates: files the executor will CREATE during this task. Must not
        // already exist on disk — preflight skips its file-existence check for
        // these paths (issue #190). Post-execution, the cycle verifies each
        // listed path was actually created.
        creates: { type: "array", items: { type: "string" } },
      },
      required: ["in", "out", "creates"],
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

/**
 * Validate the structured `noWork` arm of the planner output (issue #364).
 *
 * Pure helper — returns a list of human-readable error strings. Empty array
 * means the noWork payload is well-formed. Caller decides what to do with
 * a malformed payload (retry once with a stricter prompt, then escalate).
 *
 * Constraints:
 *   - `noWork` must be exactly `true` (the noWork arm is opt-in)
 *   - `reason` must be a string of at least NOWORK_REASON_MIN_LENGTH chars
 *     after trim. This blocks "n/a", "blocked", "no", and similar non-
 *     diagnostic short-circuits that defeat the abandonment-telemetry goal
 *     of `to-planner.md`'s "No-Task Diagnostic Requirement".
 */
export function validateNoWorkSchema(task: any): string[] {
  const errors: string[] = [];
  if (task?.noWork !== true) {
    errors.push("noWork flag must be true for the no-task arm");
  }
  const reason = typeof task?.reason === "string" ? task.reason.trim() : "";
  if (!reason) {
    errors.push("missing or empty reason on noWork response");
  } else if (reason.length < NOWORK_REASON_MIN_LENGTH) {
    errors.push(
      `noWork reason too short (got ${reason.length} chars, need >= ${NOWORK_REASON_MIN_LENGTH}) — ` +
      `state which anchors were inspected and the specific rule/missing evidence that blocked task creation`,
    );
  }
  return errors;
}

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
  if (!task.title || typeof task.title !== "string" || task.title.trim().length === 0) {
    errors.push("missing or empty title");
  }

  return errors;
}

/**
 * Parse the raw planner output into a JS object. Tries strict JSON.parse
 * first, then falls back to extracting the first `{…}` substring (the model
 * occasionally wraps the payload in stray prose despite the structured
 * output schema). Returns `null` when nothing parses.
 *
 * Pure helper — exported for the retry path and for tests so the parse
 * contract is stable across the two call sites in runPlannerAgent.
 */
export function parsePlannerOutput(raw: string | undefined | null): any | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch { /* intentional: fall through to regex extraction */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err: any) {
    console.error(`[ControlLoop] Planner output unparseable even after regex extraction: ${err.message}`);
    return null;
  }
}

/**
 * Build the stricter retry prompt used when the first planner call returns
 * an unparseable payload or a malformed noWork response (issue #364).
 *
 * The prompt is deliberately compressed: just the anchor identity and a
 * single instruction to emit one of two structured shapes. We never reuse
 * the original verbose planner prompt because (a) the retry budget is
 * tight (~1500 tokens out) and (b) the goal is to *convert an unstructured
 * failure into a structured diagnostic*, not to make a fresh task attempt.
 *
 * Pure helper — exported for unit tests so the prompt contract is locked.
 */
export function buildRetryNoWorkPrompt(anchor: { type: string; reference: string; whyNow?: string }): string {
  return [
    `Your previous response was unparseable or missing required fields.`,
    `Emit ONE of these two JSON shapes and nothing else.`,
    ``,
    `## Anchor`,
    `Type: ${anchor.type}`,
    `Reference: ${anchor.reference}`,
    anchor.whyNow ? `Why now: ${anchor.whyNow}` : "",
    ``,
    `## Required output (choose one)`,
    ``,
    `Option A — you have a concrete task: emit the full task JSON (all fields per the schema).`,
    ``,
    `Option B — no actionable work: emit { "noWork": true, "reason": "<diagnostic>" }`,
    `  - reason MUST be at least ${NOWORK_REASON_MIN_LENGTH} characters`,
    `  - reason MUST name: what anchor you inspected, which rule/evidence blocked task creation,`,
    `    and the smallest concrete change that would unblock the next planning attempt`,
    ``,
    `Do not return null. Do not return an empty object. Do not omit "noWork". Do not omit "reason".`,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Output-token cap selection — issue #361
// ---------------------------------------------------------------------------
//
// The planner accounts for ~74% of orchestrator spend, dominated by frontier
// reasoning tokens. Top-5 cycles burned $12–$18 each on planner alone, with
// the model emitting ~1M output tokens before producing a ~2K-token JSON
// task. A static `max_output_tokens` cap is the cheapest way to bound this:
// the model is forced to stop reasoning before it runs away, and if it can't
// produce a complete structured payload under the cap, the cycle records
// `max_tokens_reached` and exits as noWork instead of crashing.
//
// Caps are chosen by anchor type pre-planner (post-planner classification
// runs only AFTER we have a task in hand, which is too late to budget the
// call that produces it). Quick-fix / cheap anchors get a tighter cap
// because their compressed prompt does not justify deep reasoning; complex
// research/reframe anchors get a higher ceiling but still well below the
// observed 1M-token outliers.
//
// At frontier rates ($15/1M output), these caps imply an upper bound of:
//   quick-fix : 3000 tokens → ~$0.045 per call
//   standard  : 8000 tokens → ~$0.12 per call
//   complex   : 12000 tokens → ~$0.18 per call
//
// All well below the current $5 average and $15 ceiling.

export const PLANNER_MAX_OUTPUT_TOKENS = {
  quickFix: 3000,
  standard: 8000,
  complex: 12000,
} as const;

/**
 * Pure helper — choose the planner output-token cap for an anchor BEFORE the
 * planner runs. Mirrors the cheap/standard anchor classification used by
 * model-tier selection (see issue #138 / `planner-model-routing.test.mts`).
 *
 * Exported for unit tests. Inputs are intentionally narrow (just `type`) so
 * the helper can be exercised without constructing a full anchor object.
 */
export function selectPlannerTokenCap(anchorType: string): number {
  // quick-fix anchor types — narrow, deterministic, compressed prompt
  if (anchorType === "failing-test" || anchorType === "prior-failure") {
    return PLANNER_MAX_OUTPUT_TOKENS.quickFix;
  }
  // codebase-health is also cheap (reductive, single-file scope)
  if (anchorType === "codebase-health") {
    return PLANNER_MAX_OUTPUT_TOKENS.quickFix;
  }
  // Reframe anchors retry a failed task — full ceremony, complex reasoning.
  if (anchorType === "reframe") {
    return PLANNER_MAX_OUTPUT_TOKENS.complex;
  }
  // Everything else (kanban, spec, research, work-queue, user-request, todo,
  // typecheck-error, regression-hunt, doc-anchor): standard cap.
  return PLANNER_MAX_OUTPUT_TOKENS.standard;
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
  // Pre-planner actionability gate (issue #270).
  // For research/user-request/doc anchors, do a deterministic check against
  // completed priorities + last 50 merged cycle titles BEFORE paying for the
  // frontier model. NoWork outcomes were costing $5–$11 each; this gate cuts
  // that to <$0.10 per skipped cycle. Recovery anchor types (failing-test,
  // prior-failure, reframe, codebase-health) are deliberately not gated.
  const actionability = await isAnchorActionable(anchor);
  if (!actionability.actionable) {
    console.log(`[Planner] PRE-GATE skip: ${actionability.reason}`);
    // Issue #363: attribute pre-gate skips to the cache-miss histogram for
    // cacheable anchor types. This makes the "lifetime hit rate is 0%"
    // mystery solvable from /api/plan-cache/stats alone — operators can see
    // that gated cycles dominate the miss column instead of guessing.
    if (PLAN_CACHEABLE_TYPES.has(anchor.type)) {
      recordPlanCacheMiss("actionability-skipped");
    }
    return {
      __noWork: true,
      reason: actionability.reason,
      __planCacheHit: false,
      __plannerModel: "pregate-skip",
    } as any;
  }

  // Scope-adaptive planner routing (PAUL pattern):
  // Quick-fix anchors (failing-test, prior-failure) get a compressed prompt
  // and cheaper model — they don't need priorities, accomplishments, or
  // continuity because the anchor IS the entire scope.
  const isQuickFixAnchor = anchor.type === "failing-test" || anchor.type === "prior-failure";
  const isCheapAnchor = isQuickFixAnchor || anchor.type === "codebase-health";
  const isReframe = anchor.type === "reframe";
  const plannerModel = isCheapAnchor ? "codex" : "frontier";

  // Plan cache — skip LLM call for recurring task patterns.
  // Belt-and-suspenders: bypass cache when reflections exist for this anchor,
  // so the planner is forced to re-plan with failure context (issue #22).
  //
  // Exception: cache-safe anchor types are deterministic narrow tasks where
  // the cached plan remains valid even when reflections exist — the fix for
  // a specific failing test or the "add tests to file X" health task doesn't
  // change based on prior attempt context. Issue #363 broadens this from
  // `failing-test` only to also include `codebase-health` (deterministic
  // "<category> in <file>" plans) so the cache actually has a reachable hit
  // population.
  const CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test", "codebase-health"]);
  const plannerContext = await getContext("planner", anchor).catch(() => "");
  const hasReflections = plannerContext.includes("PRIOR ATTEMPTS") || plannerContext.includes("Recent Failures");
  const cacheBypassOverride = CACHE_SAFE_ANCHOR_TYPES.has(anchor.type);
  if (!hasReflections || cacheBypassOverride) {
    const cachedTask = await getCachedPlan(anchor, grounding);
    if (cachedTask) {
      cachedTask.__plannerModel = "cached";
      cachedTask.__planCacheHit = true;
      cachedTask.__planCacheAnchorType = anchor.type;
      // Cache hits don't inject reflections (cache only used when none exist
      // for non-CACHE_SAFE types, or for CACHE_SAFE types where reflections
      // aren't useful for narrow deterministic fixes).
      cachedTask.__reflectionsInjected = 0;
      cachedTask.__hadReflections = false;
      cachedTask.__reflectionSources = [];
      cachedTask.__reflectionMatchSource = "none";
      await getTracker().logAgentRun(cycleId, "planner", "planner", 0, "cache-hit", {}, 0, "cache");
      console.log(`[PlanCache] HIT for anchor type="${anchor.type}" ref="${anchor.reference.slice(0, 60)}"${hasReflections ? " (reflections present but safe for cache-safe type)" : ""}`);
      return cachedTask;
    }
  } else {
    // Issue #363: record the bypass in the miss-reason histogram so the
    // hit-rate-is-0 mystery is diagnosable from /api/plan-cache/stats alone.
    // Only attribute for cacheable types — non-cacheable bypasses are already
    // covered by the `non-cacheable-type` reason path in getCachedPlan.
    if (PLAN_CACHEABLE_TYPES.has(anchor.type)) {
      recordPlanCacheMiss("reflection-bypass");
    }
    console.log(`[PlanCache] BYPASS: reflections exist for anchor "${anchor.reference.slice(0, 60)}" type="${anchor.type}" — forcing re-plan`);
  }

  // Load all context sources via centralized context builder
  const ctx = await buildPlannerContext(anchor, grounding, ovSession);
  if (ctx.warnings.length > 0) {
    console.log(`[ControlLoop] Planner context loaded with ${ctx.warnings.length} warning(s): ${ctx.warnings.join("; ")}`);
  }
  const { priorities, feedback, plannerMemory, ovContext, milestoneContext, accomplishmentsContext, groundingSummary, continuityContext, scopedFileTree } = ctx;

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
    `  "scopeBoundary": { "in": ["file1.ts", "file2.ts"], "out": ["unrelated/"], "creates": [] },`,
    `  // scopeBoundary.creates: list NEW files this task will create (refactor/extract/split tasks).`,
    `  // Files in "in" must already exist on disk. Files in "creates" must NOT yet exist — they are`,
    `  // verified to exist after the executor runs. Use [] if no new files are created.`,
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
    // Compressed prompt for quick-fix: just anchor + compact grounding + fix instructions.
    // Issue #193: reflections (plannerMemory) are now loaded for quick-fix anchors —
    // without them, prior-failure retries were stuck at 0% merge rate.
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
      // Inject reflections so the planner sees prior failure context. This is the
      // entire point of retrying a prior-failure anchor.
      plannerMemory ? plannerMemory : "",
      "",
      `## INSTRUCTIONS`,
      `This is a targeted fix. Produce exactly 1 task with the SMALLEST change that resolves the issue.`,
      `The task MUST be anchored to "${anchor.reference}".`,
      `Keep scopeBoundary narrow — ideally 1-2 files.`,
      plannerMemory ? `Prior attempts for this anchor are listed above — propose a DIFFERENT approach (different files, different method, narrower scope) than what failed before.` : "",
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
      // Issue #366: scoped file-tree snapshot. The planner historically
      // hallucinated plausible-looking file paths (e.g. names matching the
      // project convention but pointing at files that don't exist), which the
      // preflight gate then rejected — costing ~$5 and a wasted cycle every
      // ~11% of abandonments. Injecting up to ~2000 tokens of real paths
      // related to the anchor reference closes that gap.
      scopedFileTree ? scopedFileTree : "",
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
      // Agent memory + reflections — learn from past outcomes
      plannerMemory,
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

  // Issue #361: hard-cap output tokens to bound runaway frontier reasoning.
  // Chosen pre-planner from anchor type (the only signal available before
  // the planner produces a task). See selectPlannerTokenCap above for the
  // mapping rationale.
  const plannerMaxOutputTokens = selectPlannerTokenCap(anchor.type);

  const result = await runAgent({
    agentName: "planner",
    personality,
    prompt,
    model: plannerModel,
    taskId: "planner",
    correlationId: cycleId,
    outputSchema: PLANNER_OUTPUT_SCHEMA,
    maxOutputTokens: plannerMaxOutputTokens,
    // Pre-classification heuristic for OTel span tagging only — the
    // authoritative complexity is set post-planner by classifyComplexity().
    complexity: isCheapAnchor ? "quick-fix" : "standard",
  });

  // Detect Codex usage-limit errors — signal the caller to pause instead of retrying
  if (result.usageLimitHit) {
    console.error(`[ControlLoop] Codex usage limit hit during planning — signaling pause`);
    // Return a sentinel object that the caller can detect
    return { __usageLimitHit: true } as any;
  }

  // Issue #361: hard output-token cap aborted the call before a complete
  // structured payload was emitted. Treat as noWork (partial JSON is unsafe
  // to act on) and tag the cycle metrics so we can track cap-hit rate.
  if (result.maxTokensReached) {
    console.error(`[ControlLoop] Planner output-token cap reached (cap=${plannerMaxOutputTokens}, anchor=${anchor.type}) — treating as noWork`);
    await getTracker().logAgentRun(
      cycleId, "planner", "planner", result.duration, "max-tokens-reached",
      result.usage, result.costUsd, result.model,
    );
    return {
      __noWork: true,
      reason: "max_tokens_reached",
      __plannerTokenCapHit: true,
      __plannerMaxOutputTokens: plannerMaxOutputTokens,
      __plannerModel: result.model,
    } as any;
  }

  // Parse output — try direct parse, then regex fallback, then fail loud
  let task = parsePlannerOutput(result.output);

  // Issue #364 — Retry-once-on-unstructured-failure.
  //
  // 67% of abandonments (12/18 in the issue-#364 window) were "Planner produced
  // no task": the model emitted malformed JSON / an empty object / omitted the
  // `noWork` field, defeating the structured noWork contract. The fix is a
  // single cheap retry on the mini tier with a stripped prompt that demands
  // either a full task OR a structured noWork — converting an unstructured
  // null into a structured diagnostic so downstream telemetry has something
  // to act on (and the abandonment breakdown reports the real failure mode).
  //
  // Retry triggers:
  //   (a) first call's output didn't parse to an object, OR
  //   (b) parsed noWork response failed schema validation (empty/too-short reason)
  //
  // Cost is bounded: mini tier ($0.75/$4.50 per 1M), capped at 1500 output
  // tokens → ~$0.007 worst case. Much cheaper than the $5 first-call spend.
  const initialNoWorkErrors = task?.noWork === true ? validateNoWorkSchema(task) : [];
  const needsRetry = !task || initialNoWorkErrors.length > 0;
  let plannerSchemaFailure = false;
  let retryAttempted = false;
  let retryResult: any = null;

  if (needsRetry) {
    retryAttempted = true;
    plannerSchemaFailure = true;
    const retryReason = !task
      ? "unparseable planner output"
      : `malformed noWork (${initialNoWorkErrors.join("; ")})`;
    console.log(`[ControlLoop] Planner retry — ${retryReason} (issue #364)`);
    try {
      retryResult = await runAgent({
        agentName: "planner",
        personality,
        prompt: buildRetryNoWorkPrompt(anchor),
        model: "mini",
        taskId: "planner-retry",
        correlationId: cycleId,
        outputSchema: PLANNER_OUTPUT_SCHEMA,
        maxOutputTokens: 1500,
        complexity: "quick-fix",
      });
    } catch (err: any) {
      console.error(`[ControlLoop] Planner retry failed: ${err.message}`);
    }

    if (retryResult?.usageLimitHit) {
      console.error(`[ControlLoop] Codex usage limit hit during planner retry — signaling pause`);
      return { __usageLimitHit: true } as any;
    }

    const retried = retryResult ? parsePlannerOutput(retryResult.output) : null;
    const retriedNoWorkErrors = retried?.noWork === true ? validateNoWorkSchema(retried) : [];

    if (retried?.noWork === true && retriedNoWorkErrors.length === 0) {
      // Retry succeeded with a structured noWork — short-circuit and return
      // the noWork sentinel with the schema-failure flag set so cycle metrics
      // can distinguish "real noWork" (rare) from "schema-fail recovered as
      // noWork" (the 67% case we're targeting).
      console.log(`[ControlLoop] Planner retry produced structured noWork: ${retried.reason}`);
      await getTracker().logAgentRun(
        cycleId, "planner", "planner-retry", retryResult.duration, "no-work",
        retryResult.usage, retryResult.costUsd, retryResult.model,
      );
      return {
        __noWork: true,
        reason: retried.reason,
        __plannerSchemaFailure: true,
        __plannerModel: result.model,
      } as any;
    }

    if (retried && retried.noWork !== true) {
      // Retry produced a fresh task — use it. Fall through to validation below.
      console.log(`[ControlLoop] Planner retry produced a task (schema-fail on first call)`);
      task = retried;
    } else {
      // Retry also failed to produce a structured response. Convert into a
      // structured noWork sentinel with __plannerSchemaFailure so the
      // abandonment-breakdown endpoint can categorise this as a schema
      // failure rather than the generic "Planner produced no task" bucket
      // (issue #364 AC).
      console.error(`[ControlLoop] Planner retry also failed — returning schema-failure sentinel`);
      await getTracker().logAgentRun(
        cycleId, "planner", "planner-retry",
        retryResult?.duration ?? 0, "schema-failure",
        retryResult?.usage ?? {}, retryResult?.costUsd ?? 0,
        retryResult?.model ?? "unknown",
      );
      return {
        __noWork: true,
        reason: "planner_schema_failure (retry exhausted)",
        __plannerSchemaFailure: true,
        __plannerModel: result.model,
      } as any;
    }
  }

  // Handle explicit "no work" response — return sentinel so handlePlanResult
  // can distinguish noWork from parse failures (issue #137)
  if (task?.noWork) {
    // Issue #364 — at this point the noWork shape has either been validated
    // on the first call (initialNoWorkErrors.length === 0) or come back well-
    // formed from the retry path (which already short-circuited above).
    // Defensive double-check so a future refactor can't slip a malformed
    // payload through.
    const finalErrors = validateNoWorkSchema(task);
    if (finalErrors.length > 0) {
      console.error(`[ControlLoop] Planner noWork final validation failed: ${finalErrors.join("; ")}`);
      await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "no-work", result.usage, result.costUsd, result.model);
      return {
        __noWork: true,
        reason: `schema-fail-fallback: ${finalErrors[0]}`,
        __plannerSchemaFailure: true,
        __plannerModel: result.model,
      } as any;
    }
    console.log(`[ControlLoop] Planner says no work needed: ${task.reason}`);
    await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "no-work", result.usage, result.costUsd, result.model);
    return {
      __noWork: true,
      reason: task.reason,
      ...(plannerSchemaFailure ? { __plannerSchemaFailure: true } : {}),
      __plannerModel: result.model,
    } as any;
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

  await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "completed", result.usage, result.costUsd, result.model);
  if (task) {
    task.__plannerModel = result.model;
    // Issue #193 / #221: tag whether reflections reached the planner so cycle
    // metrics can correlate retry success rate with reflection injection.
    // Source of truth is ctx.reflectionInjected / ctx.reflectionSources, set
    // by the context builder after budget truncation has been applied — so
    // this matches what the planner actually saw, not the pre-truncation raw
    // bytes.
    task.__reflectionsInjected = ctx.reflectionInjected;
    task.__hadReflections = ctx.reflectionInjected > 0;
    task.__reflectionSources = ctx.reflectionSources.slice();
    // Issue #326: pre-compute the categorical match-source bucket so all
    // downstream metric writers (including Tier-0 paths in verification/post-
    // merge) can emit it without recomputing.
    task.__reflectionMatchSource = reflectionMatchSource(ctx.reflectionSources);
    // Issue #364: tag that the first call required a schema-recovery retry,
    // so cycle metrics can correlate downstream verification outcomes with
    // first-call schema reliability. Distinct from `__plannerSchemaFailure`
    // on the noWork sentinel which marks an *unrecovered* failure.
    if (retryAttempted) {
      task.__plannerSchemaFailure = true;
    }
  }

  // Store in plan cache for future reuse
  if (task) {
    await cachePlan(anchor, task, grounding).catch((err) =>
      console.error(`[PlanCache] Store failed: ${err.message}`));
  }

  return task;
}
