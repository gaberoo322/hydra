/**
 * Project Goals
 *
 * Loads and parses the project goals document from config/direction/.
 * This is the "compass" that guides research and prioritization.
 *
 * Expected file: {HYDRA_PATH}/direction/goals.md
 *
 * Format:
 * ---
 * name: Project Name
 * ---
 *
 * ## Success Metrics
 * | Metric | Target | Category | Source |
 * | ... | ... | ... | ... |
 *
 * ## Focus Weights
 * - category: weight (0-100, should sum to 100)
 *
 * ## Constraints
 * - constraint text
 *
 * ## Pain Points
 * - pain point text
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const GOALS_FILE = join(CONFIG_PATH, "direction", "goals.md");

/**
 * Parse the project goals document.
 * Returns a structured object or null if no goals file exists.
 */
export async function loadProjectGoals() {
  let raw;
  try {
    raw = await readFile(GOALS_FILE, "utf-8");
  } catch {
    return null;
  }

  const goals = {
    name: "",
    raw,
    metrics: [],
    weights: {},
    constraints: [],
    painPoints: [],
    customSections: {},
  };

  // Parse YAML-style frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key?.trim() === "name") goals.name = rest.join(":").trim();
    }
  }

  // Split into sections by ## headings
  const sections = {};
  let currentSection = null;
  for (const line of raw.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      currentSection = heading[1].trim().toLowerCase();
      sections[currentSection] = [];
    } else if (currentSection) {
      sections[currentSection].push(line);
    }
  }

  // Parse success metrics table
  if (sections["success metrics"]) {
    const lines = sections["success metrics"].filter(l => l.trim().startsWith("|") && !l.includes("---"));
    const header = lines[0];
    if (header) {
      const headerCols = header.split("|").map(c => c.trim().toLowerCase()).filter(Boolean);
      for (const line of lines.slice(1)) {
        const cols = line.split("|").map(c => c.trim()).filter(Boolean);
        if (cols.length >= 2) {
          const metric = {};
          headerCols.forEach((h, i) => { metric[h] = cols[i] || ""; });
          goals.metrics.push(metric);
        }
      }
    }
  }

  // Parse focus weights
  if (sections["focus weights"]) {
    for (const line of sections["focus weights"]) {
      const match = line.match(/^[-*]\s*(\w[\w\s]*?):\s*(\d+)/);
      if (match) {
        goals.weights[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = parseInt(match[2]);
      }
    }
  }

  // Parse constraints
  if (sections["constraints"]) {
    for (const line of sections["constraints"]) {
      const match = line.match(/^[-*]\s+(.+)/);
      if (match) goals.constraints.push(match[1].trim());
    }
  }

  // Parse pain points
  const painKey = Object.keys(sections).find(k => k.includes("pain point"));
  if (painKey) {
    for (const line of sections[painKey]) {
      const match = line.match(/^[-*]\s+(.+)/);
      if (match) goals.painPoints.push(match[1].trim());
    }
  }

  // Collect any other sections as custom sections (for domain-specific context)
  const knownSections = new Set(["success metrics", "focus weights", "constraints"]);
  if (painKey) knownSections.add(painKey);
  for (const [key, lines] of Object.entries(sections)) {
    if (!knownSections.has(key)) {
      goals.customSections[key] = (lines as string[]).join("\n").trim();
    }
  }

  return goals;
}

/**
 * Format goals for agent prompts — concise structured summary.
 */
export function summarizeGoalsForPrompt(goals) {
  if (!goals) return "No project goals document found. Operating without strategic context.";

  const parts = [];
  parts.push(`## Project Goals: ${goals.name || "Unnamed Project"}`);

  if (goals.metrics.length > 0) {
    parts.push("\n### Success Metrics");
    for (const m of goals.metrics) {
      const source = m.source ? ` (source: ${m.source})` : "";
      parts.push(`- **${m.metric}**: target ${m.target}, category: ${m.category}${source}`);
    }
  }

  if (Object.keys(goals.weights).length > 0) {
    parts.push("\n### Focus Weights (what matters most right now)");
    const sorted = Object.entries(goals.weights).sort((a: any, b: any) => b[1] - a[1]);
    for (const [cat, weight] of sorted) {
      parts.push(`- ${cat}: ${weight}%`);
    }
  }

  if (goals.constraints.length > 0) {
    parts.push("\n### Constraints (must not violate)");
    for (const c of goals.constraints) {
      parts.push(`- ${c}`);
    }
  }

  if (goals.painPoints.length > 0) {
    parts.push("\n### Known Pain Points");
    for (const p of goals.painPoints) {
      parts.push(`- ${p}`);
    }
  }

  for (const [key, content] of Object.entries(goals.customSections)) {
    if ((content as string).trim()) {
      parts.push(`\n### ${key}`);
      parts.push(content);
    }
  }

  // Include operator's north star if loaded (from user-priorities.md)
  if (goals.userPriorities) {
    parts.push("\n### Operator's North Star (from vision.md — this overrides other direction)");
    parts.push(goals.userPriorities.slice(0, 2000));
  }

  return parts.join("\n");
}

export { GOALS_FILE };
