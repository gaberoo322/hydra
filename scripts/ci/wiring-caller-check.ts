#!/usr/bin/env -S npx tsx
/**
 * Wiring caller-reachability check — wiring-liveness gamma (issue #2289,
 * parent epic #2286).
 *
 * Catches the ORIGINAL no-caller failure class at PR time: an exported,
 * production-critical symbol with zero references anywhere outside its own
 * definition. That is the class of bug that shipped `seedVerifiedPairRegistry`
 * wired into nothing — it type-checked, it passed tests in isolation, and it
 * silently never ran because no live caller referenced it. The runtime
 * wiring-liveness chore (src/scheduler/chores/wiring-liveness.ts, #2287) catches
 * a declared TIMER that never went live; this static check is its complement on
 * the CALLER axis: it would have flagged the orphaned symbol at review time,
 * before merge.
 *
 * Source of truth: the `type: caller` entries in config/direction/liveness.yaml.
 * Each declared caller entry names a `symbol` that MUST be referenced somewhere
 * outside the file that defines it. The check exits non-zero (and names the
 * symbol) if any declared caller symbol has zero references outside its own
 * definition.
 *
 * ADVISORY, not a merge gate: this script is wired only into the standalone
 * .github/workflows/wiring-check.yml advisory workflow — deliberately NOT added
 * to ci.yml and NOT a required branch-protection check (ci.yml is Verifier
 * Core / Tier-4, ADR-0001/ADR-0015; a new verification lands as a Tier-3
 * sibling per the same pattern ast-grep-lint / eval-gate / comby-check follow,
 * operator memory feedback_ci_gate_separate_workflow_avoids_tier0).
 *
 * "knip-backed reachability": knip (a devDependency) is the project's
 * authoritative whole-project dead-export detector. This check narrows knip's
 * signal to the SPECIFIC declared symbols — it counts references to each caller
 * symbol across the project source, excluding the symbol's own definition file,
 * so a symbol whose only mention is its own `export` is flagged. The reference
 * scan reuses the same project glob knip is configured with (src/ + scripts/),
 * so the two stay in agreement about what "the project" is.
 *
 * NEVER THROWS into the caller of the pure functions (CLAUDE.md fail-loud +
 * the repo's check-script convention): a manifest read/parse error is surfaced
 * as a non-zero exit with a diagnostic, not an uncaught exception. The pure
 * functions return result objects so the test can assert on them directly.
 *
 * Usage:
 *   node --no-warnings --experimental-strip-types scripts/ci/wiring-caller-check.ts
 *   npx tsx scripts/ci/wiring-caller-check.ts
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** Repo root — three levels up from scripts/ci/. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/** Default manifest path; the test points the loader at a fixture instead. */
const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, "config", "direction", "liveness.yaml");

/**
 * Project source roots scanned for references. Mirrors the `project` globs in
 * knip.json (`src/**`, `scripts/**`) so the reference scan agrees with knip
 * about what "the project" is. Kept as directory roots (the scanner walks them)
 * rather than globs to avoid a glob dependency.
 */
const PROJECT_ROOTS = ["src", "scripts"] as const;

/** File extensions the reference scan considers source. */
const SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"] as const;

// ---------------------------------------------------------------------------
// Caller-entry parsing
//
// A minimal YAML-subset parser scoped to the `type: caller` rows of
// liveness.yaml. It follows the PATTERN of src/scheduler/chores/wiring-liveness.ts
// (a tiny no-dependency tokenizer; no js-yaml/yaml runtime dependency, ADR-0005)
// but is intentionally self-contained to this in-scope script rather than
// importing the chore's parser — this check owns only the caller axis and must
// not couple to the timer-axis chore module.
//
// A caller entry looks like:
//   - unit: seedVerifiedPairRegistry        # symbol falls back to `unit` if no `symbol`
//     type: caller
//     symbol: seedVerifiedPairRegistry      # the exported symbol that must have a live caller
//     defFile: src/registry/seed.ts         # (optional) file that DEFINES the symbol
//     description: ...                       # (optional)
// ---------------------------------------------------------------------------

