/**
 * Agent Memory
 *
 * Per-agent learning files that accumulate outcome data after each cycle.
 * Agents read their memory at the start of each call to avoid repeating mistakes.
 * The control loop appends lessons after each cycle (agents never write their own memory).
 * The architect periodically curates and prunes stale entries.
 *
 * Files:
 *   {HYDRA_PATH}/agent-memory/planner.md
 *   {HYDRA_PATH}/agent-memory/executor.md
 *   {HYDRA_PATH}/agent-memory/skeptic.md
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const MEMORY_DIR = join(HYDRA_PATH, "agent-memory");

const MAX_ENTRIES = 50; // Keep last 50 entries per agent to avoid unbounded growth

/**
 * Load an agent's memory file. Returns the content as a string.
 */
export async function loadAgentMemory(agentName) {
  try {
    return await readFile(join(MEMORY_DIR, `${agentName}.md`), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Append a lesson to an agent's memory file.
 * Called by the control loop after each cycle — agents never call this themselves.
 *
 * @param {string} agentName - "planner", "executor", or "skeptic"
 * @param {object} entry - { cycleId, outcome, lesson, context }
 */
export async function recordLesson(agentName, entry) {
  await mkdir(MEMORY_DIR, { recursive: true });
  const filePath = join(MEMORY_DIR, `${agentName}.md`);

  let existing = "";
  try { existing = await readFile(filePath, "utf-8"); } catch {}

  const date = new Date().toISOString().split("T")[0];
  const line = `- **${date}** [${entry.outcome}] ${entry.cycleId}: ${entry.lesson}`;

  // Parse existing entries, append new one, trim to MAX_ENTRIES
  const lines = existing.split("\n").filter(l => l.startsWith("- **"));
  lines.push(line);
  const trimmed = lines.slice(-MAX_ENTRIES);

  const header = `# ${agentName} — Lessons Learned\n\nThese are real outcomes from previous cycles. Use them to avoid repeating mistakes and to reinforce what works.\n\n`;
  await writeFile(filePath, header + trimmed.join("\n") + "\n");
}

/**
 * Record planner outcome after a cycle.
 */
export async function recordPlannerLesson(cycleId, task, finalState, context = {}) {
  const lessons = [];

  if (finalState === "merged") {
    lessons.push(`Task "${task.title}" merged successfully.`);
    if (context.filesChanged <= 2) {
      lessons.push(`Small scope (${context.filesChanged} files) — this worked well.`);
    }
  } else if (finalState === "failed") {
    const reason = context.failReason || "verification failed";
    lessons.push(`Task "${task.title}" failed: ${reason}.`);
    if (context.failedSteps?.length > 0) {
      lessons.push(`Failed checks: ${context.failedSteps.join(", ")}.`);
    }
    if (task.scopeBoundary?.in?.length > 3) {
      lessons.push(`Scope was broad (${task.scopeBoundary.in.length} files) — consider narrower scope.`);
    }
  } else if (finalState === "rolled-back") {
    lessons.push(`Task "${task.title}" was merged but caused a regression and was auto-reverted.`);
  } else if (finalState === "abandoned") {
    lessons.push(`Task "${task.title}" was abandoned: ${context.reason || "skeptic rejected or drift detected"}.`);
  }

  if (lessons.length > 0) {
    await recordLesson("planner", {
      cycleId,
      outcome: finalState,
      lesson: lessons.join(" "),
    });
  }
}

/**
 * Record executor outcome after a cycle.
 */
export async function recordExecutorLesson(cycleId, task, finalState, context = {}) {
  const lessons = [];

  if (finalState === "merged") {
    lessons.push(`Successfully built "${task.title}".`);
    if (context.testsAfter > context.testsBefore) {
      lessons.push(`Added ${context.testsAfter - context.testsBefore} new tests — good.`);
    }
  } else if (finalState === "failed") {
    if (context.noDiff) {
      lessons.push(`Produced no code changes for "${task.title}" — make sure to actually write code and commit.`);
    } else if (context.failedSteps?.length > 0) {
      lessons.push(`Code changes for "${task.title}" failed verification: ${context.failedSteps.join(", ")}.`);
      if (context.verificationStderr) {
        const stderr = context.verificationStderr.slice(0, 300);
        lessons.push(`Error output: ${stderr}`);
      }
    }
  } else if (finalState === "rolled-back") {
    lessons.push(`Code for "${task.title}" passed verification but caused a test regression after merge. Tests went from ${context.testsBefore} to ${context.testsAfter} passing.`);
  }

  if (lessons.length > 0) {
    await recordLesson("executor", {
      cycleId,
      outcome: finalState,
      lesson: lessons.join(" "),
    });
  }
}

/**
 * Record skeptic outcome after a cycle.
 */
export async function recordSkepticLesson(cycleId, task, skepticVerdict, finalState) {
  const lessons = [];

  if (skepticVerdict === "approve") {
    if (finalState === "merged") {
      lessons.push(`Approved "${task.title}" — it merged successfully. Good call.`);
    } else if (finalState === "failed" || finalState === "rolled-back") {
      lessons.push(`Approved "${task.title}" but it ${finalState}. Should have been more skeptical.`);
    }
  } else if (skepticVerdict === "reject") {
    lessons.push(`Rejected "${task.title}": considered it too risky or duplicative.`);
  }

  if (lessons.length > 0) {
    await recordLesson("skeptic", {
      cycleId,
      outcome: skepticVerdict === "approve" ? finalState : "rejected",
      lesson: lessons.join(" "),
    });
  }
}

/**
 * Format agent memory for inclusion in a prompt.
 * Returns a prompt section string or empty string if no memory.
 */
export function formatMemoryForPrompt(memory, agentName) {
  if (!memory || memory.trim().length === 0) return "";
  // Extract just the lesson lines, skip the header
  const lines = memory.split("\n").filter(l => l.startsWith("- **"));
  if (lines.length === 0) return "";

  // Show most recent entries (they're most relevant)
  const recent = lines.slice(-20);
  return `\n## YOUR PAST OUTCOMES (learn from these — do not repeat failures)\n${recent.join("\n")}\n`;
}
