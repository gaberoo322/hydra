/**
 * chores family extractor (issue #4594 — docs-epic 8/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * Text-scans the `const chores: Chore[] = [` literal in
 * src/scheduler/housekeeping.ts. It is NOT importable: the list is built
 * inside runHousekeeping, and the module pulls @sentry/node, the logger and
 * Redis accessors — so this extractor never imports it (and never edits it).
 *
 * Row = {order, name, cadence, source}. Rows keep REGISTRY EXECUTION ORDER
 * (the order Housekeeping runs them) with an explicit `order` index. Cadence
 * comes from each chore's guard period constant: WEEK_MS → weekly, DAY_MS →
 * daily, no guard → every-run (runs on every hydra-housekeeping.timer tick).
 * Zero chores, a duplicate name, or a guard with an unrecognised period
 * constant throws.
 *
 * Stdlib-only (ADR-0005). Fail-loud (CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChoreRow, ChoresInventory } from "./envelope.ts";
import { fail, lineOf, stripComments } from "./scan.ts";

const HOUSEKEEPING_FILE = "src/scheduler/housekeeping.ts";

const GENERATED_FROM = ["src/scheduler/housekeeping.ts"];

const CADENCE_BY_PERIOD: Record<string, "weekly" | "daily"> = { WEEK_MS: "weekly", DAY_MS: "daily" };

/** Pure row-builder: housekeeping.ts source text in, rows in registry order out. */
export function buildChoreRows(source: string): ChoreRow[] {
  const code = stripComments(source);
  const open = code.search(/\bconst\s+chores\s*:\s*Chore\[\]\s*=\s*\[/);
  if (open === -1) fail(`${HOUSEKEEPING_FILE}: no "const chores: Chore[] = [" literal found`);
  const start = code.indexOf("[", code.indexOf("=", open)) + 1;

  // Walk the literal's top-level objects by brace depth (strings skipped).
  const objects: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let objStart = -1;
  let quote: string | null = null;
  let end = -1;
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "(" || ch === "[") {
      if (depth === 0 && ch === "{") objStart = i;
      depth += 1;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0 && ch === "]") {
        end = i;
        break;
      }
      depth -= 1;
      if (depth === 0 && ch === "}" && objStart !== -1) {
        objects.push({ start: objStart, end: i + 1 });
        objStart = -1;
      }
    }
  }
  if (end === -1) fail(`${HOUSEKEEPING_FILE}: the chores literal never closes`);

  const rows: ChoreRow[] = [];
  const seen = new Set<string>();
  for (const obj of objects) {
    const text = code.slice(obj.start, obj.end);
    const nameM = /\bname\s*:\s*(["'])([^"']+)\1/.exec(text);
    if (!nameM) fail(`${HOUSEKEEPING_FILE}:${lineOf(code, obj.start)}: chore entry has no literal name`);
    const name = nameM[2];
    if (seen.has(name)) fail(`${HOUSEKEEPING_FILE}: duplicate chore name "${name}"`);
    seen.add(name);
    let cadence: ChoreRow["cadence"] = "every-run";
    const guardAt = text.search(/\bguard\s*:/);
    if (guardAt !== -1) {
      const workAt = text.search(/\bwork\s*:/);
      const guardText = text.slice(guardAt, workAt > guardAt ? workAt : undefined);
      const period = /\b([A-Z][A-Z0-9_]*_MS)\b/.exec(guardText);
      const mapped = period ? CADENCE_BY_PERIOD[period[1]] : undefined;
      if (!mapped) {
        fail(`${HOUSEKEEPING_FILE}: chore "${name}" has a guard with an unrecognised period constant (${period ? period[1] : "none"})`);
      }
      cadence = mapped;
    }
    rows.push({
      order: rows.length,
      name,
      cadence,
      source: { path: HOUSEKEEPING_FILE, line: lineOf(code, obj.start + (nameM.index ?? 0)) },
    });
  }
  if (rows.length === 0) fail(`${HOUSEKEEPING_FILE}: the chores literal scanned empty`);
  return rows;
}

/** The listing label of a chores row (registry order is part of the truth). */
export function choreRowLabel(row: ChoreRow): string {
  return `${row.order} ${row.name}`;
}

export function extractChores(repoRoot: string): ChoresInventory {
  const rows = buildChoreRows(readFileSync(join(repoRoot, HOUSEKEEPING_FILE), "utf8"));
  return { family: "chores", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