/** A declared caller entry from the manifest. */
export interface CallerEntry {
  /** The exported symbol that must be referenced outside its own definition. */
  symbol: string;
  /**
   * Optional path to the file that DEFINES the symbol. References inside this
   * file are excluded from the reachability count (a symbol referencing itself
   * inside its own definition is not a live caller). Repo-relative.
   */
  defFile?: string;
  /** Optional human-readable note. */
  description?: string;
}

/** Strip a trailing `# ...` comment that is not inside a quoted scalar. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Unquote a scalar token (drop matching surrounding quotes), else trim. */
function parseScalar(raw: string): string {
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the `type: caller` entries out of a liveness-manifest YAML string.
 *
 * Returns only caller entries — timer (or any other type) rows are ignored, so
 * the shared manifest can carry both axes. A row with no `symbol:` falls back to
 * its `unit:` value as the symbol (the manifest's primary key), so a caller can
 * be declared with just `unit` + `type: caller`.
 *
 * Pure and never-throws: a structurally odd line is skipped rather than fatal,
 * matching the repo's lenient-subset-parser precedent.
 */
export function parseCallerEntries(raw: string): CallerEntry[] {
  const rows: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let inEntries = false;

  for (const rawLine of raw.split("\n")) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;

    // Top-level `entries:` introduces the list.
    if (/^entries\s*:/.test(line)) {
      inEntries = true;
      continue;
    }
    // Any other top-level (column-0, non-list) key ends the entries list.
    if (inEntries && /^[^\s-]/.test(line)) {
      inEntries = false;
    }
    if (!inEntries) continue;

    const listItem = line.match(/^\s*-\s*(.*)$/);
    if (listItem) {
      // New list item. The remainder after `- ` may be a `key: value` pair.
      current = {};
      rows.push(current);
      const rest = listItem[1];
      const kv = rest.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1]] = parseScalar(kv[2]);
      continue;
    }

    // A `  key: value` line belonging to the most recent list item.
    if (current) {
      const kv = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1]] = parseScalar(kv[2]);
    }
  }

  const callers: CallerEntry[] = [];
  for (const row of rows) {
    if (row.type !== "caller") continue;
    const symbol = (row.symbol ?? row.unit ?? "").trim();
    if (symbol === "") continue;
    const entry: CallerEntry = { symbol };
    if (row.defFile) entry.defFile = row.defFile;
    if (row.description) entry.description = row.description;
    callers.push(entry);
  }
  return callers;
}

// ---------------------------------------------------------------------------
// Reachability check
// ---------------------------------------------------------------------------

/** One source file the reference scan considers: its repo-relative path + text. */
export interface SourceFile {
  /** Repo-relative path, e.g. `src/registry/seed.ts`. */
  path: string;
  /** Full file contents. */
  content: string;
}

/** A single unreferenced-caller finding. */
export interface CallerViolation {
  symbol: string;
  message: string;
}

/** The outcome of a reachability check over a set of caller entries. */
export interface CallerCheckResult {
  ok: boolean;
  violations: CallerViolation[];
  /** Per-symbol reference count (outside its own definition), for diagnostics. */
  counts: Record<string, number>;
}

/**
 * Count whole-word references to `symbol` in `content`. A word boundary on both
 * sides avoids matching `seedVerifiedPairRegistryV2` when looking for
 * `seedVerifiedPairRegistry`. The symbol is regex-escaped so a literal name with
 * regex metacharacters cannot break the match.
 */
function countReferences(symbol: string, content: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "g");
  const matches = content.match(re);
  return matches ? matches.length : 0;
}

