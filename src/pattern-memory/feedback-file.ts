/**
 * pattern-memory/feedback-file.ts — the **Feedback File** grammar Module.
 *
 * Owns the markdown grammar of the on-disk prompt-shaping artifact
 * `config/feedback/to-{agent}.md`: its path resolution, its section layout
 * (`## Auto-Promoted Rules` / `## Stale Rules (review needed)`), the
 * `### <category> (Nx since <date>)` promoted-rule block with its
 * `<!-- auto-promoted <date>, last hit <date> -->` trailer, and the three
 * block operations the **Pattern Memory** promotion lifecycle performs:
 *
 *   1. APPEND a promoted block      (`appendPromotedRuleBlock` / `promoteToFeedbackFile`)
 *   2. ARCHIVE stale blocks         (`detectStalePromotedRules` / `processStaleRules` / `consolidateStalePromotedRules`)
 *   3. REMOVE a demoted block       (`removePromotedRuleBlock` / `demotePromotedRuleFromFeedbackFile`)
 *
 * Before issue #940 this grammar was re-derived at three call sites across two
 * modules: `promoteToFeedback` (agent-memory.ts) built the heading and appended;
 * `removePromotedRuleFromFeedback` (rule-effectiveness.ts) parsed the same
 * heading to delete; `processStaleRules` (agent-memory.ts) archived stale blocks.
 * Each independently spelled the file path, opened the file, and re-implemented
 * its own slice of the read-modify-write over the same markdown. The only thing
 * keeping the writer and the two readers in sync was a doc comment. This Module
 * gives the grammar exactly one definition; the three callers delegate here and
 * keep only their domain logic (which patterns to promote/demote/archive).
 *
 * The on-disk byte format is UNCHANGED — this concentrates *where the grammar
 * is defined*, not the format itself. The pure transforms take/return raw
 * markdown content so they stay testable with no I/O; the side-effecting
 * wrappers (read → transform → write) are the only file-touching surface.
 *
 * Never throws — feedback-file I/O is best-effort (log + swallow), mirroring the
 * "never throw from grounding/verification" convention so a transient disk
 * error can't break the daily consolidation pass or a `recordPattern` hit.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");

// ===========================================================================
// Grammar constants — the single definition of the Feedback File format
// ===========================================================================

/** Heading of the section promoted rules live in. */
export const AUTO_PROMOTED_SECTION = "## Auto-Promoted Rules";
/** Heading of the section 30-day-stale rules are parked in for operator review. */
export const STALE_RULES_SECTION = "## Stale Rules (review needed)";

/** Preamble emitted when the Auto-Promoted section is first created. */
const AUTO_PROMOTED_PREAMBLE =
  "Rules below were auto-promoted from agent memory after proving themselves\n" +
  "across multiple cycles. They represent durable patterns, not one-off incidents.\n";

/** Preamble emitted when the Stale Rules section is first created. */
const STALE_RULES_PREAMBLE =
  "Rules below have not fired in >30 days. Review and remove if no longer relevant.\n";

/** Resolve the on-disk path for an agent's feedback file (`to-{agent}.md`). */
export function feedbackFilePath(agentName: string): string {
  return join(CONFIG_PATH, "feedback", `to-${agentName}.md`);
}

/**
 * The shape `appendPromotedRuleBlock` consumes — exactly the four fields the
 * promoted-rule block renders. Kept structural (not the full `MemoryPattern`)
 * so this Module owns the grammar without depending on the Pattern Memory store.
 */
export type PromotedRuleInput = {
  category: string;
  hitCount: number;
  firstSeen: string;
  action: string;
  lastCycleId: string;
  examples: string[];
  lastSeen: string;
};

// ===========================================================================
// Operation 1 — APPEND a promoted block (was promoteToFeedback)
// ===========================================================================

/**
 * Render the canonical promoted-rule block for a pattern. The single source of
 * the `### <category> (Nx since <date>)` heading format + the
 * `<!-- auto-promoted <date>, last hit <date> -->` trailer that the remove/
 * archive readers parse against.
 */
export function renderPromotedRuleBlock(p: PromotedRuleInput, today: string): string {
  return [
    ``,
    `### ${p.category} (${p.hitCount}x since ${p.firstSeen})`,
    p.action,
    `Last: ${p.lastCycleId} (${p.examples[0] || "no example"})`,
    `<!-- auto-promoted ${today}, last hit ${p.lastSeen} -->`,
  ].join("\n");
}

/**
 * Pure transform — append a promoted-rule block to feedback content. Inserts
 * after the existing `## Auto-Promoted Rules` header when present, otherwise
 * creates the section (with its preamble) at the end. Returns the new content.
 */
export function appendPromotedRuleBlock(
  feedbackContent: string,
  p: PromotedRuleInput,
  today: string = new Date().toISOString().split("T")[0],
): string {
  const ruleBlock = renderPromotedRuleBlock(p, today);
  if (feedbackContent.includes(AUTO_PROMOTED_SECTION)) {
    return feedbackContent.replace(AUTO_PROMOTED_SECTION, AUTO_PROMOTED_SECTION + "\n" + ruleBlock);
  }
  return (
    feedbackContent +
    "\n\n" +
    AUTO_PROMOTED_SECTION +
    "\n\n" +
    AUTO_PROMOTED_PREAMBLE +
    ruleBlock
  );
}

