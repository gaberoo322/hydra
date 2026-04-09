/**
 * Agent Memory — WHEN/CHECK/BECAUSE prevention rules (Sage pattern)
 *
 * Per-agent learning files that accumulate structured prevention rules after
 * each cycle. Agents read their rules at the start of each call to avoid
 * repeating mistakes.
 *
 * Format (inspired by Sage's self-learning system):
 *   WHEN: <trigger condition — when should the agent check this?>
 *   CHECK: <what to verify>
 *   BECAUSE: <evidence — the cycle that proved this matters>
 *
 * Key design decisions:
 *   - Only record FAILURES, SURPRISES, and PATTERN VIOLATIONS. Pure-success
 *     lessons ("merged successfully, good call") are noise — they teach
 *     nothing and dilute the signal when agents read their memory.
 *   - Rules are structured and searchable, not prose paragraphs.
 *   - The "compound" step (Step 8.5 in the control loop) runs after every
 *     cycle and extracts prevention rules from the outcome.
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

const MAX_RULES = 30; // Keep last 30 rules per agent — quality > quantity

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
 * Append a WHEN/CHECK/BECAUSE rule to an agent's memory file.
 * Called by the control loop's compound step — agents never call this themselves.
 *
 * @param {string} agentName - "planner", "executor", or "skeptic"
 * @param {object} rule - { when, check, because, cycleId, severity }
 */
