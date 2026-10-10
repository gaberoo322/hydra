/**
 * brain-source.ts — the ONE definition of the autopilot decision brain's
 * source corpus (issue #4511).
 *
 * The brain used to be a single file, so every textual guard read
 * `scripts/autopilot/decide.py` directly. #4511 split it into three layers
 * (imports point down only):
 *
 *   scripts/autopilot/decide.py              entry point + composition root
 *   scripts/autopilot/decide_selectors/*.py  one module per dispatch family
 *   scripts/autopilot/decide_base.py         the shared stdlib-only leaf
 *
 * A guard that kept reading decide.py alone would go quietly VACUOUS once a
 * selector body moved out — a negative pin (`doesNotMatch(decide, /x/)`) and
 * the signal-parity read extractor both pass when the text they look at simply
 * no longer contains the code. So every guard that asserts on brain source text
 * reads it through this module instead, and a future selector module is covered
 * automatically: the package directory is LISTED (sorted), never hand-maintained.
 *
 * Order is fixed: decide.py, then decide_base.py, then every
 * decide_selectors/*.py by sorted file name (`__init__.py` included — it sorts
 * first). Pure read-only observer: node stdlib, synchronous, no network.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Repo-relative home of the brain. */
export const BRAIN_DIR = "scripts/autopilot";
/** Repo-relative path of the entry point / composition root. */
export const BRAIN_ENTRY = `${BRAIN_DIR}/decide.py`;
/** Repo-relative path of the shared leaf. */
export const BRAIN_BASE = `${BRAIN_DIR}/decide_base.py`;
/** Repo-relative path of the per-family selector package. */
export const BRAIN_SELECTORS_DIR = `${BRAIN_DIR}/decide_selectors`;

/** One brain source file: its repo-relative path and full text. */
export interface BrainSourceFile {
  readonly path: string;
  readonly text: string;
}

/** The brain source corpus: the per-file texts, and all of them joined. */
export interface BrainSource {
  readonly files: readonly BrainSourceFile[];
  /** Every file's text, in corpus order, separated by a newline. */
  readonly joined: string;
}

/**
 * Repo-relative paths of every brain source file, in corpus order. The
 * selector package is discovered by directory listing, so a new family module
 * joins the corpus without an edit here.
 */
export function brainSourcePaths(repoRoot: string = REPO_ROOT): string[] {
  const selectors = readdirSync(join(repoRoot, BRAIN_SELECTORS_DIR))
    .filter((name) => name.endsWith(".py"))
    .sort()
    .map((name) => `${BRAIN_SELECTORS_DIR}/${name}`);
  if (selectors.filter((p) => !p.endsWith("/__init__.py")).length === 0) {
    throw new Error(`brain-source: no selector modules found under ${BRAIN_SELECTORS_DIR}`);
  }
  return [BRAIN_ENTRY, BRAIN_BASE, ...selectors];
}

/** Read the whole brain source corpus. Throws (with the path) if a file is unreadable. */
export function readBrainSource(repoRoot: string = REPO_ROOT): BrainSource {
  const files = brainSourcePaths(repoRoot).map((path) => ({
    path,
    text: readFileSync(join(repoRoot, path), "utf-8"),
  }));
  return { files, joined: files.map((f) => f.text).join("\n") };
}

/**
 * The source of the top-level Python function `name` — from its `def` line to
 * the next top-level `def` IN THE SAME FILE (or that file's end) — plus the
 * file it lives in. `null` when no brain file defines it. Slicing per file
 * keeps a function that ends its module from running on into the next file's
 * header.
 */
export function brainFunctionSource(
  source: BrainSource,
  name: string,
): { path: string; body: string } | null {
  const needle = new RegExp(`^def ${name}\\(`, "m");
  let found: { path: string; body: string } | null = null;
  for (const file of source.files) {
    const m = needle.exec(file.text);
    if (!m) continue;
    if (found) {
      throw new Error(`brain-source: def ${name} is defined in both ${found.path} and ${file.path}`);
    }
    const after = file.text.indexOf("\ndef ", m.index + 1);
    found = { path: file.path, body: file.text.slice(m.index, after > 0 ? after : undefined) };
  }
  return found;
}
