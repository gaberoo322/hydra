#!/usr/bin/env -S npx tsx
/**
 * Schema Seam check — ADR-0011 closure ratchet (issue #893).
 *
 * ADR-0011 decided that every HTTP `req.body` read in `src/api/*.ts` validates
 * through a `src/schemas/<domain>.ts` zod `safeParse` and returns the canonical
 * `400 {code:"schema-validation-failed", issues}` envelope on failure. The ADR
 * predicted (at :20-27) that prose discipline alone keeps the Seam from closing
 * — and as of 2026-06-02 the drift was growing (~17 files read `req.body`, only
 * ~10 validate). This is the CI backstop that freezes that drift.
 *
 * This mirrors the ADR-0009 `redis-seam-check.ts` mechanic exactly: a pure,
 * unit-testable predicate plus a shrink-only baseline. ONE divergence from the
 * ADR-0011 §3/§5 framing: the gate lands in a SEPARATE workflow
 * (`.github/workflows/schema-seam.yml`), NOT as a step in `ci.yml`. `ci.yml` is
 * exact-match Verifier Core (Tier-4); a sibling workflow keeps this PR Tier-3
 * and auto-mergeable, mirroring the `coupling-check.yml` precedent. The ADR was
 * amended to record the divergence.
 *
 * Grammar (per-HANDLER, not per-file): split each file into segments at
 * `router.<method>(` boundaries; a segment that reads `req.body` without a
 * `safeParse(req.body...)` in that SAME segment is a violation. A whole-file
 * check would coincidentally pass today but false-negative the instant a
 * per-router drain migrates one handler while a sibling still reads raw. The
 * check targets `req.body` ONLY — `now-page.ts` legitimately `safeParse`s
 * `req.query` and must not be flagged on that account (it also `safeParse`s
 * `req.body` in its POST handlers, so it is clean here).
 *
 * Implements a baseline ratchet: existing violations live in
 * `scripts/ci/schema-seam-baseline.json` and are tolerated. New violations fail
 * the gate. The baseline is allowed to *shrink* but not grow — any handler that
 * gets migrated to `safeParse` must be removed from the baseline, and a future
 * handler that re-introduces a raw `req.body` read is caught on its own merits.
 *
 * Usage:
 *   npx tsx scripts/ci/schema-seam-check.ts
 *   npm run schema-seam-check
 *
 * Update flow when intentionally migrating a router:
 *   1. Rewire the handler(s) to `safeParse(req.body...)`.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the smaller baseline alongside the migration.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Splits a handler body into segments at express router-method boundaries.
 * `router.get(` / `router.post(` / `router.put(` / `router.patch(` /
 * `router.delete(` / `router.all(` / `router.use(`, tolerant of whitespace.
 * Global so we can walk every match.
 */
const SEGMENT_BOUNDARY = /router\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(/g;

/** A read of `req.body` anywhere in a segment. */
const READS_BODY = /\breq\s*\.\s*body\b/;

/** A `safeParse(req.body...)` — the sanctioned validation of the body. */
const SAFEPARSE_BODY = /\.\s*safeParse\s*\(\s*req\s*\.\s*body\b/;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/schema-seam-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

interface BaselineFile {
  /** Sorted list of `src/api/...` paths whose unvalidated body reads are tolerated. */
  callers: string[];
  /** Free-form note explaining when this baseline was last regenerated. */
  note: string;
}

/**
 * Pure predicate: does `body` (the contents of an `src/api/*.ts` file) contain
 * a handler segment that reads `req.body` without a `safeParse(req.body...)` in
 * that same segment? Exported so the regression test can pin the grammar
 * without shelling out to git.
 *
 * Per-handler, not per-file: we split at `router.<method>(` boundaries and
 * evaluate each segment independently, so a file where one handler validates
 * and a sibling reads raw is still flagged.
 */
export function fileViolatesSchemaSeam(body: string): boolean {
  const boundaries: number[] = [];
  let match: RegExpExecArray | null;
  SEGMENT_BOUNDARY.lastIndex = 0;
  while ((match = SEGMENT_BOUNDARY.exec(body)) !== null) {
    boundaries.push(match.index);
  }

  // No router-method calls at all: treat the whole file as one segment. A file
  // that reads req.body without a safeParse of it anywhere is a violation.
  if (boundaries.length === 0) {
    return READS_BODY.test(body) && !SAFEPARSE_BODY.test(body);
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : body.length;
    const segment = body.slice(start, end);
    if (READS_BODY.test(segment) && !SAFEPARSE_BODY.test(segment)) {
      return true;
    }
  }
  return false;
}

async function listTrackedApiFiles(): Promise<string[]> {
  // git ls-files is faster and respects .gitignore. Scope to src/api/*.ts —
  // ADR-0011's Seam covers HTTP handler routers only.
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "src/api/*.ts"],
    { cwd: REPO_ROOT },
  );
  return stdout
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

async function findViolations(): Promise<string[]> {
  const tracked = await listTrackedApiFiles();
  const violations: string[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (fileViolatesSchemaSeam(body)) {
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
    note: `Auto-generated by scripts/ci/schema-seam-check.ts --write-baseline on ${new Date().toISOString()}. ADR-0011 closure ratchet: shrink only.`,
  };
  await writeFile(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main(): Promise<number> {
  const violations = await findViolations();

  if (WRITE_BASELINE) {
    await writeBaselineFile(violations);
    console.log(`[schema-seam-check] Wrote baseline with ${violations.length} entries to ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return 0;
  }

  const baseline = await loadBaseline();
  const baselineSet = new Set(baseline.callers);
  const violationSet = new Set(violations);

  const newViolations = violations.filter(v => !baselineSet.has(v));
  const fixedCallers = baseline.callers.filter(c => !violationSet.has(c));

  if (newViolations.length > 0) {
    console.error("[schema-seam-check] NEW Schema-seam violations (ADR-0011):");
    for (const v of newViolations) console.error(`  - ${v}`);
    console.error("");
    console.error("These handlers read req.body without a safeParse(req.body...) in the same handler.");
    console.error("Validate the body through a src/schemas/<domain>.ts zod schema and return");
    console.error("400 {code:\"schema-validation-failed\", issues} on failure (see src/api/holdback.ts).");
    return 1;
  }

  if (fixedCallers.length > 0) {
    console.error("[schema-seam-check] Baseline is stale — these files no longer violate:");
    for (const c of fixedCallers) console.error(`  - ${c}`);
    console.error("");
    console.error("Re-run with --write-baseline and commit the shrunk baseline.");
    return 1;
  }

  console.log(`[schema-seam-check] OK — ${violations.length} known violations, no new ones.`);
  return 0;
}

// Only run as a CLI — importing the module (e.g. from the regression test)
// must not trigger the git scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    code => process.exit(code),
    err => {
      console.error("[schema-seam-check] crash:", err);
      process.exit(2);
    },
  );
}
