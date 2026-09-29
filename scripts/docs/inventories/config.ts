/**
 * config family extractor (issue #4595 — docs-epic 9/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * Two row kinds in one table:
 *
 *   file    — one per file under config/** (recursive, every extension) =
 *             {kind, path, section, readBy, unread, source{path, line:1}}
 *   section — one per CONFIG_SECTIONS entry =
 *             {kind, section, dir, ext, exists, fileCount, source}
 *
 * - `section` is the CONFIG_SECTIONS key whose dir is the file's parent
 *   directory (config/<dir>/<file>), else null.
 * - `readBy` is the sorted list of repo files containing the file's literal
 *   repo-relative path ("config/<rel>"). The searched files are src/**\/*.ts,
 *   scripts/** (ts/mts/mjs/js/sh/py), bin/* and docs/operator-playbooks/*.md —
 *   docs/generated/, config/ itself and every other doc are never searched, so
 *   an inventory (or CLAUDE.md prose) cannot count as its own reader. A
 *   basename grep is rejected: it false-matches unrelated names.
 * - `unread` = section === null && readBy is empty.
 * - config/ files are enumerated from the tracked set (`git ls-files`), never
 *   the filesystem, so gitignored content (config/digests, config/feedback/to-*)
 *   never appears and output is host-independent.
 * - A section row's `exists` is whether config/<dir>/ holds any file in the
 *   scanned tree (git tracks no empty directory, so this is tree-determined);
 *   `fileCount` counts the files directly in it carrying the section's `ext`
 *   (what the config route serves).
 *
 * CONFIG_SECTIONS is IMPORTED from src/api/config-io.ts (it imports only node
 * stdlib plus an `import type` from express, which strip-types erases); that
 * file is only read for the keys' line numbers, never edited. The extractor
 * never emits a config file's contents.
 *
 * Stdlib-only (ADR-0005).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SECTIONS } from "../../../src/api/config-io.ts";
import type { ConfigInventory, ConfigRow } from "./envelope.ts";
import { byString, fail, trackedFiles, walkFiles } from "./scan.ts";
import type { SourceFile } from "./scan.ts";

const CONFIG_IO_FILE = "src/api/config-io.ts";

const GENERATED_FROM = [
  "config/**",
  CONFIG_IO_FILE,
  "src/**/*.ts",
  "scripts/**",
  "bin/*",
  "docs/operator-playbooks/*.md",
];

/** True when `src` holds `path` as a whole path token (config/x.md must not match config/x.md.bak). */
export function mentionsPath(src: string, path: string): boolean {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])${esc}(?![\\w-]|\\.\\w)`).test(src);
}

/** One CONFIG_SECTIONS entry as the builder sees it. */
export interface ConfigSectionSpec {
  dir: string;
  ext: string;
}

/** The label a config row lists under (`file <path>` / `section <key>`); rows sort by it. */
export function configRowLabel(row: ConfigRow): string {
  return row.kind === "file" ? `file ${row.path}` : `section ${row.section}`;
}

/**
 * Pure row-builder. `configFiles` are repo-relative paths under config/;
 * `readerFiles` are the candidate readers (already restricted to the searched
 * roots by the caller); `sectionsSource` is config-io.ts's text, for line
 * numbers only.
 */
export function buildConfigRows(input: {
  configFiles: string[];
  sections: Record<string, ConfigSectionSpec>;
  sectionsSource: string;
  readerFiles: SourceFile[];
}): ConfigRow[] {
  const sectionByDir = new Map<string, string>();
  for (const [key, spec] of Object.entries(input.sections)) sectionByDir.set(`config/${spec.dir}`, key);

  const rows: ConfigRow[] = [];
  for (const path of input.configFiles) {
    if (!path.startsWith("config/")) fail(`config file outside config/: ${path}`);
    const parent = path.slice(0, path.lastIndexOf("/"));
    const section = sectionByDir.get(parent) ?? null;
    const readBy = input.readerFiles
      .filter((f) => !f.path.startsWith("config/") && !f.path.startsWith("docs/generated/") && mentionsPath(f.src, path))
      .map((f) => f.path)
      .sort(byString);
    rows.push({
      kind: "file",
      path,
      section,
      readBy,
      unread: section === null && readBy.length === 0,
      source: { path, line: 1 },
    });
  }

  const lines = input.sectionsSource.split("\n");
  const declAt = lines.findIndex((l) => /\bCONFIG_SECTIONS\b/.test(l) && /=\s*\{/.test(l));
  for (const [key, spec] of Object.entries(input.sections)) {
    const keyRe = new RegExp(`^\\s*["']?${key.replace(/[^\w-]/g, "")}["']?\\s*:`);
    const idx = declAt === -1 ? -1 : lines.findIndex((l, i) => i > declAt && keyRe.test(l));
    if (idx === -1) fail(`${CONFIG_IO_FILE}: CONFIG_SECTIONS key "${key}" not found in the source`);
    const prefix = `config/${spec.dir}/`;
    const inDir = input.configFiles.filter((f) => f.startsWith(prefix));
    rows.push({
      kind: "section",
      section: key,
      dir: spec.dir,
      ext: spec.ext,
      exists: inDir.length > 0,
      fileCount: inDir.filter((f) => !f.slice(prefix.length).includes("/") && f.endsWith(spec.ext)).length,
      source: { path: CONFIG_IO_FILE, line: idx + 1 },
    });
  }
  if (Object.keys(input.sections).length === 0) fail(`${CONFIG_IO_FILE}: CONFIG_SECTIONS is empty`);

  return rows.sort((a, b) => byString(configRowLabel(a), configRowLabel(b)));
}

const READER_EXT = /\.(ts|mts|mjs|js|sh|py)$/;

function readAll(repoRoot: string, paths: string[]): SourceFile[] {
  return paths.map((path) => ({ path, src: readFileSync(join(repoRoot, path), "utf8") }));
}

export function extractConfig(repoRoot: string): ConfigInventory {
  // Tracked files only: gitignored config/feedback + config/digests content must never leak.
  const configFiles = trackedFiles(repoRoot, "config", () => true);
  if (configFiles.length === 0) fail("config/ scanned empty");
  const readerPaths = [
    ...walkFiles(repoRoot, "src", (n) => n.endsWith(".ts")),
    ...walkFiles(repoRoot, "scripts", (n) => READER_EXT.test(n)),
    ...walkFiles(repoRoot, "bin", () => true).filter((p) => !p.slice("bin/".length).includes("/")),
    ...walkFiles(repoRoot, "docs/operator-playbooks", (n) => n.endsWith(".md")).filter(
      (p) => !p.slice("docs/operator-playbooks/".length).includes("/"),
    ),
  ];
  const configIoAbs = join(repoRoot, CONFIG_IO_FILE);
  const rows = buildConfigRows({
    configFiles,
    sections: CONFIG_SECTIONS,
    sectionsSource: existsSync(configIoAbs) ? readFileSync(configIoAbs, "utf8") : "",
    readerFiles: readAll(repoRoot, readerPaths),
  });
  return { family: "config", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
