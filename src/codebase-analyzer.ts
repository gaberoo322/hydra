/**
 * Codebase Analyzer
 *
 * Produces a structured snapshot of the target project's current state.
 * Used by the research loop to give researchers concrete facts about
 * what exists, what's tested, and what's missing — instead of vague
 * grounding summaries.
 *
 * Output: structured JSON that the Director agent uses to identify gaps
 * between the operator's vision and reality.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, extname, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTargetWorkspace } from "./target-config.ts";

const execFileAsync = promisify(execFile);
const PROJECT_WORKSPACE = getTargetWorkspace();

/**
 * Analyze the target project and produce structured state.
 */
export async function analyzeCodebase(workDir = PROJECT_WORKSPACE) {
  const state = {
    analyzedAt: new Date().toISOString(),
    workspace: workDir,
    modules: {},
    apiRoutes: [],
    pages: [],
    runners: [],
    providers: [],
    execution: [],
    database: { migrations: 0, tables: [] },
    tests: { total: 0, files: 0 },
    dependencies: {},
    recentCommits: [],
    gaps: [],
  };

  try {
    // Find all TypeScript source files (excluding tests, node_modules, .next)
    const allFiles = await findFiles(workDir, ".ts", ["node_modules", ".next", "dist", ".git"]);

    // Categorize files
    for (const file of allFiles) {
      const rel = file.replace(workDir + "/", "");

      if (rel.includes("/api/") && rel.endsWith("route.ts")) {
        // API routes
        const route = "/" + rel
          .replace(/^web\/src\/app/, "")
          .replace(/\/route\.ts$/, "")
          .replace(/\[([^\]]+)\]/g, ":$1");
        state.apiRoutes.push(route);
      } else if (rel.includes("/app/") && rel.endsWith("page.tsx")) {
        // Pages
        const page = "/" + rel
          .replace(/^web\/src\/app/, "")
          .replace(/\/page\.tsx$/, "")
          || "/";
        state.pages.push(page);
      } else if (rel.includes("/bin/") && !rel.includes(".test.")) {
        // CLI runners
        state.runners.push(basename(rel, ".ts"));
      } else if (rel.includes("/providers/") && !rel.includes(".test.")) {
        // Venue providers
        state.providers.push(basename(rel, ".ts"));
      } else if (rel.includes("/execution/") && !rel.includes(".test.")) {
        // Execution modules
        state.execution.push(basename(rel, ".ts"));
      }

      // Test files
      if (rel.includes(".test.") || rel.includes(".spec.")) {
        state.tests.files++;
      }

      // Organize into modules by directory
      const parts = rel.split("/");
      if (parts.length >= 3 && parts[0] === "web" && parts[1] === "src" && parts[2] === "lib") {
        const module = parts[3] || "root";
        if (!state.modules[module]) state.modules[module] = [];
        const fileName = basename(rel, extname(rel));
        if (!rel.includes(".test.")) {
          state.modules[module].push(fileName);
        }
      }
    }

    // Deduplicate module lists
    for (const mod of Object.keys(state.modules)) {
      state.modules[mod] = [...new Set(state.modules[mod])];
    }

    // Get test count from package.json scripts
    try {
      const { stdout } = await execFileAsync("npx", ["vitest", "run", "--reporter=json"], {
        cwd: join(workDir, "web"),
        timeout: 120000,
        env: { ...process.env, CI: "true" },
      });
      const testResult = JSON.parse(stdout);
      state.tests.total = testResult.numTotalTests || 0;
    } catch (err) {
      // Try parsing test count from error output (vitest outputs JSON even on test failure)
      const match = err?.stdout?.match(/"numTotalTests"\s*:\s*(\d+)/);
      if (match) state.tests.total = parseInt(match[1]);
      // Or use the grounding data
    }

    // Get database schema info
    try {
      const drizzleDir = join(workDir, "web", "drizzle");
      const sqlFiles = await findFiles(drizzleDir, ".sql", []);
      state.database.migrations = sqlFiles.length;

      // Parse schema for table names
      const schemaFile = join(workDir, "web", "src", "lib", "db", "schema.ts");
      const schema = await readFile(schemaFile, "utf-8").catch(() => "");
      const tableMatches = schema.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable/g);
      for (const m of tableMatches) state.database.tables.push(m[1]);
    } catch (err: any) {
      console.error(`[CodebaseAnalyzer] Failed to read database schema info: ${err.message}`);
    }

    // Get package.json dependencies
    try {
      const pkg = JSON.parse(await readFile(join(workDir, "web", "package.json"), "utf-8"));
      const deps = Object.keys(pkg.dependencies || {});
      state.dependencies = {
        count: deps.length,
        // "Key" deps = the ones that signal what this target *is* — i.e. the
        // domain/venue-specific packages, not the ubiquitous framework noise.
        // Target-agnostic by construction (ADR-0013): we filter OUT a small set
        // of common framework prefixes rather than allowlisting any particular
        // target's domain packages. Whatever a given target depends on beyond
        // the generic web stack surfaces automatically.
        key: pickDistinctiveDependencies(deps),
      };
    } catch (err: any) {
      console.error(`[CodebaseAnalyzer] Failed to read package.json dependencies: ${err.message}`);
    }

    // Recent git commits (last 10)
    try {
      const { stdout } = await execFileAsync("git", [
        "log", "--oneline", "--no-merges", "-15",
        "--format=%s"
      ], { cwd: workDir, timeout: 5000 });
      state.recentCommits = stdout.trim().split("\n").filter(Boolean);
    } catch (err: any) {
      console.error(`[CodebaseAnalyzer] Failed to read recent git commits: ${err.message}`);
    }

    // Identify gaps
    state.gaps = identifyGaps(state);

  } catch (err) {
    (state as any).error = err.message;
  }

  return state;
}

