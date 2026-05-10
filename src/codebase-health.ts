/**
 * Codebase Health Analyzer
 *
 * Lightweight analysis of the target project to identify the single
 * highest-impact maintainability improvement. Used as an anchor type
 * in the control loop — fires when no higher-priority work exists.
 *
 * Focus areas (all REDUCTIVE — make the codebase smaller/simpler):
 *   - Large files that should be split into focused modules
 *   - Directories with too many files (poor organization)
 *   - Files missing module-level documentation (JSDoc header)
 *   - Deeply nested or complex module structures
 *
 * This module uses ONLY the grounding data already collected (file tree,
 * test report) plus lightweight fs operations. No subprocess calls.
 */

import { readFile } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE
  || (process.env.HOME ? join(process.env.HOME, "hydra-betting") : "");

// Thresholds — tune these based on experience
const LARGE_FILE_LINES = 400;
const LARGE_DIR_FILE_COUNT = 15;
const UNDOCUMENTED_MODULE_SAMPLE = 10;

export type HealthIssue = {
  category: "large-file" | "large-directory" | "missing-docs" | "deep-nesting";
  severity: number;       // 0-100, higher = more impactful to fix
  file?: string;          // file or directory path (relative to project)
  metric: string;         // human-readable metric (e.g., "847 lines")
  suggestion: string;     // what the planner should do
};

export type HealthReport = {
  issues: HealthIssue[];
  topIssue: HealthIssue | null;
  summary: string;
  fileCount: number;
  srcFileCount: number;
  analyzedAt: string;
};

/**
 * Analyze the target project codebase for health issues.
 *
 * @param fileTree - newline-separated list of tracked files (from grounding.fileTree)
 * @param projectRoot - absolute path to project root
 * @returns HealthReport with ranked issues
 */
export async function analyzeCodebaseHealth(
  fileTree: string,
  projectRoot: string = PROJECT_WORKSPACE,
): Promise<HealthReport> {
  const files = fileTree.split("\n").filter(Boolean);
  const srcFiles = files.filter((f) =>
    f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"),
  );
  // Exclude test files and generated files from health analysis
  const productionFiles = srcFiles.filter((f) =>
    !f.includes(".test.") &&
    !f.includes(".spec.") &&
    !f.includes("__test") &&
    !f.includes("node_modules") &&
    !f.includes(".next") &&
    !f.includes("drizzle/"),
  );

  const issues: HealthIssue[] = [];

  // 1. Find large files
  const fileSizes = await measureFileSizes(productionFiles, projectRoot);
  for (const { file, lines } of fileSizes) {
    if (lines > LARGE_FILE_LINES) {
      issues.push({
        category: "large-file",
        severity: Math.min(100, Math.round((lines / LARGE_FILE_LINES) * 40)),
        file,
        metric: `${lines} lines`,
        suggestion: `Split ${file} (${lines} lines) into smaller, focused modules. Identify cohesive sections that can be extracted into separate files with clear single responsibilities. Add a brief JSDoc header to each new module describing its purpose.`,
      });
    }
  }

  // 2. Find overcrowded directories
  const dirCounts = countFilesPerDirectory(productionFiles);
  for (const [dir, count] of dirCounts) {
    if (count > LARGE_DIR_FILE_COUNT) {
      issues.push({
        category: "large-directory",
        severity: Math.min(90, Math.round((count / LARGE_DIR_FILE_COUNT) * 30)),
        file: dir,
        metric: `${count} files`,
        suggestion: `Directory ${dir} has ${count} files. Group related files into subdirectories with index.ts re-exports to improve discoverability and reduce cognitive load. Each subdirectory should have a clear domain boundary.`,
      });
    }
  }

  // 3. Sample production files for missing module-level documentation
  const undocumented = await findUndocumentedModules(productionFiles, projectRoot);
  if (undocumented.length > 0) {
    // Group into one issue with the worst offender
    const worstDir = findMostUndocumentedDirectory(undocumented);
    issues.push({
      category: "missing-docs",
      severity: Math.min(60, undocumented.length * 3),
      file: worstDir.dir,
      metric: `${worstDir.count} undocumented modules in ${worstDir.dir}`,
      suggestion: `Add brief JSDoc module headers to files in ${worstDir.dir} (${worstDir.count} files lack documentation). Each header should describe: what the module does, what depends on it, and any important constraints. This helps agents understand module boundaries without reading the full implementation.`,
    });
  }

  // Sort by severity descending
  issues.sort((a, b) => b.severity - a.severity);
  const topIssue = issues[0] || null;

  const summary = topIssue
    ? `Top health issue: ${topIssue.category} — ${topIssue.file} (${topIssue.metric}). ${issues.length} total issues found.`
    : `Codebase health is good. ${productionFiles.length} production files analyzed, no issues above threshold.`;

  return {
    issues,
    topIssue,
    summary,
    fileCount: files.length,
    srcFileCount: srcFiles.length,
    analyzedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function measureFileSizes(
  files: string[],
  projectRoot: string,
): Promise<Array<{ file: string; lines: number }>> {
  const results: Array<{ file: string; lines: number }> = [];

  for (const file of files) {
    try {
      const content = await readFile(join(projectRoot, file), "utf-8");
      const lines = content.split("\n").length;
      results.push({ file, lines });
    } catch { /* intentional: skip files we can't read (deleted, permissions, etc.) during health scan */ }
  }

  results.sort((a, b) => b.lines - a.lines);
  return results;
}

function countFilesPerDirectory(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = dirname(file);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return counts;
}

async function findUndocumentedModules(
  files: string[],
  projectRoot: string,
): Promise<string[]> {
  const undocumented: string[] = [];
  // Sample a subset to avoid reading the entire codebase
  const sample = files.slice(0, UNDOCUMENTED_MODULE_SAMPLE * 5);

  for (const file of sample) {
    // Only check non-trivial files (not index.ts re-exports, not type-only files)
    const ext = extname(file);
    if (ext !== ".ts" && ext !== ".tsx") continue;
    if (basename(file) === "index.ts") continue;

    try {
      const content = await readFile(join(projectRoot, file), "utf-8");
      const firstLines = content.slice(0, 500);
      // Check for JSDoc comment or a leading // description comment
      const hasDocHeader = /^\/\*\*[\s\S]*?\*\/|^\/\/\s+\w/m.test(firstLines.trimStart());
      // Also accept "use client" or "use server" directives followed by a comment
      const hasDirectiveAndDoc = /^["']use (client|server)["'];\s*\n\s*(\/\*\*|\/\/)/.test(firstLines.trimStart());

      if (!hasDocHeader && !hasDirectiveAndDoc) {
        undocumented.push(file);
      }
    } catch { /* intentional: skip unreadable files during undocumented-module scan */ }
  }

  return undocumented;
}

function findMostUndocumentedDirectory(
  files: string[],
): { dir: string; count: number } {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = dirname(file);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }

  let worstDir = "";
  let worstCount = 0;
  for (const [dir, count] of counts) {
    if (count > worstCount) {
      worstDir = dir;
      worstCount = count;
    }
  }

  return { dir: worstDir || "src", count: worstCount };
}
