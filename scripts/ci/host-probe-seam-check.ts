#!/usr/bin/env -S npx tsx
/**
 * Host-Probe-Seam check — Host-Probe Adapter closure ratchet (issue #939).
 *
 * The **Host-Probe Adapter** Seam (`src/host-probe/*`) owns the host-info
 * external-process boundary: the `df`/`free`/`systemctl` binaries behind one
 * private spawn primitive (`src/host-probe/exec.ts`) that concentrates the
 * binary resolution, the timeout discipline, and the external-process error
 * modes; the typed `readDisk`/`readMem`/`readServiceStatus` accessors
 * (`src/host-probe/probe.ts`) are its only callers. It is a SIBLING to the
 * **GitHub CLI Adapter** (`src/github/*`, gh/git) — each process Seam owns its
 * own `node:child_process` import, deliberately not collapsed onto one
 * primitive (CONTEXT.md, Host-Probe Adapter).
 *
 * This is the CI backstop that freezes the drift, exactly as
 * `github-seam-check.ts` (issue #899) does for the gh/git boundary and
 * `redis-seam-check.ts` (ADR-0009) does for Redis: it forbids a raw
 * `node:child_process` import from any file outside `src/host-probe/`, EXCEPT
 * the already-owned exec concerns (the GitHub CLI Adapter family, the
 * process-group test-runner primitive, and the two journalctl/dynamic callers).
 *
 * Why a SECOND scanner, given github-seam-check already scans for
 * child_process? They are complementary, not redundant: github-seam-check
 * carves OUT `src/host-probe/*` (so a host-info spawn there is not a gh/git
 * violation), which means it can no longer catch a NEW host-binary spawn that
 * lands outside the family. This ratchet is the guard for that direction — it
 * pins the host-info boundary closed the same way the github ratchet pins the
 * gh/git one. With both in place, every `node:child_process` import in `src/`
 * is owned by exactly one Seam (or one of the three acknowledged exceptions).
 *
 * This lives in its OWN workflow file (`.github/workflows/host-probe-seam.yml`),
 * NOT inside `ci.yml`: `ci.yml` is exact-match Verifier Core (Tier-4); a sibling
 * workflow keeps this PR Tier-3 and auto-mergeable, mirroring the
 * `github-seam.yml` / `schema-seam.yml` precedent.
 *
 * Implements a baseline ratchet: existing tolerated callers live in
 * `scripts/ci/host-probe-seam-baseline.json` and may shrink but not grow.
 *
 * Usage:
 *   npx tsx scripts/ci/host-probe-seam-check.ts
 *   npm run host-probe-seam-check
 *
 * Update flow when intentionally migrating a caller behind the adapter:
 *   1. Remove the `node:child_process` import; route the host-info spawn through
 *      src/host-probe/probe.ts accessors.
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
const HOST_PROBE_DIR = join(REPO_ROOT, "src", "host-probe");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/host-probe-seam-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

/**
 * Files outside `src/host-probe/*` whose `node:child_process` import is OWNED by
 * a different exec concern and so is NOT a host-probe-seam violation. These are
 * the three acknowledged non-host exec callers plus the entire GitHub CLI
 * Adapter family — each is policed by its own discipline (github-seam-check for
 * the family, prose carve-out for the three). The point of the two scanners
 * together: every `node:child_process` in `src/` is owned by exactly one Seam,
 * or one of these exceptions.
 *   - src/exec-with-timeout.ts — process-group-aware test-runner primitive.
 *   - src/autopilot/log.ts     — spawns `journalctl`.
 *   - src/index.ts             — dynamic execFile import for a non-host use.
 */
const NON_HOST_PROBE_SPAWNERS = new Set<string>([
  "src/exec-with-timeout.ts",
  "src/autopilot/log.ts",
  "src/index.ts",
]);

/** The GitHub CLI Adapter family prefix — owns the gh/git spawn, a separate Seam. */
const GITHUB_DIR_PREFIX = "src/github/";

interface BaselineFile {
  /** Sorted list of `src/...` paths whose `node:child_process` import is tolerated. */
  callers: string[];
  /** Free-form note explaining when this baseline was last regenerated. */
  note: string;
}

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * import `node:child_process` in violation of the Host-Probe Adapter Seam?
 * Exported so the regression test can pin the grammar without shelling out to
 * git. `relPath` decides the carve-outs; pass a `src/...` path.
 *
 * Files INSIDE `src/host-probe/` are the Seam itself (exempt). The GitHub CLI
 * Adapter family and the three acknowledged non-host spawners are owned
 * elsewhere (also exempt).
 */
export function fileViolatesHostProbeSeam(relPath: string, body: string): boolean {
  if (relPath.startsWith("src/host-probe/")) return false;
  if (relPath.startsWith(GITHUB_DIR_PREFIX)) return false;
  if (NON_HOST_PROBE_SPAWNERS.has(relPath)) return false;
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
    .map((s) => s.trim())
    .filter(Boolean);
}

function isInsideHostProbeDir(absolutePath: string): boolean {
  return absolutePath === HOST_PROBE_DIR || absolutePath.startsWith(HOST_PROBE_DIR + "/");
}

async function findViolations(): Promise<string[]> {
  const tracked = await listTrackedSrcFiles();
  const violations: string[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    if (isInsideHostProbeDir(abs)) continue;
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (fileViolatesHostProbeSeam(relPath, body)) {
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
    note: `Auto-generated by scripts/ci/host-probe-seam-check.ts --write-baseline on ${new Date().toISOString()}. Host-Probe Adapter closure ratchet (issue #939): shrink only.`,
  };
  await writeFile(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main(): Promise<number> {
  const violations = await findViolations();

  if (WRITE_BASELINE) {
    await writeBaselineFile(violations);
    console.log(
      `[host-probe-seam-check] Wrote baseline with ${violations.length} entries to ${relative(REPO_ROOT, BASELINE_PATH)}`,
    );
    return 0;
  }

  const baseline = await loadBaseline();
  const baselineSet = new Set(baseline.callers);
  const violationSet = new Set(violations);

  const newViolations = violations.filter((v) => !baselineSet.has(v));
  const fixedCallers = baseline.callers.filter((c) => !violationSet.has(c));

  if (newViolations.length > 0) {
    console.error("[host-probe-seam-check] NEW host-probe-seam violations (Host-Probe Adapter, issue #939):");
    for (const v of newViolations) console.error(`  - ${v}`);
    console.error("");
    console.error("These files import node:child_process directly to shell out to a host-info");
    console.error("binary (df/free/systemctl or similar) outside the Host-Probe Adapter.");
    console.error("Route the call through the seam: readDisk/readMem/readServiceStatus");
    console.error("(src/host-probe/probe.ts), discriminating on the returned ProbeResult `code`.");
    return 1;
  }

  if (fixedCallers.length > 0) {
    console.error("[host-probe-seam-check] Baseline is stale — these files no longer violate:");
    for (const c of fixedCallers) console.error(`  - ${c}`);
    console.error("");
    console.error("Re-run with --write-baseline and commit the shrunk baseline.");
    return 1;
  }

  console.log(`[host-probe-seam-check] OK — ${violations.length} known violations, no new ones.`);
  return 0;
}

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[host-probe-seam-check] crash:", err);
      process.exit(2);
    },
  );
}
