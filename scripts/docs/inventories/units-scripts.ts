/**
 * units-scripts family extractor (issue #4595 — docs-epic 9/13, per the
 * #4542 families table and ADR-0034 §10).
 *
 * One row per SHIPPED file matching scripts/systemd/*, scripts/*.sh,
 * scripts/*.ts or bin/* =
 *   {path, kind, name, description, execStart, triggers, schedule, source}
 *
 * - Units (kind service|timer): description = Description=; services get
 *   execStart = the first ExecStart= verbatim (e.g. `%h` unexpanded); timers
 *   get triggers = Unit= (default <basename>.service) and schedule = the
 *   OnCalendar= / OnBootSec= / OnUnitActiveSec= values joined in file order.
 * - Scripts (kind sh|ts|bin): description = the first non-empty line of the
 *   header comment — the contiguous `#` block right after the shebang, or the
 *   leading `/** *\/` or `//` block for .ts. No header → null (the view renders
 *   'no header comment'); nothing throws, because a missing description is a
 *   documentation gap, not an extraction error.
 * - Inapplicable fields are null. Environment= / EnvironmentFile= values are
 *   NEVER emitted (they can be secrets, and they are host state).
 * - The row describes what the repo SHIPS, never host-installed state:
 *   nothing here asks systemd, and a unit installed on the host but absent
 *   from scripts/systemd/ is not a row.
 *
 * Subdirectories of scripts/ (autopilot/, ci/, docs/, …) are deliberately not
 * scanned — they are internal helpers, not the shipped surface. Line-scanned,
 * no INI dependency (ADR-0005). Rows sort by path.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UnitScriptRow, UnitsScriptsInventory } from "./envelope.ts";
import { byString } from "./scan.ts";

const GENERATED_FROM = ["scripts/systemd/*", "scripts/*.sh", "scripts/*.ts", "bin/*"];

const SCHEDULE_KEYS = new Set(["OnCalendar", "OnBootSec", "OnUnitActiveSec"]);

/** `Key=value` pairs of a unit file, in file order (comments and section headers skipped). */
function unitEntries(src: string): Array<{ key: string; value: string; line: number }> {
  const out: Array<{ key: string; value: string; line: number }> = [];
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) return;
    const eq = line.indexOf("=");
    if (eq <= 0) return;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim(), line: i + 1 });
  });
  return out;
}

/** First non-empty line of a comment block, with its comment markers stripped. */
function firstCommentLine(lines: string[], strip: (l: string) => string): string | null {
  for (const l of lines) {
    const text = strip(l).trim();
    if (text.length > 0) return text;
  }
  return null;
}

/** The header-comment description of a shell-style script (contiguous `#` block after the shebang). */
export function shellHeader(src: string): string | null {
  const lines = src.split("\n");
  const start = lines[0]?.startsWith("#!") ? 1 : 0;
  const block: string[] = [];
  for (let i = start; i < lines.length && /^\s*#/.test(lines[i]); i += 1) block.push(lines[i]);
  return firstCommentLine(block, (l) => l.replace(/^\s*#+/, ""));
}

/** The header-comment description of a .ts script (leading `/** *\/` or `//` block, after an optional shebang). */
export function tsHeader(src: string): string | null {
  const lines = src.split("\n");
  let i = lines[0]?.startsWith("#!") ? 1 : 0;
  if (lines[i]?.trim().startsWith("/*")) {
    const block: string[] = [];
    for (; i < lines.length; i += 1) {
      block.push(lines[i]);
      if (lines[i].includes("*/")) break;
    }
    return firstCommentLine(block, (l) => l.replace(/^\s*\/\*+/, "").replace(/\*+\/\s*$/, "").replace(/^\s*\*+/, ""));
  }
  const block: string[] = [];
  for (; i < lines.length && /^\s*\/\//.test(lines[i]); i += 1) block.push(lines[i]);
  return firstCommentLine(block, (l) => l.replace(/^\s*\/\/+/, ""));
}

/** Pure row-builder for one shipped file: repo-relative path + text in, one row out. */
export function buildUnitScriptRow(path: string, src: string): UnitScriptRow {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const base = { path, name, execStart: null, triggers: null, schedule: null, source: { path, line: 1 } };
  if (path.startsWith("scripts/systemd/")) {
    const entries = unitEntries(src);
    const desc = entries.find((e) => e.key === "Description");
    const source = { path, line: desc ? desc.line : 1 };
    if (name.endsWith(".timer")) {
      const unit = entries.find((e) => e.key === "Unit");
      const schedule = entries.filter((e) => SCHEDULE_KEYS.has(e.key)).map((e) => e.value);
      return {
        ...base,
        kind: "timer",
        description: desc ? desc.value : null,
        triggers: unit ? unit.value : `${name.slice(0, -".timer".length)}.service`,
        schedule: schedule.length > 0 ? schedule.join(", ") : null,
        source,
      };
    }
    const exec = entries.find((e) => e.key === "ExecStart");
    return { ...base, kind: "service", description: desc ? desc.value : null, execStart: exec ? exec.value : null, source };
  }
  if (path.startsWith("bin/")) return { ...base, kind: "bin", description: shellHeader(src) };
  if (path.endsWith(".ts")) return { ...base, kind: "ts", description: tsHeader(src) };
  return { ...base, kind: "sh", description: shellHeader(src) };
}

/** The listing label of a units-scripts row; rows sort by it. */
export function unitScriptRowLabel(row: UnitScriptRow): string {
  return row.path;
}

/** Plain files directly in `<repoRoot>/<dir>` accepted by `accept` (no recursion), repo-relative. */
function filesIn(repoRoot: string, dir: string, accept: (name: string) => boolean): string[] {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => !n.startsWith(".") && accept(n) && statSync(join(abs, n)).isFile())
    .map((n) => `${dir}/${n}`);
}

export function extractUnitsScripts(repoRoot: string): UnitsScriptsInventory {
  const paths = [
    ...filesIn(repoRoot, "scripts/systemd", (n) => n.endsWith(".service") || n.endsWith(".timer")),
    ...filesIn(repoRoot, "scripts", (n) => n.endsWith(".sh") || n.endsWith(".ts")),
    ...filesIn(repoRoot, "bin", () => true),
  ].sort(byString);
  const rows = paths.map((p) => buildUnitScriptRow(p, readFileSync(join(repoRoot, p), "utf8")));
  return { family: "units-scripts", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
