#!/usr/bin/env -S npx tsx
/**
 * GitHub-Seam check — GitHub CLI Adapter closure ratchet (issue #899).
 *
 * The **GitHub CLI Adapter** Seam (`src/github/*`, issues #896/#897) owns the
 * `gh`/`git` external-process boundary: one private spawn primitive
 * (`src/github/exec.ts`) concentrates the binary resolution, the timeout
 * discipline, and the four error modes, and the typed accessors
 * `ghExec`/`ghJson`/`gitExec` are its only callers. CONTEXT.md predicted —
 * exactly as ADR-0009 (Redis) and ADR-0011 (Schemas) did before it — that prose
 * discipline alone keeps the Seam from closing. This is the CI backstop that
 * freezes the drift: it forbids a raw `node:child_process` import from any file
 * outside `src/github/`.
 *
 * This mirrors the ADR-0009 `redis-seam-check.ts` mechanic exactly: a pure,
 * unit-testable predicate plus a shrink-only baseline, and it lands in a
 * SEPARATE workflow (`.github/workflows/github-seam.yml`), NOT as a step in
 * `ci.yml`. `ci.yml` is exact-match Verifier Core (Tier-4); a sibling workflow
 * keeps this PR Tier-3 and auto-mergeable, mirroring the `schema-seam.yml` /
 * `coupling-check.yml` precedent.
 *
 * Scope: `src/github/*` is exempt (it IS the seam — `exec.ts` owns the one
 * sanctioned `spawn`). `src/exec-with-timeout.ts` is ALSO exempt: it is a
 * separate process-group-aware primitive for test-runner subprocesses, NOT a
 * `gh`/`git` caller (CONTEXT.md GitHub CLI Adapter entry calls this out
 * explicitly).
 *
 * Implements a baseline ratchet: existing violations live in
 * `scripts/ci/github-seam-baseline.json` and are tolerated. New violations fail
 * the gate. The baseline is allowed to *shrink* but not grow — any caller that
 * gets migrated to the seam must be removed from the baseline, and a future
 * caller that re-introduces a raw `node:child_process` import is caught on its
 * own merits.
 *
 * Usage:
 *   npx tsx scripts/ci/github-seam-check.ts
 *   npm run github-seam-check
 *
 * Update flow when intentionally migrating a caller:
 *   1. Remove the `node:child_process` import; route `gh`/`git` through the seam.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Any import of `node:child_process` (static `from`, or a `require`/dynamic-import form). */
const CHILD_PROCESS_PATTERNS = [
  /from\s+['"]node:child_process['"]/,
  /from\s+['"]child_process['"]/,
  /require\(\s*['"]node:child_process['"]\s*\)/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /import\(\s*['"]node:child_process['"]\s*\)/,
  /import\(\s*['"]child_process['"]\s*\)/,
];

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SRC_DIR = join(REPO_ROOT, "src");
const GITHUB_DIR = join(SRC_DIR, "github");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/github-seam-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

/**
 * Files outside `src/github/*` that may still import `node:child_process`
 * because they spawn a binary OTHER than `gh`/`git` (so they are not part of
 * the GitHub boundary). They are NOT seam violations and so must never be
 * flagged or baselined:
 *   - src/exec-with-timeout.ts — process-group-aware test-runner subprocess
 *     primitive (CONTEXT.md GitHub CLI Adapter entry exempts it explicitly).
 *   - src/autopilot/log.ts     — spawns `journalctl`, not `gh`/`git`.
 *   - src/index.ts             — dynamic execFile import for a non-gh/git use.
 * `src/api/health.ts` is deliberately NOT exempt — it spawns `df`/`free`/
 * `systemctl` AND owns one migrated `git` call, so it stays a tolerated
 * baseline entry (shrinkable if its host probes ever move behind a seam).
 */
const NON_GITHUB_SPAWNERS = new Set<string>([
  "src/exec-with-timeout.ts",
  "src/autopilot/log.ts",
  "src/index.ts",
]);

interface BaselineFile {
  /** Sorted list of `src/...` paths whose `node:child_process` import is tolerated. */
  callers: string[];
  /** Free-form note explaining when this baseline was last regenerated. */
  note: string;
}

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * import `node:child_process`? Exported so the regression test can pin the
 * grammar without shelling out to git. `relPath` decides the
 * non-GitHub-spawner carve-out; pass a `src/...` path.
 */
export function fileViolatesGithubSeam(relPath: string, body: string): boolean {
  if (NON_GITHUB_SPAWNERS.has(relPath)) return false;
  for (const re of CHILD_PROCESS_PATTERNS) {
    if (re.test(body)) return true;
  }
  return false;
}

async function listTrackedSrcFiles(): Promise<string[]> {
  // git ls-files is faster and respects .gitignore.
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "src/*.ts", "src/**/*.ts"],
    { cwd: REPO_ROOT },
  );
  return stdout
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

function isInsideGithubDir(absolutePath: string): boolean {
  return absolutePath === GITHUB_DIR || absolutePath.startsWith(GITHUB_DIR + "/");
}

async function findViolations(): Promise<string[]> {
  const tracked = await listTrackedSrcFiles();
  const violations: string[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    if (isInsideGithubDir(abs)) continue;
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (fileViolatesGithubSeam(relPath, body)) {
      violations.push(relPath);
    }
  }
  return violations.sort();
}

async function loadBaseline(): Promise<BaselineFile> {
  try {
    const raw = await readFile(BASELINE_PATH, "utf8");
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return { callers: [], note: "baseline not yet seeded" };
  }
}

async function writeBaselineFile(callers: string[]): Promise<void> {
  const payload: BaselineFile = {
    callers,
    note: `Auto-generated by scripts/ci/github-seam-check.ts --write-baseline on ${new Date().toISOString()}. GitHub CLI Adapter closure ratchet (issue #899): shrink only.`,
  };
  await writeFile(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main(): Promise<number> {
  const violations = await findViolations();

  if (WRITE_BASELINE) {
    await writeBaselineFile(violations);
    console.log(`[github-seam-check] Wrote baseline with ${violations.length} entries to ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return 0;
  }

  const baseline = await loadBaseline();
  const baselineSet = new Set(baseline.callers);
  const violationSet = new Set(violations);

  const newViolations = violations.filter(v => !baselineSet.has(v));
  const fixedCallers = baseline.callers.filter(c => !violationSet.has(c));

  if (newViolations.length > 0) {
    console.error("[github-seam-check] NEW GitHub-seam violations (GitHub CLI Adapter, issue #899):");
    for (const v of newViolations) console.error(`  - ${v}`);
    console.error("");
    console.error("These files import node:child_process directly to shell out to gh/git.");
    console.error("Route the call through the seam: ghExec/ghJson (src/github/gh.ts) or");
    console.error("gitExec (src/github/git.ts), discriminating on the returned GhResult `code`.");
    console.error("For a pre-existing execFileAsync-shaped caller, src/github/exec-file-compat.ts");
    console.error("provides a drop-in default that keeps the deps.execFileAsync test seam.");
    return 1;
  }

  if (fixedCallers.length > 0) {
    console.error("[github-seam-check] Baseline is stale — these files no longer violate:");
    for (const c of fixedCallers) console.error(`  - ${c}`);
    console.error("");
    console.error("Re-run with --write-baseline and commit the shrunk baseline.");
    return 1;
  }

  console.log(`[github-seam-check] OK — ${violations.length} known violations, no new ones.`);
  return 0;
}

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    code => process.exit(code),
    err => {
      console.error("[github-seam-check] crash:", err);
      process.exit(2);
    },
  );
}
