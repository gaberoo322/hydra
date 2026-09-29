/**
 * env-vars family extractor (issue #4594 — docs-epic 8/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * One row per environment-variable NAME: {name, readSites, inEnvExample,
 * source}. NAMES AND SITES ONLY — this extractor never reads `.env` and never
 * emits a value or a default (values can be secrets and are host state).
 *
 * Read sites:
 *   - member reads off the process environment object in src/**\/*.ts and
 *     scripts/**\/*.{ts,mjs,js};
 *   - in any such file that ALSO performs a dynamic (bracket) read, every
 *     quoted UPPER_SNAKE string literal containing "_" counts as a dynamic
 *     read site — the envInt(name)-style helper case;
 *   - `${NAME` / `$NAME` in scripts/**\/*.sh and bin/* count ONLY for names
 *     already established by a TS/JS read or .env.example, or prefixed HYDRA_
 *     (shell locals are not env vars).
 * .env.example `NAME=` lines set inEnvExample and create a row even with zero
 * read sites (source = that line). test/, dashboard/, python and .claude/ are
 * not scanned in this slice.
 *
 * Stdlib-only (ADR-0005).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvVarRow, EnvVarsInventory, SourceRef } from "./envelope.ts";
import { byString, lineOf, stripComments, walkFiles } from "./scan.ts";
import type { SourceFile } from "./scan.ts";

const ENV_EXAMPLE = ".env.example";

const GENERATED_FROM = ["src/**/*.ts", "scripts/**/*.{ts,mjs,js}", "scripts/**/*.sh", "bin/*", ".env.example"];

// Built from escaped regex sources so this module's own text never contains
// the literal read forms it scans for (it lives under scripts/ and is scanned).
const MEMBER_READ_RE = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const DYNAMIC_READ_RE = /\bprocess\.env\[/;
const SNAKE_LITERAL_RE = /(["'`])([A-Z][A-Z0-9]*_[A-Z0-9_]*)\1/g;
const SHELL_REF_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_LINE_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;

export interface EnvVarInputs {
  /** src/**\/*.ts + scripts/**\/*.{ts,mjs,js}, raw text. */
  codeFiles: SourceFile[];
  /** scripts/**\/*.sh + bin/*, raw text. */
  shellFiles: SourceFile[];
  /** Raw .env.example text, or null when the file is absent. */
  envExample: string | null;
}

/** Pure row-builder: injected inputs in, rows sorted by name out. */
export function buildEnvVarRows(inputs: EnvVarInputs): EnvVarRow[] {
  const sites = new Map<string, Map<string, SourceRef>>();
  const addSite = (name: string, ref: SourceRef): void => {
    const m = sites.get(name) ?? new Map<string, SourceRef>();
    m.set(`${ref.path}:${ref.line}`, ref);
    sites.set(name, m);
  };

  for (const f of inputs.codeFiles) {
    const code = stripComments(f.src);
    for (const m of code.matchAll(MEMBER_READ_RE)) addSite(m[1], { path: f.path, line: lineOf(code, m.index ?? 0) });
    if (DYNAMIC_READ_RE.test(code)) {
      for (const m of code.matchAll(SNAKE_LITERAL_RE)) addSite(m[2], { path: f.path, line: lineOf(code, m.index ?? 0) });
    }
  }

  const envExampleLine = new Map<string, number>();
  if (inputs.envExample !== null) {
    inputs.envExample.split("\n").forEach((text, i) => {
      const m = ENV_LINE_RE.exec(text);
      if (m && !envExampleLine.has(m[1])) envExampleLine.set(m[1], i + 1);
    });
  }

  const established = new Set<string>([...sites.keys(), ...envExampleLine.keys()]);
  for (const f of inputs.shellFiles) {
    f.src.split("\n").forEach((text, i) => {
      if (text.trimStart().startsWith("#")) return; // shell comment / shebang
      for (const m of text.matchAll(SHELL_REF_RE)) {
        const name = m[1];
        if (established.has(name) || name.startsWith("HYDRA_")) addSite(name, { path: f.path, line: i + 1 });
      }
    });
  }

  const names = new Set<string>([...sites.keys(), ...envExampleLine.keys()]);
  const rows: EnvVarRow[] = [];
  for (const name of names) {
    const readSites = [...(sites.get(name)?.values() ?? [])].sort((a, b) =>
      a.path === b.path ? a.line - b.line : byString(a.path, b.path),
    );
    const exampleLine = envExampleLine.get(name);
    const source = readSites[0] ?? { path: ENV_EXAMPLE, line: exampleLine ?? 0 };
    rows.push({ name, readSites, inEnvExample: exampleLine !== undefined, source });
  }
  rows.sort((a, b) => byString(a.name, b.name));
  return rows;
}

/** The listing/sort label of an env-vars row: its name. */
export function envVarRowLabel(row: EnvVarRow): string {
  return row.name;
}

export function extractEnvVars(repoRoot: string): EnvVarsInventory {
  const read = (path: string): SourceFile => ({ path, src: readFileSync(join(repoRoot, path), "utf8") });
  const codeFiles = [
    ...walkFiles(repoRoot, "src", (n) => n.endsWith(".ts")),
    ...walkFiles(repoRoot, "scripts", (n) => /\.(ts|mjs|js)$/.test(n)),
  ].map(read);
  const shellFiles = [
    ...walkFiles(repoRoot, "scripts", (n) => n.endsWith(".sh")),
    ...walkFiles(repoRoot, "bin", () => true).filter((p) => /^bin\/[^/]+$/.test(p)),
  ].map(read);
  const examplePath = join(repoRoot, ENV_EXAMPLE);
  const envExample = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : null;
  const rows = buildEnvVarRows({ codeFiles, shellFiles, envExample });
  return { family: "env-vars", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
