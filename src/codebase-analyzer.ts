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

const execFileAsync = promisify(execFile);
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

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
    } catch {}

    // Get package.json dependencies
    try {
      const pkg = JSON.parse(await readFile(join(workDir, "web", "package.json"), "utf-8"));
      state.dependencies = {
        count: Object.keys(pkg.dependencies || {}).length,
        key: Object.keys(pkg.dependencies || {}).filter(d =>
          d.includes("kalshi") || d.includes("polymarket") || d.includes("drizzle") ||
          d.includes("next") || d.includes("react") || d.includes("tailwind")
        ),
      };
    } catch {}

    // Recent git commits (last 10)
    try {
      const { stdout } = await execFileAsync("git", [
        "log", "--oneline", "--no-merges", "-15",
        "--format=%s"
      ], { cwd: workDir, timeout: 5000 });
      state.recentCommits = stdout.trim().split("\n").filter(Boolean);
    } catch {}

    // Identify gaps
    state.gaps = identifyGaps(state);

  } catch (err) {
    (state as any).error = err.message;
  }

  return state;
}

/**
 * Identify gaps between what exists and what a trading platform needs.
 */
function identifyGaps(state) {
  const gaps = [];

  // Check for execution runners
  const hasKalshiRunner = state.runners.some(r => r.includes("kalshi-execution"));
  const hasPolymarketRunner = state.runners.some(r => r.includes("polymarket") && r.includes("execution"));
  if (!hasPolymarketRunner) gaps.push("No Polymarket execution runner — executor and lifecycle modules exist but no end-to-end runner");

  // Check for navigation
  if (state.pages.length > 3) {
    gaps.push(`${state.pages.length} pages exist but may lack unified navigation`);
  }

  // Check for automation
  const hasScheduler = state.runners.some(r => r.includes("run-cycle") || r.includes("scanner-runner"));
  if (!hasScheduler) gaps.push("No automated trading schedule — runners exist but need cron/systemd integration");

  // Check for P&L tracking
  const hasPnL = state.apiRoutes.some(r => r.includes("bankroll") || r.includes("pnl"));
  if (!hasPnL) gaps.push("No P&L dashboard endpoint");

  // Check for live vs demo
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
  } catch {}
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