/**
 * Common web-framework dependency prefixes that every target sharing this
 * Next/React/Drizzle stack carries — these say nothing distinctive about what a
 * target *is*, so they're filtered out of the "key dependencies" signal. This
 * is an EXCLUSION list of generic infrastructure, deliberately containing no
 * target-domain vocabulary (ADR-0013): a new target's domain packages surface
 * automatically because they aren't on this list.
 */
const GENERIC_DEP_PREFIXES = [
  "next", "react", "react-dom", "tailwind", "drizzle", "postgres", "pg",
  "zod", "typescript", "eslint", "prettier", "vitest", "@types/",
  "@radix-ui/", "clsx", "tailwind-merge", "lucide-react", "ws", "dotenv",
];

/**
 * Pick the dependencies that distinguish this target from a generic web app —
 * i.e. everything that isn't part of the common framework stack. Target-agnostic
 * by construction: no venue/domain names are hardcoded.
 */
export function pickDistinctiveDependencies(deps: string[]): string[] {
  return deps.filter(
    d => !GENERIC_DEP_PREFIXES.some(p => d === p || d.startsWith(p)),
  );
}

/**
 * Identify structural gaps between what exists and what a deployable product
 * needs. Target-agnostic (ADR-0013): the heuristics reason about generic
 * software structure (end-to-end runners, automation, reporting endpoints,
 * navigation, commit cadence) — never a specific target's venues or domain
 * vocabulary.
 */
function identifyGaps(state) {
  const gaps = [];

  // Execution wiring: lifecycle/execution modules with no end-to-end runner.
  const hasExecutionModules = state.execution.length > 0;
  const hasExecutionRunner = state.runners.some(r => r.includes("execution") || r.includes("runner"));
  if (hasExecutionModules && !hasExecutionRunner) {
    gaps.push("Execution/lifecycle modules exist but no end-to-end runner wires them together");
  }

  // Navigation
  if (state.pages.length > 3) {
    gaps.push(`${state.pages.length} pages exist but may lack unified navigation`);
  }

  // Automation: runners exist but nothing schedules them.
  const hasScheduler = state.runners.some(r => r.includes("run-cycle") || r.includes("scan") || r.includes("cron") || r.includes("schedul"));
  if (state.runners.length > 0 && !hasScheduler) {
    gaps.push("Runners exist but no automated schedule — need cron/systemd integration");
  }

  // Reporting: API surface exists but no outcome/metrics reporting endpoint.
  const hasReporting = state.apiRoutes.some(r => r.includes("metric") || r.includes("report") || r.includes("stat") || r.includes("dashboard"));
  if (state.apiRoutes.length > 0 && !hasReporting) {
    gaps.push("No outcome/metrics reporting endpoint");
  }

  // Momentum: recent work skewed toward defensive hardening over features.
  const recentWork = state.recentCommits.join(" ").toLowerCase();
  if (recentWork.includes("fail closed") || recentWork.includes("guard") || recentWork.includes("preflight")) {
    gaps.push("Recent work is predominantly defensive hardening — feature development stalled");
  }

  return gaps;
}

/**
 * Recursively find files with a given extension.
 */
async function findFiles(dir, ext, skipDirs) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipDirs.includes(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await findFiles(fullPath, ext, skipDirs));
      } else if (entry.name.endsWith(ext) || entry.name.endsWith(ext + "x")) {
        results.push(fullPath);
      }
    }
  } catch (err: any) {
    console.error(`[CodebaseAnalyzer] findFiles failed for ${dir}: ${err.message}`);
  }
  return results;
}

/**
 * Format codebase state for agent prompts — concise, structured.
 */
export function formatStateForPrompt(state) {
  const parts = [
    `## CODEBASE STATE (analyzed ${state.analyzedAt})`,
    "",
    `**Tests:** ${state.tests.total} total across ${state.tests.files} test files`,
    `**API Routes:** ${state.apiRoutes.length} (${state.apiRoutes.slice(0, 10).join(", ")}${state.apiRoutes.length > 10 ? "..." : ""})`,
    `**Pages:** ${state.pages.join(", ") || "none"}`,
    `**Runners:** ${state.runners.join(", ") || "none"}`,
    `**Providers:** ${state.providers.join(", ") || "none"}`,
    `**Execution:** ${state.execution.join(", ") || "none"}`,
    `**Database:** ${state.database.migrations} migrations, tables: ${state.database.tables.join(", ") || "none"}`,
    `**Dependencies:** ${state.dependencies.count || 0} packages (key: ${(state.dependencies.key || []).join(", ")})`,
    "",
    `**Modules:**`,
    ...Object.entries(state.modules).map(([mod, files]) => `  - ${mod}: ${(files as string[]).join(", ")}`),
    "",
    `**Recent commits:**`,
    ...state.recentCommits.slice(0, 10).map(c => `  - ${c}`),
  ];

  if (state.gaps.length > 0) {
    parts.push("", `**Identified gaps:**`);
    for (const gap of state.gaps) parts.push(`  - ${gap}`);
  }

  return parts.join("\n");
}