/**
 * Side-effecting — read `to-{agent}.md`, append the promoted block, write back.
 * Best-effort: logs + swallows I/O errors (the file may not exist yet on a
 * fresh checkout, in which case there is nothing to promote into).
 */
export async function promoteToFeedbackFile(
  agentName: string,
  p: PromotedRuleInput,
): Promise<void> {
  const feedbackPath = feedbackFilePath(agentName);
  try {
    const content = await readFile(feedbackPath, "utf-8");
    const today = new Date().toISOString().split("T")[0];
    await writeFile(feedbackPath, appendPromotedRuleBlock(content, p, today));
  } catch (err: any) {
    console.error(`[Learning] Failed to promote to ${feedbackPath}: ${err.message}`);
  }
}

// ===========================================================================
// Operation 2 — ARCHIVE stale blocks (was detect/processStaleRules)
// ===========================================================================

export type StaleRule = {
  heading: string;
  promotedDate: string;
  lastHitDate: string;
  daysSinceLastHit: number;
  fullBlock: string;
};

/**
 * Parse auto-promoted rules from feedback content and bucket them by staleness.
 * Pure function for testability — no I/O.
 *
 * @param feedbackContent - raw markdown content of a feedback file
 * @param agentName - agent name for logging
 * @param now - reference date (default: today)
 * @returns { active, stale30, stale60 } — rules bucketed by staleness
 */
export function detectStalePromotedRules(
  feedbackContent: string,
  agentName: string,
  now: Date = new Date(),
): { active: StaleRule[]; stale30: StaleRule[]; stale60: StaleRule[] } {
  const active: StaleRule[] = [];
  const stale30: StaleRule[] = [];
  const stale60: StaleRule[] = [];

  // Match rule blocks: ### heading ... <!-- auto-promoted ... -->
  // A rule block starts with ### and ends at the next ### or ## or end of content
  const autoPromotedSection = feedbackContent.indexOf(AUTO_PROMOTED_SECTION);
  if (autoPromotedSection === -1) return { active, stale30, stale60 };

  const staleSection = feedbackContent.indexOf(STALE_RULES_SECTION);
  const sectionEnd = staleSection !== -1 ? staleSection : feedbackContent.length;
  const sectionContent = feedbackContent.slice(autoPromotedSection, sectionEnd);

  // Split into rule blocks by ### headings
  const ruleBlockRegex = /^### .+$/gm;
  const headings: { index: number; match: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ruleBlockRegex.exec(sectionContent)) !== null) {
    headings.push({ index: m.index, match: m[0] });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : sectionContent.length;
    const block = sectionContent.slice(start, end).trimEnd();
    const heading = headings[i].match;

    // Parse the auto-promoted comment
    const commentMatch = block.match(
      /<!--\s*auto-promoted\s+(\d{4}-\d{2}-\d{2})(?:,?\s*last\s+hit\s+(\d{4}-\d{2}-\d{2}))?\s*-->/
    );
    if (!commentMatch) continue;

    const promotedDate = commentMatch[1];
    const lastHitDate = commentMatch[2] || promotedDate;

    const lastHit = new Date(lastHitDate + "T00:00:00Z");
    const diffMs = now.getTime() - lastHit.getTime();
    const daysSinceLastHit = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const rule: StaleRule = {
      heading,
      promotedDate,
      lastHitDate,
      daysSinceLastHit,
      fullBlock: block,
    };

    if (daysSinceLastHit > 60) {
      stale60.push(rule);
      console.log(`[Learning] Stale rule (>60d): ${heading} in to-${agentName}.md — last hit ${lastHitDate} (${daysSinceLastHit}d ago)`);
    } else if (daysSinceLastHit > 30) {
      stale30.push(rule);
      console.log(`[Learning] Stale rule (>30d): ${heading} in to-${agentName}.md — last hit ${lastHitDate} (${daysSinceLastHit}d ago)`);
    } else {
      active.push(rule);
    }
  }

  return { active, stale30, stale60 };
}

/**
 * Process feedback file content: move 30-day stale rules to a review section,
 * remove 60-day stale rules entirely (returned for archival logging).
 * Pure function — returns the new file content.
 *
 * @param feedbackContent - raw markdown content
 * @param agentName - agent name for logging
 * @param now - reference date (default: today)
 * @returns { newContent, archived } — updated content and removed rules
 */
