/**
 * auto-decompose.ts — Auto-decompose complex tasks into specs
 *
 * When classifyTaskComplexity() returns "complex" (>5 files in scope),
 * this module creates a spec with per-file tasks instead of sending
 * the whole plan to the executor. Each spec task targets 1-2 files
 * from the original scopeBoundary.in, with acceptance criteria
 * distributed across tasks.
 *
 * Solves issue #171: complex tasks (>5 files) have 0% merge rate
 * because the executor can't reliably modify 5+ files in one cycle.
 */

import { createSpec } from "./specs.ts";
import type { Spec, SpecTask } from "./specs.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A task object shaped like the planner's output, suitable for direct
 * re-entry into the control loop's classify/preflight/execute pipeline.
 *
 * Issue #194: after auto-decompose, the parent cycle continues with the
 * first sub-task instead of abandoning — converting wasted planner cost
 * into a merged change. This is the shape the cycle needs to do that.
 */
export interface DecomposedFirstTask {
  title: string;
  description: string;
  anchorType: string;
  anchorReference: string;
  whyNow: string;
  confidence: number;
  risk: "low" | "medium" | "high";
  scopeBoundary: {
    in: string[];
    out?: string[];
  };
  acceptanceCriteria: string[];
  verificationPlan: string;
  // Marker so the control loop can short-circuit re-decomposition
  // and avoid infinite recursion if the sub-task also classifies complex.
  __fromAutoDecompose: true;
  __parentSpecSlug: string;
  __parentSpecTaskId: string;
}

export interface DecomposeResult {
  decomposed: true;
  spec: Spec;
  taskCount: number;
  /**
   * The first sub-task, ready for the control loop to execute in the
   * SAME cycle (issue #194). Null only if the spec was created with an
   * empty task list, which `autoDecomposeComplexTask` already filters out.
   */
  firstTask: DecomposedFirstTask;
}

export interface DecomposeInput {
  title: string;
  description: string;
  scopeBoundary: {
    in: string[];
    out?: string[];
  };
  acceptanceCriteria?: string[];
  anchorReference?: string;
  anchorType?: string;
  risk?: "low" | "medium" | "high";
  verificationPlan?: string;
}

/**
 * Parse the "Scope: a.ts, b.ts" prefix that buildSpecTasks writes into
 * each sub-task description. Returns the file list (deduped).
 *
 * Pure helper, exported for testability.
 */
