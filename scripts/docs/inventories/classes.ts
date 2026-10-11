/**
 * Classes family extractor (issue #4592 — docs-epic slice 6, per the #4542
 * resolution decision 5 + handoff-ratified findings 4 and 5, ADR-0034 §10).
 *
 * `extractClasses(repoRoot)` renders the dispatch-class table
 * (scripts/autopilot/classes.json) as docs/generated/classes.json — the table
 * the /docs catalogue at /docs/cat/classes and the playbook's table pointers
 * read. There is NO second column contract here: the file is parsed through
 * `parseClassTaxonomy` (src/taxonomy/classes.ts), so every column the parser
 * validates is exactly what this extractor can carry, and a taxonomy change
 * that passes the parser can never leave the inventory behind.
 *
 * Rows keep FILE order with an explicit `order` index — the skills extractor
 * derives a skill's stage from "the first class row in file order that names
 * it", so the order must travel with the data, not be re-derived by sort.
 *
 * `home`/`secondaryHome` are the ONE constant rule (INV-13): every class's
 * live state lives on the same two cockpit pages, and a test cross-checks
 * docs/generated/pages.json that both are `kind: "live"` routes — a detail
 * page can never silently become a class home.
 *
 * Stdlib-only (ADR-0005): node:fs + node:path + the typed parser.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClassTaxonomy } from "../../../src/taxonomy/classes.ts";
import type { ClassRow, ClassesInventory } from "./envelope.ts";

/** The taxonomy file — the single source this family renders. */
export const TAXONOMY_SOURCE = "scripts/autopilot/classes.json";

/** The one constant home rule (INV-13): where every class's live state lives. */
export const CLASS_HOME = "/now";
export const CLASS_SECONDARY_HOME = "/runs";

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

/**
 * 1-based line of the row whose `name` is `name` in the raw JSON text. Rows
 * are unique by name (the parser rejects duplicates), and every row carries
 * `name` as its first key on its own line.
 */
function rowLine(raw: string, name: string): number {
  const re = new RegExp(`^[ \\t]*"name":\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[ \\t]*,?[ \\t]*$`, "m");
  const m = re.exec(raw);
  if (!m) fail(`could not locate the source line of class "${name}" in ${TAXONOMY_SOURCE}`);
  return raw.slice(0, m.index).split("\n").length;
}

/** Build the classes inventory for `repoRoot`. Row order is file order. */
export function extractClasses(repoRoot: string): ClassesInventory {
  const raw = readFileSync(join(repoRoot, TAXONOMY_SOURCE), "utf8");
  const parsed = parseClassTaxonomy(raw); // the ONE column contract — fail-loud
  const rows: ClassRow[] = parsed.map((row, order) => ({
    order,
    name: row.name,
    kind: row.kind,
    skill: row.skill,
    stage: row.stage,
    model: row.model,
    skill_by_ticket_type: row.skill_by_ticket_type ? { ...row.skill_by_ticket_type } : null,
    costClass: row.costClass,
    learningAgent: row.learningAgent,
    cooldownSeconds: row.cooldownSeconds,
    scope: row.scope,
    provenanceLabel: row.provenanceLabel,
    notes: row.notes ?? null,
    home: CLASS_HOME,
    secondaryHome: CLASS_SECONDARY_HOME,
    source: { path: TAXONOMY_SOURCE, line: rowLine(raw, row.name) },
  }));
  return {
    family: "classes",
    schemaVersion: 1,
    generatedFrom: [TAXONOMY_SOURCE],
    rows,
  };
}

/** The `name (stage/model)` listing shape for a classes row. */
export function classRowLabel(row: ClassRow): string {
  return `${row.name} (${row.stage}/${row.model})`;
}