export async function recordRule(agentName, rule) {
  await mkdir(MEMORY_DIR, { recursive: true });
  const filePath = join(MEMORY_DIR, `${agentName}.md`);

  let existing = "";
  try { existing = await readFile(filePath, "utf-8"); } catch {}

  const date = new Date().toISOString().split("T")[0];
  const severity = rule.severity || "prevent";
  const entry = [
    `### [${severity}] ${date} — ${rule.cycleId}`,
    `WHEN: ${rule.when}`,
    `CHECK: ${rule.check}`,
    `BECAUSE: ${rule.because}`,
    "",
  ].join("\n");

  // Parse existing rules (each starts with ###), append new one, trim to MAX_RULES
  const rules = existing.split(/^(?=### \[)/m).filter(r => r.trim().startsWith("### ["));
  rules.push(entry);
  const trimmed = rules.slice(-MAX_RULES);

  const header = `# ${agentName} — Prevention Rules\n\nStructured rules from real cycle outcomes. Follow these to avoid repeating past failures.\nFormat: WHEN (trigger) → CHECK (verify) → BECAUSE (evidence)\n\n`;
  await writeFile(filePath, header + trimmed.join("\n"));
}

// Legacy API — keep for backwards compatibility during migration.
// New code should use recordRule() directly.
export async function recordLesson(agentName, entry) {
  // Convert prose lessons to a simple rule format
  await recordRule(agentName, {
    when: `Similar task to "${entry.lesson?.split('"')[1] || "unknown"}"`,
    check: `Review outcome: ${entry.outcome}`,
    because: `${entry.cycleId}: ${entry.lesson}`,
    cycleId: entry.cycleId,
    severity: entry.outcome === "merged" ? "reinforce" : "prevent",
  });
}

/**
 * Record planner outcome — only records when there's something to LEARN.
 * Successful merges of normal tasks are NOT recorded (noise).
 */
export async function recordPlannerLesson(cycleId, task, finalState, context = {}) {
  if (finalState === "merged") {
    // Scope creep detected by reconciliation — record prevention rule
    if (context.scopeCreep?.length > 0) {
      await recordRule("planner", {
        when: `Proposing tasks anchored to "${task.anchorReference || "similar work"}"`,
        check: `Does scopeBoundary.in include ALL files the executor will need to touch? The executor went outside scope last time: ${context.scopeCreep.join(", ")}`,
        because: `${cycleId}: "${task.title}" merged but executor modified ${context.scopeCreep.length} file(s) outside planned scope`,
        cycleId,
        severity: "prevent",
      });
    }
    // Complex task succeeded — that's noteworthy
    if (task.scopeBoundary?.in?.length > 4) {
      await recordRule("planner", {
        when: `Proposing a task touching ${task.scopeBoundary.in.length}+ files`,
        check: `This scope size has worked before — but verify each file is actually needed`,
        because: `${cycleId}: "${task.title}" merged with ${task.scopeBoundary.in.length} files in scope — broad but successful`,
        cycleId,
        severity: "reinforce",
      });
    }
    // Normal merges without scope creep: skip (noise)
    return;
  }

  if (finalState === "failed") {
    const reason = context.failReason || "verification failed";
    await recordRule("planner", {
      when: `Proposing tasks similar to "${task.title}"`,
      check: `${context.failedSteps?.length > 0 ? `Will ${context.failedSteps.join(" + ")} pass?` : "Does the verification plan cover the change?"} ${task.scopeBoundary?.in?.length > 3 ? `Scope is broad (${task.scopeBoundary.in.length} files) — consider narrowing.` : ""}`,
      because: `${cycleId}: Failed — ${reason}`,
      cycleId,
      severity: "prevent",
    });
    return;
  }

  if (finalState === "rolled-back") {
    await recordRule("planner", {
      when: `Proposing changes to ${(task.scopeBoundary?.in || []).join(", ") || "these files"}`,
      check: `Will this change cause test regressions? Previous change to these files was auto-reverted.`,
      because: `${cycleId}: "${task.title}" merged but regressed tests and was auto-reverted`,
      cycleId,
      severity: "prevent",
    });
    return;
  }

  if (finalState === "abandoned") {
    const reason = context.reason || "rejected or drift";
    if (reason.includes("Drift")) {
      await recordRule("planner", {
        when: `Proposing work similar to "${task.title}"`,
        check: `Has this exact work already been done? Check recent cycle history for duplicates.`,
        because: `${cycleId}: Abandoned — ${reason}`,
        cycleId,
        severity: "prevent",
      });
    } else {
      await recordRule("planner", {
        when: `Proposing tasks like "${task.title}"`,
        check: `Is this anchored to real evidence? Is the scope bounded? The skeptic rejected a similar task.`,
        because: `${cycleId}: Abandoned — ${reason}`,
        cycleId,
        severity: "prevent",
      });
    }
  }
}

/**
 * Record executor outcome — only failures and surprising results.
 */
export async function recordExecutorLesson(cycleId, task, finalState, context = {}) {
  if (finalState === "merged") {
    // Skip normal merges (noise)
    return;
  }

  if (finalState === "failed") {
    if (context.noDiff) {
      await recordRule("executor", {
        when: `Executing "${task.title}" or similar tasks`,
        check: `Did you actually write code and commit? Previous attempt produced zero changes.`,
        because: `${cycleId}: No code changes produced — executor finished without modifying any files`,
        cycleId,
        severity: "prevent",
      });
    } else if (context.failedSteps?.length > 0) {
      const stderr = context.verificationStderr?.slice(0, 200) || "";
      await recordRule("executor", {
        when: `Modifying ${(task.scopeBoundary?.in || []).slice(0, 3).join(", ") || "these files"}`,
        check: `Run \`npm test\` and \`npm run typecheck\` before committing. ${context.failedSteps.join(" + ")} failed last time.`,
        because: `${cycleId}: Verification failed on ${context.failedSteps.join(", ")}${stderr ? ". Error: " + stderr : ""}`,
        cycleId,
        severity: "prevent",
      });
    }
    return;
  }

  if (finalState === "rolled-back") {
    await recordRule("executor", {
      when: `Modifying ${(task.scopeBoundary?.in || []).slice(0, 3).join(", ") || "these files"}`,
      check: `Run the FULL test suite, not just the tests you think are relevant. A previous change to these files broke tests elsewhere.`,
      because: `${cycleId}: "${task.title}" passed verification but tests went from ${context.testsBefore} → ${context.testsAfter} after merge — auto-reverted`,
      cycleId,
      severity: "prevent",
    });
  }
}

/**
 * Record skeptic outcome — only bad calls (approved something that failed).
 */
export async function recordSkepticLesson(cycleId, task, skepticVerdict, finalState) {
  if (skepticVerdict === "approve" && (finalState === "failed" || finalState === "rolled-back")) {
    // Skeptic approved something that failed — should have been more skeptical
    await recordRule("skeptic", {
      when: `Reviewing tasks similar to "${task.title}"`,
      check: `You approved a similar task that ${finalState}. Is this one REALLY different? Check scope boundary and verification plan more carefully.`,
      because: `${cycleId}: Approved "${task.title}" — it ${finalState}. Should have caught this.`,
      cycleId,
      severity: "prevent",
    });
    return;
  }

  if (skepticVerdict === "reject" && finalState === "abandoned") {
    // Skeptic rejected something — record the pattern for future reference
    await recordRule("skeptic", {
      when: `Reviewing tasks that touch ${(task.scopeBoundary?.in || []).slice(0, 3).join(", ") || "similar files"}`,
      check: `Previous rejection in this area was correct. Keep standards high for this kind of work.`,
      because: `${cycleId}: Correctly rejected "${task.title}" — pattern confirmed`,
      cycleId,
      severity: "reinforce",
    });
  }

  // Skeptic approved something that merged: skip (noise — good calls are expected)
}

/**
 * Compound step — extract structured rules from a completed cycle.
 * Called as Step 8.5 in the control loop, after the reality report.
 *
 * This is the Sage-inspired "self-learning" mechanism: the system
 * explicitly asks "what should prevent this failure in the future?"
 * after every cycle, not just when someone remembers to document it.
 *
 * @param {object} report - The cycle's reality report
 * @param {object} task - The planned task
 * @param {object} anchor - The anchor that triggered the cycle
 */
export async function compoundLearnings(report, task, anchor) {
  const cycleId = report.cycleId;
  const finalState = report.task?.finalState;

  // Delegate to the per-agent lesson recorders
  try {
    if (finalState === "merged" || finalState === "failed" || finalState === "rolled-back" || finalState === "abandoned") {
      await recordPlannerLesson(cycleId, task, finalState, {
        filesChanged: report.filesChanged?.length || 0,
        failReason: report.regressionIntroduced
          ? `Regression: tests ${report.grounding?.before?.passed} → ${report.grounding?.after?.passed}`
          : report.verification?.steps?.filter(s => !s.passed).map(s => s.label).join(", ") || undefined,
        failedSteps: report.verification?.steps?.filter(s => !s.passed).map(s => s.label),
        reason: report.task?.finalState === "abandoned" ? "drift or rejection" : undefined,
      });

      await recordExecutorLesson(cycleId, task, finalState, {
        testsBefore: report.grounding?.before?.passed,
        testsAfter: report.grounding?.after?.passed,
        failedSteps: report.verification?.steps?.filter(s => !s.passed).map(s => s.label),
        noDiff: finalState === "failed" && (report.filesChanged?.length || 0) === 0,
      });
    }
  } catch (err) {
    console.error(`[Compound] Failed to extract learnings from ${cycleId}: ${err.message}`);
  }
}

/**
 * Format agent memory for inclusion in a prompt.
 * Presents WHEN/CHECK/BECAUSE rules as actionable prevention instructions.
 */
export function formatMemoryForPrompt(memory, agentName) {
  if (!memory || memory.trim().length === 0) return "";

  // Extract rule blocks (each starts with ### [)
  const rules = memory.split(/^(?=### \[)/m).filter(r => r.trim().startsWith("### ["));
  if (rules.length === 0) {
    // Fallback: try legacy format (lines starting with "- **")
    const lines = memory.split("\n").filter(l => l.startsWith("- **"));
    if (lines.length === 0) return "";
    const recent = lines.slice(-15);
    return `\n## PAST OUTCOMES (learn from these)\n${recent.join("\n")}\n`;
  }

  // Show most recent prevention rules (most relevant)
  const preventRules = rules.filter(r => r.includes("[prevent]"));
  const reinforceRules = rules.filter(r => r.includes("[reinforce]"));

  const parts = [];
  if (preventRules.length > 0) {
    parts.push(`\n## PREVENTION RULES (follow these — verified through real failures)`);
    // Show last 10 prevention rules
    for (const rule of preventRules.slice(-10)) {
      // Extract just the WHEN/CHECK/BECAUSE lines
      const lines = rule.split("\n").filter(l =>
        l.startsWith("WHEN:") || l.startsWith("CHECK:") || l.startsWith("BECAUSE:")
      );
      if (lines.length > 0) parts.push(lines.join("\n"));
    }
  }

  if (reinforceRules.length > 0 && reinforceRules.length <= 5) {
    parts.push(`\n## REINFORCED PATTERNS (these approaches have worked)`);
    for (const rule of reinforceRules.slice(-5)) {
      const lines = rule.split("\n").filter(l =>
        l.startsWith("WHEN:") || l.startsWith("CHECK:") || l.startsWith("BECAUSE:")
      );
      if (lines.length > 0) parts.push(lines.join("\n"));
    }
  }

  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
}
