/**
 * seam-check-lib.ts — the shared baseline-ratchet engine behind the four CI
 * Seam checks (redis / github / host-probe / schema).
 *
 * Every Seam check used to inline the same machinery four times: a `git
 * ls-files` scan, a `loadBaseline` / `writeBaselineFile` pair over the
 * `{callers, note}` JSON shape, the new-violations / stale-baseline diff, the
 * `--write-baseline` path, and the `import.meta.url === process.argv[1]` CLI
 * guard. The ONLY thing that genuinely varied per check was the policy: which
 * files to scan (the glob), what counts as a violation (the predicate), where
 * the baseline lives, and the human-facing wording. This module concentrates
 * the duplicated engine into one Interface and leaves each Seam a thin Adapter
 * that declares just its policy.
 *
 * Behavior is byte-identical to the four hand-written scripts: exit 0/1/2, the
 * new-violations message, the stale-baseline message, the `--write-baseline`
 * summary, and the OK summary line all reproduce per-arm wording verbatim. The
 * shrink-only ratchet semantics are preserved — a baseline may shrink (fixed
 * callers) but a grown baseline still fails, and a new violation outside the
 * baseline fails closed.
 *
 * The engine is intentionally ignorant of per-Seam exemptions: each Adapter's
 * `predicate(relPath, body)` is the SINGLE owner of all exemption logic
 * (directory carve-outs and sanctioned-owner Sets). The engine only calls the
 * predicate; a file that returns false is identical to one that would have been
 * skipped in the old per-check loop.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Repo root, resolved relative to this file (scripts/ci/seam-check-lib.ts → ../../). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/**
 * The on-disk baseline shape, shared by all four Seam checks: a sorted list of
 * tolerated `src/...` caller paths plus a free-form regeneration note.
 */
export interface BaselineFile {
  /** Sorted list of `src/...` paths whose violation is tolerated. */
  callers: string[];
  /** Free-form note explaining when this baseline was last regenerated. */
  note: string;
}

/**
 * The per-Seam policy an Adapter supplies. Everything an Adapter needs to vary
 * lives here; the engine owns the rest.
 */
export interface SeamCheckConfig {
  /**
   * The check's log prefix and identity, e.g. `"redis-seam-check"`. Used
   * verbatim in every `[<name>] ...` log line and the `--write-baseline` note.
   */
  name: string;
  /**
   * The `git ls-files` glob arguments. Three checks scan `["src/*.ts",
   * "src/**\/*.ts"]`; schema scans `["src/api/*.ts"]` only. The engine does not
   * hard-code a glob.
   */
  globs: string[];
  /**
   * Pure violation predicate. The SINGLE owner of all per-Seam exemption — the
   * Adapter folds its directory carve-outs and sanctioned-owner Sets in here.
   * `relPath` is a repo-relative `src/...` path; `body` is the file contents.
   */
  predicate: (relPath: string, body: string) => boolean;
  /** Absolute path to this check's `scripts/ci/<name>-seam-baseline.json`. */
  baselinePath: string;
  /**
   * The note clause appended after the auto-generated timestamp in a written
   * baseline, e.g. `"ADR-0009 closure ratchet: shrink only."`.
   */
  noteSuffix: string;
  /**
   * The multi-line how-to-fix help printed under the NEW-violations list. One
   * string per output line (the engine adds the newline); reproduces the
   * per-check wording verbatim.
   */
  newViolationsHelp: string[];
  /**
   * The one-line headline printed before the NEW-violations list, e.g.
   * `"NEW Redis-seam violations (ADR-0009):"` (the engine prepends `[<name>] `).
   */
  newViolationsHeadline: string;
}

/**
 * Run `git ls-files` for the given globs and return the tracked repo-relative
 * paths. Faster than a manual walk and respects `.gitignore`.
 */
export async function listTrackedFiles(globs: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", ...globs], {
    cwd: REPO_ROOT,
  });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read the baseline JSON at `path`, falling back to an empty unseeded baseline
 * if the file does not exist or is unreadable.
 */
export async function loadBaseline(path: string): Promise<BaselineFile> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return { callers: [], note: "baseline not yet seeded" };
  }
}

/**
 * Write the baseline JSON at `path` with the sorted `callers` and an
 * auto-generated note (`<name> --write-baseline on <ISO>. <noteSuffix>`).
 */
