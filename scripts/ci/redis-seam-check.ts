#!/usr/bin/env -S npx tsx
/**
 * Redis Seam check — ADR-0009 / ADR-0017 closure ratchet.
 *
 * Forbids new imports of the legacy Redis surface (`redis-keys`,
 * `redis-adapter`) and the internal seam primitives (`redis/keys`,
 * `redis/kv`) from anywhere outside `src/redis/` itself.
 *
 * ADR-0017 (Category B) additionally forbids a static `from '.../redis/
 * connection'` import (the raw `getRedisConnection` / `getRedisSubscriber`
 * surface) from anywhere outside `src/redis/*` AND the one sanctioned
 * non-family owner, `src/event-bus.ts` — the Event Bus IS the seam for the
 * stream (`x*`) ops that have no typed-hash accessor shape. The fix-path for a
 * flagged file is to route through B (Event Bus), A (a domain accessor), or C
 * (the shared `boundedJsonList` primitive) — never a linter-appeasing wrapper.
 * Scoped to STATIC `from` imports, consistent with the existing grammar;
 * dynamic `await import(...)` + getRedisConnection() call sites are a
 * documented follow-up, not flagged here.
 *
 * Implements a baseline ratchet: existing violations live in
 * `scripts/ci/redis-seam-baseline.json` and are tolerated. New
 * violations fail the gate. The baseline is allowed to *shrink* but
 * not grow — any caller that gets cleaned up must be removed from the
 * baseline, and a future caller that re-introduces the same import is
 * caught on its own merits.
 *
 * Usage:
 *   node --no-warnings --experimental-strip-types scripts/ci/redis-seam-check.ts
 *   npm run redis-seam-check
 *
 * Update flow when intentionally migrating a caller:
 *   1. Remove the legacy import.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FORBIDDEN_PATTERNS = [
  /from\s+['"][^'"]*\/redis-keys(?:\.ts)?['"]/,
  /from\s+['"][^'"]*\/redis-adapter(?:\.ts)?['"]/,
  /from\s+['"][^'"]*\/redis\/keys(?:\.ts)?['"]/,
  /from\s+['"][^'"]*\/redis\/kv(?:\.ts)?['"]/,
];

/**
 * ADR-0017: static raw-connection import. Flagged everywhere outside
 * `src/redis/*` AND the sanctioned `src/event-bus.ts` owner (see
 * SANCTIONED_RAW_CONNECTION_OWNERS). Static `from` only — matching the
 * grammar of FORBIDDEN_PATTERNS above.
 */
const RAW_CONNECTION_PATTERN = /from\s+['"][^'"]*\/redis\/connection(?:\.ts)?['"]/;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SRC_DIR = join(REPO_ROOT, "src");
const REDIS_DIR = join(SRC_DIR, "redis");

/**
 * Files outside `src/redis/*` that may statically import `redis/connection`.
 * Only the Event Bus — it owns the stream (`x*`) ops that have no typed-hash
 * accessor and so legitimately holds the raw connection (ADR-0017 Category B).
 */
const SANCTIONED_RAW_CONNECTION_OWNERS = new Set<string>(["src/event-bus.ts"]);
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/redis-seam-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

interface BaselineFile {
  /** Sorted list of `src/...` paths whose legacy imports are tolerated. */
  callers: string[];
  /** Free-form note explaining when this baseline was last regenerated. */
  note: string;
}

/**
 * Pure predicate: does `body` (the file contents at repo-relative `relPath`)
 * contain a forbidden seam import? Exported so the regression test can pin the
 * grammar without shelling out to git. `relPath` decides the sanctioned-owner
 * carve-out for the ADR-0017 raw-connection rule; pass a `src/...` path.
 */
export function fileViolatesSeam(relPath: string, body: string): boolean {
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(body)) return true;
  }
  if (
    !SANCTIONED_RAW_CONNECTION_OWNERS.has(relPath) &&
    RAW_CONNECTION_PATTERN.test(body)
  ) {
    return true;
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

function isInsideRedisDir(absolutePath: string): boolean {
  return absolutePath === REDIS_DIR || absolutePath.startsWith(REDIS_DIR + "/");
}

async function findViolations(): Promise<string[]> {
  const tracked = await listTrackedSrcFiles();
  const violations: string[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    if (isInsideRedisDir(abs)) continue;
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (fileViolatesSeam(relPath, body)) {
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
    note: `Auto-generated by scripts/ci/redis-seam-check.ts --write-baseline on ${new Date().toISOString()}. ADR-0009 closure ratchet: shrink only.`,
  };
  await writeFile(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main(): Promise<number> {
  const violations = await findViolations();

  if (WRITE_BASELINE) {
    await writeBaselineFile(violations);
    console.log(`[redis-seam-check] Wrote baseline with ${violations.length} entries to ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return 0;
  }

  const baseline = await loadBaseline();
  const baselineSet = new Set(baseline.callers);
  const violationSet = new Set(violations);

  const newViolations = violations.filter(v => !baselineSet.has(v));
  const fixedCallers = baseline.callers.filter(c => !violationSet.has(c));

  if (newViolations.length > 0) {
    console.error("[redis-seam-check] NEW Redis-seam violations (ADR-0009):");
    for (const v of newViolations) console.error(`  - ${v}`);
    console.error("");
    console.error("These files import from redis-keys / redis-adapter / redis/keys / redis/kv.");
    console.error("Move the access behind a typed accessor in src/redis/<domain>.ts.");
    return 1;
  }

  if (fixedCallers.length > 0) {
    console.error("[redis-seam-check] Baseline is stale — these files no longer violate:");
    for (const c of fixedCallers) console.error(`  - ${c}`);
    console.error("");
    console.error("Re-run with --write-baseline and commit the shrunk baseline.");
    return 1;
  }

  console.log(`[redis-seam-check] OK — ${violations.length} known violations, no new ones.`);
  return 0;
}

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    code => process.exit(code),
    err => {
      console.error("[redis-seam-check] crash:", err);
      process.exit(2);
    },
  );
}
