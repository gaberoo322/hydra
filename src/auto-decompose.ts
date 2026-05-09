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
import type { Spec } from "./specs.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecomposeResult {
  decomposed: true;
  spec: Spec;
  taskCount: number;
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
  return {
    decomposed: true,
    spec,
    taskCount: spec.tasks.length,
  };
}