export async function writeBaselineFile(
  path: string,
  callers: string[],
  name: string,
  noteSuffix: string,
): Promise<void> {
  const payload: BaselineFile = {
    callers,
    note: `Auto-generated by scripts/ci/${name}.ts --write-baseline on ${new Date().toISOString()}. ${noteSuffix}`,
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/** The shrink-only diff between current violations and the recorded baseline. */
export interface BaselineDiff {
  /** Current violations absent from the baseline — fail closed. */
  newViolations: string[];
  /** Baseline entries that no longer violate — baseline is stale, must shrink. */
  fixedCallers: string[];
}

/**
 * Compute the shrink-only diff: which current violations are new (not in the
 * baseline) and which baseline entries have been fixed (no longer violate).
 */
export function diffBaseline(
  violations: string[],
  baseline: BaselineFile,
): BaselineDiff {
  const baselineSet = new Set(baseline.callers);
  const violationSet = new Set(violations);
  return {
    newViolations: violations.filter((v) => !baselineSet.has(v)),
    fixedCallers: baseline.callers.filter((c) => !violationSet.has(c)),
  };
}

/**
 * Scan the configured globs, apply the Adapter's predicate, and return the
 * sorted list of violating repo-relative paths. Unreadable files are skipped.
 */
async function findViolations(config: SeamCheckConfig): Promise<string[]> {
  const tracked = await listTrackedFiles(config.globs);
  const violations: string[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (config.predicate(relPath, body)) {
      violations.push(relPath);
    }
  }
  return violations.sort();
}

/**
 * The engine entrypoint each Adapter calls. Returns the numeric exit code:
 *   0 — OK (or `--write-baseline` succeeded)
 *   1 — new violations, or a stale (un-shrunk) baseline
 *
 * Honors `--write-baseline` (regenerate then exit 0), the shrink-only ratchet,
 * and reproduces each arm's wording verbatim. Reads `--write-baseline` from
 * `process.argv` so an Adapter does not have to thread it through.
 */
export async function runSeamCheck(config: SeamCheckConfig): Promise<number> {
  const writeBaseline = process.argv.includes("--write-baseline");
  const violations = await findViolations(config);

  if (writeBaseline) {
    await writeBaselineFile(
      config.baselinePath,
      violations,
      config.name,
      config.noteSuffix,
    );
    console.log(
      `[${config.name}] Wrote baseline with ${violations.length} entries to ${relative(REPO_ROOT, config.baselinePath)}`,
    );
    return 0;
  }

  const baseline = await loadBaseline(config.baselinePath);
  const { newViolations, fixedCallers } = diffBaseline(violations, baseline);

  if (newViolations.length > 0) {
    console.error(`[${config.name}] ${config.newViolationsHeadline}`);
    for (const v of newViolations) console.error(`  - ${v}`);
    console.error("");
    for (const line of config.newViolationsHelp) console.error(line);
    return 1;
  }

  if (fixedCallers.length > 0) {
    console.error(`[${config.name}] Baseline is stale — these files no longer violate:`);
    for (const c of fixedCallers) console.error(`  - ${c}`);
    console.error("");
    console.error("Re-run with --write-baseline and commit the shrunk baseline.");
    return 1;
  }

  console.log(`[${config.name}] OK — ${violations.length} known violations, no new ones.`);
  return 0;
}

/**
 * Whether `import.meta.url` of an Adapter module is the script Node was invoked
 * with — i.e. the Adapter is running as a CLI, not being imported by a test.
 * Each Adapter gates its `runSeamCheck(...).then(exit)` on this so importing it
 * never triggers a git scan or `process.exit`.
 */
export function isCliEntrypoint(moduleUrl: string): boolean {
  return Boolean(
    process.argv[1] && fileURLToPath(moduleUrl) === resolve(process.argv[1]),
  );
}

/**
 * Run an Adapter's `runSeamCheck` as a CLI: exit with the returned code, or
 * exit 2 on an unexpected crash (preserving the per-check crash wording).
 */
export function runAsCli(config: SeamCheckConfig): void {
  runSeamCheck(config).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[${config.name}] crash:`, err);
      process.exit(2);
    },
  );
}