export function processStaleRules(
  feedbackContent: string,
  agentName: string,
  now: Date = new Date(),
): { newContent: string; archived: StaleRule[] } {
  const { stale30, stale60 } = detectStalePromotedRules(feedbackContent, agentName, now);

  if (stale30.length === 0 && stale60.length === 0) {
    return { newContent: feedbackContent, archived: [] };
  }

  let content = feedbackContent;

  // Remove stale60 rules entirely (auto-archived)
  for (const rule of stale60) {
    content = content.replace(rule.fullBlock, "");
  }

  // Move stale30 rules from their current position to the stale section
  for (const rule of stale30) {
    content = content.replace(rule.fullBlock, "");
  }

  // Clean up multiple blank lines that result from removals
  content = content.replace(/\n{3,}/g, "\n\n");

  // Build the stale section for 30-day rules (review needed)
  if (stale30.length > 0) {
    const existingStaleIdx = content.indexOf(STALE_RULES_SECTION);

    const staleBlocks = stale30.map(r => r.fullBlock).join("\n\n");

    if (existingStaleIdx !== -1) {
      // Append to existing stale section
      const insertPoint = existingStaleIdx + STALE_RULES_SECTION.length;
      content = content.slice(0, insertPoint) + "\n\n" + staleBlocks + content.slice(insertPoint);
    } else {
      // Add new stale section at the end
      content = content.trimEnd() + "\n\n" + STALE_RULES_SECTION + "\n\n" +
        STALE_RULES_PREAMBLE + "\n" +
        staleBlocks + "\n";
    }
  }

  return { newContent: content, archived: stale60 };
}

/**
 * Side-effecting — run staleness detection across the planner/executor/skeptic
 * feedback files and rewrite any that changed. Called during daily consolidation.
 * Best-effort per file: logs + swallows I/O errors.
 */
export async function consolidateStalePromotedRules(): Promise<void> {
  for (const agent of ["planner", "executor", "skeptic"]) {
    const feedbackPath = feedbackFilePath(agent);
    try {
      const content = await readFile(feedbackPath, "utf-8");
      const { newContent, archived } = processStaleRules(content, agent);

      if (newContent !== content) {
        await writeFile(feedbackPath, newContent);

        if (archived.length > 0) {
          for (const rule of archived) {
            console.log(`[Learning] Archived stale rule from to-${agent}.md: ${rule.heading} (last hit ${rule.lastHitDate}, ${rule.daysSinceLastHit}d ago)`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to process stale rules for to-${agent}.md: ${err.message}`);
    }
  }
}

// ===========================================================================
// Operation 3 — REMOVE a demoted block (was removePromotedRuleFromFeedback)
// ===========================================================================

/**
 * Pure transform — remove a promoted-rule block from feedback content by
 * category heading. Returns `{ newContent, removed }` so the caller can decide
 * whether to write the file. The match is anchored to `### <category> (` —
 * exactly the heading format `renderPromotedRuleBlock` produces. (Both now live
 * in this Module, so the writer/reader coupling is structural, not a comment.)
 */
export function removePromotedRuleBlock(
  feedbackContent: string,
  category: string,
): { newContent: string; removed: boolean } {
  const autoPromotedIdx = feedbackContent.indexOf(AUTO_PROMOTED_SECTION);
  if (autoPromotedIdx === -1) return { newContent: feedbackContent, removed: false };

  const staleIdx = feedbackContent.indexOf(STALE_RULES_SECTION, autoPromotedIdx);
  const sectionEnd = staleIdx !== -1 ? staleIdx : feedbackContent.length;
  const sectionContent = feedbackContent.slice(autoPromotedIdx, sectionEnd);

  // Find headings inside the Auto-Promoted section. The block goes from this
  // heading up to the next ### (or end of section).
  const headingRegex = /^### .+$/gm;
  const headings: { index: number; match: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(sectionContent)) !== null) {
    headings.push({ index: m.index, match: m[0] });
  }

  // Match heading that starts with `### <category> (` — the format produced
  // by renderPromotedRuleBlock().
  const headingPrefix = `### ${category} (`;
  const targetIdx = headings.findIndex(h => h.match.startsWith(headingPrefix));
  if (targetIdx === -1) return { newContent: feedbackContent, removed: false };

  const target = headings[targetIdx];
  const blockStartInSection = target.index;
  const blockEndInSection =
    targetIdx + 1 < headings.length ? headings[targetIdx + 1].index : sectionContent.length;

  const absStart = autoPromotedIdx + blockStartInSection;
  const absEnd = autoPromotedIdx + blockEndInSection;

  let newContent = feedbackContent.slice(0, absStart) + feedbackContent.slice(absEnd);
  // Collapse triple+ newlines produced by the removal.
  newContent = newContent.replace(/\n{3,}/g, "\n\n");
  return { newContent, removed: true };
}

/**
 * Side-effecting wrapper — remove a promoted rule block from
 * `config/feedback/to-{agent}.md`. Returns true when the file was rewritten.
 * Best-effort: logs + swallows I/O errors.
 */
export async function demotePromotedRuleFromFeedbackFile(
  agentName: string,
  category: string,
): Promise<boolean> {
  const feedbackPath = feedbackFilePath(agentName);
  try {
    const content = await readFile(feedbackPath, "utf-8");
    const { newContent, removed } = removePromotedRuleBlock(content, category);
    if (!removed || newContent === content) return false;
    await writeFile(feedbackPath, newContent);
    return true;
  } catch (err: any) {
    console.error(
      `[Learning] demotePromotedRuleFromFeedbackFile(${agentName}, ${category}) failed: ${err.message}`,
    );
    return false;
  }
}