export function extractFilesFromSpecTaskDescription(description: string): string[] {
  if (!description) return [];
  const match = description.match(/^Scope:\s*([^\n]+)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Parse the "Criteria:\n- ..." block that buildSpecTasks writes into
 * each sub-task description. Returns the criteria list.
 *
 * Pure helper, exported for testability.
 */
export function extractCriteriaFromSpecTaskDescription(description: string): string[] {
  if (!description) return [];
  const match = description.match(/Criteria:\n([\s\S]+?)(?:\n\n|$)/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map(line => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Build a task object from a spec task that's ready to enter the
 * classify/preflight/execute pipeline.
 *
 * Anchor identity carries from the parent so metrics and Kanban
 * lookups continue to work. The acceptance criteria distributed to
 * the sub-task are extracted from its description; the parent's
 * verificationPlan is reused so the executor knows how to verify.
 *
 * Pure function, no I/O.
 */
export function buildFirstTaskFromSpec(
  parent: DecomposeInput,
  spec: Spec,
  specTask: SpecTask,
): DecomposedFirstTask {
  const description = specTask.description || "";
  const filesInScope = extractFilesFromSpecTaskDescription(description);
  const subCriteria = extractCriteriaFromSpecTaskDescription(description);

  // Fall back to a single criterion (the sub-task title) so preflight
  // doesn't reject for empty criteria.
  const acceptanceCriteria = subCriteria.length > 0
    ? subCriteria
    : [`Implement: ${specTask.title}`];

  return {
    title: specTask.title,
    description: description || `Sub-task of "${parent.title}"`,
    anchorType: parent.anchorType || "user-request",
    anchorReference: parent.anchorReference || spec.slug,
    whyNow: `Auto-decomposed sub-task ${specTask.id}/${spec.tasks.length} of "${spec.title}"`,
    confidence: 0.8,
    risk: parent.risk || "low",
    scopeBoundary: {
      in: filesInScope.length > 0 ? filesInScope : (parent.scopeBoundary?.in || []),
      out: parent.scopeBoundary?.out,
    },
    acceptanceCriteria,
    verificationPlan: parent.verificationPlan || "npm test && npm run typecheck",
    __fromAutoDecompose: true,
    __parentSpecSlug: spec.slug,
    __parentSpecTaskId: specTask.id,
  };
}

// ---------------------------------------------------------------------------
// Core logic — pure function to build spec tasks from a complex plan
// ---------------------------------------------------------------------------

/**
 * Build spec task definitions from a complex plan's scope and criteria.
 *
 * Each task targets 1-2 files from scopeBoundary.in. Acceptance criteria
 * are round-robin distributed across tasks so each task has a clear
 * "done" definition.
 *
 * Pure function — no I/O, easily testable.
 */
export function buildSpecTasks(
  title: string,
  filesInScope: string[],
  acceptanceCriteria: string[],
): Array<{ title: string; description: string }> {
  if (filesInScope.length === 0) return [];

  const tasks: Array<{ title: string; description: string }> = [];

  // Group files into chunks of 1-2 per task
  for (let i = 0; i < filesInScope.length; i += 2) {
    const chunk = filesInScope.slice(i, i + 2);
    const fileNames = chunk.map(f => f.split("/").pop() || f).join(", ");
    const taskTitle = `${title} -- ${fileNames}`;

    // Distribute criteria round-robin across tasks
    const taskIndex = Math.floor(i / 2);
    const totalTasks = Math.ceil(filesInScope.length / 2);
    const taskCriteria: string[] = [];
    for (let c = 0; c < acceptanceCriteria.length; c++) {
      if (c % totalTasks === taskIndex) {
        taskCriteria.push(acceptanceCriteria[c]);
      }
    }

    const description = [
      `Scope: ${chunk.join(", ")}`,
      taskCriteria.length > 0
        ? `Criteria:\n${taskCriteria.map(c => `- ${c}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n");

    tasks.push({ title: taskTitle, description });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Main entry point — creates a spec from a complex task
// ---------------------------------------------------------------------------

/**
 * Auto-decompose a complex task into a spec with per-file tasks.
 *
 * Returns the created spec, or null if:
 * - The task has no files in scope (nothing to decompose)
 * - A spec with the same slug already exists (idempotent)
 */
export async function autoDecomposeComplexTask(
  task: DecomposeInput,
): Promise<DecomposeResult | null> {
  const filesInScope = task.scopeBoundary?.in || [];
  if (filesInScope.length === 0) {
    console.log(`[AutoDecompose] No files in scope — skipping decomposition`);
    return null;
  }

  const specTasks = buildSpecTasks(
    task.title,
    filesInScope,
    task.acceptanceCriteria || [],
  );

  const spec = await createSpec({
    title: task.title,
    rationale: `Auto-decomposed: complex task with ${filesInScope.length} files in scope. Original description: ${(task.description || "").slice(0, 300)}`,
    source: "auto-decompose",
    sourceId: task.anchorReference,
    tasks: specTasks,
  });

  if (!spec) {
    console.log(`[AutoDecompose] Spec already exists for "${task.title}" — skipping`);
    return null;
  }

  console.log(`[ControlLoop] Complex task auto-decomposed into spec with ${spec.tasks.length} tasks`);
  // The spec is created with at least one task whenever filesInScope is
  // non-empty (buildSpecTasks emits ceil(N/2) tasks for N>0 files), so
  // spec.tasks[0] is safe here.
  const firstTask = buildFirstTaskFromSpec(task, spec, spec.tasks[0]);
  return {
    decomposed: true,
    spec,
    taskCount: spec.tasks.length,
    firstTask,
  };
}