/**
 * Pure reachability check. For each declared caller symbol, count references
 * across all project source files EXCEPT the symbol's own definition file
 * (`defFile`). A symbol with zero references outside its definition is a
 * violation — it is exported (or declared critical) but wired into nothing.
 *
 * `defFile` matching is by suffix so `src/registry/seed.ts` matches a scanned
 * path of the same value; if no `defFile` is declared, every file counts (the
 * symbol must be referenced somewhere in the project at all).
 */
export function checkCallerReachability(
  callers: CallerEntry[],
  files: SourceFile[],
): CallerCheckResult {
  const violations: CallerViolation[] = [];
  const counts: Record<string, number> = {};

  for (const entry of callers) {
    let refs = 0;
    for (const file of files) {
      const isDefFile = entry.defFile
        ? file.path === entry.defFile || file.path.endsWith(`/${entry.defFile}`)
        : false;
      if (isDefFile) continue;
      refs += countReferences(entry.symbol, file.content);
    }
    counts[entry.symbol] = refs;
    if (refs === 0) {
      const where = entry.defFile ? ` (defined in ${entry.defFile})` : "";
      violations.push({
        symbol: entry.symbol,
        message:
          `Declared caller symbol '${entry.symbol}'${where} has NO reference ` +
          `outside its own definition — it is wired into nothing. Either add a ` +
          `live caller or remove the entry from config/direction/liveness.yaml.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, counts };
}

// ---------------------------------------------------------------------------
// CLI plumbing (filesystem-backed; the pure functions above are tested)
// ---------------------------------------------------------------------------

/** Recursively collect source files under a directory root, relative to base. */
async function collectSourceFiles(
  absRoot: string,
  base: string,
): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  let names: string[];
  try {
    // `readdir` without `withFileTypes` returns `string[]` names — avoids the
    // `Dirent<NonSharedBuffer>` generic the test-tsconfig infers; each entry is
    // then classified with a `stat` call below.
    names = await readdir(absRoot);
  } catch {
    // A missing root is not fatal — it just contributes no files.
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(absRoot, name);
    const rel = join(base, name);
    let isDir: boolean;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch (err) {
      console.error(`[wiring-caller-check] could not stat ${rel}:`, err);
      continue;
    }
    if (isDir) {
      out.push(...(await collectSourceFiles(abs, rel)));
    } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      try {
        out.push({ path: rel, content: await readFile(abs, "utf8") });
      } catch (err) {
        console.error(`[wiring-caller-check] could not read ${rel}:`, err);
      }
    }
  }
  return out;
}

/** Run the check against the real manifest + project source. Returns an exit code. */
async function runCli(manifestPath = DEFAULT_MANIFEST_PATH): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    console.error(
      `[wiring-caller-check] could not read manifest ${manifestPath}:`,
      err,
    );
    return 2;
  }

  const callers = parseCallerEntries(raw);
  if (callers.length === 0) {
    console.log(
      "[wiring-caller-check] no `type: caller` entries declared — nothing to check.",
    );
    return 0;
  }

  const files: SourceFile[] = [];
  for (const root of PROJECT_ROOTS) {
    files.push(...(await collectSourceFiles(join(REPO_ROOT, root), root)));
  }

  const result = checkCallerReachability(callers, files);
  if (result.ok) {
    console.log(
      `[wiring-caller-check] OK — all ${callers.length} declared caller symbol(s) have a live reference.`,
    );
    return 0;
  }

  for (const v of result.violations) {
    console.error(`[wiring-caller-check] FAIL: ${v.message}`);
  }
  return 1;
}

/** True when this module is the process entrypoint (not imported by a test). */
function isCliEntrypoint(moduleUrl: string): boolean {
  return Boolean(
    process.argv[1] && fileURLToPath(moduleUrl) === resolve(process.argv[1]),
  );
}

if (isCliEntrypoint(import.meta.url)) {
  runCli().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[wiring-caller-check] crash:", err);
      process.exit(2);
    },
  );
}
