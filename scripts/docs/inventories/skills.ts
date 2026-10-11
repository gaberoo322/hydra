/**
 * Skills family extractor (issue #4592 — docs-epic slice 6, ADR-0034 §10).
 *
 * `extractSkills(repoRoot, classRows)` renders the operator playbook fleet
 * (docs/operator-playbooks/*.md, non-recursive) as docs/generated/skills.json.
 * One row per playbook, keyed by its frontmatter `name` (which must equal the
 * file basename — the skill name is the sync-skills.sh contract this family
 * inherits). Files under _fragments/ and _vendor/ are never rows: the scan is
 * non-recursive, and a defensive check fails loud if that ever changes.
 *
 * A skill's stage is DERIVED, never hand-listed (INV-15): the stage of the
 * first class row in file order whose `skill` names it; else of the first
 * class row whose `skill_by_ticket_type` names it; else `brain` for the one
 * autopilot skill; else `operator-interactive`. Extraction fails loud unless
 * exactly one skills row is `brain`, and unless every skill a class dispatches
 * (its `skill` or any `skill_by_ticket_type` value) has a playbook.
 *
 * This extractor NEVER imports or shells out to scripts/sync-skills.sh — it
 * only READS the playbooks. Writing the live skill mirror is a deploy step.
 *
 * Stdlib-only (ADR-0005): node:fs + node:path + regex.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClassRow, SkillRow, SkillsInventory } from "./envelope.ts";

/** The playbook directory this family renders (non-recursive). */
export const PLAYBOOKS_DIR = "docs/operator-playbooks";

/** The one skill whose stage is brain (INV-15) — the autopilot loop itself. */
export const BRAIN_SKILL = "hydra-autopilot";

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

/** Frontmatter of a playbook, as the raw strings of its top-level keys. */
function parseFrontmatter(source: string): Map<string, string> {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const out = new Map<string, string>();
  if (!fm) return out;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Strip matching surrounding quotes from a frontmatter scalar. */
function unquote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const m = value.match(/^"([\s\S]*)"$/);
  return (m ? m[1] : value).trim() || null;
}

/** Split a YAML inline list `[a, b]` into trimmed entries; [] when absent. */
function parseInlineList(value: string | undefined): string[] {
  if (!value) return [];
  const m = value.match(/^\[(.*)\]$/);
  if (!m) fail(`expected an inline [a, b] list, got: ${value}`);
  return m[1]
    .split(",")
    .map((s) => unquote(s.trim()) ?? "")
    .filter((s) => s.length > 0);
}

/** `@include <target>` lines of a playbook body, in order (playbook-relative targets). */
function includeTargets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^@include\s+(\S+)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * A skill's DERIVED stage (INV-15). `classRows` must be in file order (the
 * classes inventory's row order).
 */
export function deriveSkillStage(skill: string, classRows: ClassRow[]): string {
  const bySkill = classRows.find((c) => c.skill === skill);
  if (bySkill) return bySkill.stage;
  const byTicketType = classRows.find((c) =>
    Object.values(c.skill_by_ticket_type ?? {}).includes(skill),
  );
  if (byTicketType) return byTicketType.stage;
  if (skill === BRAIN_SKILL) return "brain";
  return "operator-interactive";
}

/** The classes that dispatch `skill` and how — `via` "default" or the ticket type. */
export function dispatchingClasses(skill: string, classRows: ClassRow[]): Array<{ class: string; via: string }> {
  const out: Array<{ class: string; via: string }> = [];
  for (const c of classRows) {
    if (c.skill === skill) out.push({ class: c.name, via: "default" });
    for (const [ticketType, target] of Object.entries(c.skill_by_ticket_type ?? {})) {
      if (target === skill) out.push({ class: c.name, via: ticketType });
    }
  }
  return out;
}

/** Build the skills inventory for `repoRoot`. Rows sorted by name. */
export function extractSkills(repoRoot: string, classRows: ClassRow[]): SkillsInventory {
  const dir = join(repoRoot, PLAYBOOKS_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`${PLAYBOOKS_DIR} is not a directory`);
  }
  const rows: SkillRow[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name.startsWith("_")) {
      fail(`${PLAYBOOKS_DIR}/${entry.name}: a _fragments/_vendor file must never be a skills row`);
    }
    const path = `${PLAYBOOKS_DIR}/${entry.name}`;
    const basename = entry.name.slice(0, -".md".length);
    const source = readFileSync(join(repoRoot, path), "utf8");
    const fm = parseFrontmatter(source);
    const name = unquote(fm.get("name"));
    if (!name) fail(`${path}: frontmatter has no name`);
    if (name !== basename) {
      fail(`${path}: frontmatter name "${name}" must equal the file basename "${basename}"`);
    }
    const afterFrontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    const bodyText = afterFrontmatter ? source.slice(afterFrontmatter[0].length) : source;
    const nameAt = source.indexOf(`name: ${name}`);
    if (nameAt === -1) fail(`${path}: could not locate the frontmatter name line`);
    const nameLine = source.slice(0, nameAt).split("\n").length;

    // composedFrom: compose_base, then reference_files, then @include targets —
    // every target playbook-relative, resolved repo-relative, and ON DISK.
    const composedFrom: string[] = [];
    const push = (rel: string) => {
      const repoRel = `${PLAYBOOKS_DIR}/${rel}`;
      if (!existsSync(join(repoRoot, repoRel))) {
        fail(`${path}: composedFrom target ${rel} (${repoRel}) does not exist on disk`);
      }
      if (!composedFrom.includes(repoRel)) composedFrom.push(repoRel);
    };
    const composeBase = unquote(fm.get("compose_base"));
    if (composeBase) push(composeBase);
    for (const rel of parseInlineList(fm.get("reference_files"))) push(rel);
    for (const rel of includeTargets(bodyText)) push(rel);

    rows.push({
      name,
      path,
      stage: deriveSkillStage(name, classRows),
      description: unquote(fm.get("description")),
      dispatchedBy: dispatchingClasses(name, classRows),
      composedFrom,
      route: `/docs/skill/${name}`,
      source: { path, line: nameLine },
    });
  }

  // INV-15 fail-loud gates: exactly one brain, and every class-dispatched
  // skill has a playbook.
  const brain = rows.filter((r) => r.stage === "brain");
  if (brain.length !== 1) {
    fail(
      brain.length === 0
        ? `no skills row derived stage brain (expected exactly "${BRAIN_SKILL}")`
        : `${brain.length} skills rows derived stage brain (${brain.map((r) => r.name).join(", ")}) — expected exactly one`,
    );
  }
  const byName = new Set(rows.map((r) => r.name));
  for (const c of classRows) {
    if (!byName.has(c.skill)) {
      fail(`class ${c.name} dispatches skill ${c.skill} which has no playbook in ${PLAYBOOKS_DIR}/`);
    }
    for (const target of Object.values(c.skill_by_ticket_type ?? {})) {
      if (!byName.has(target)) {
        fail(`class ${c.name} routes ticket type to skill ${target} which has no playbook in ${PLAYBOOKS_DIR}/`);
      }
    }
  }

  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    family: "skills",
    schemaVersion: 1,
    generatedFrom: [`${PLAYBOOKS_DIR}/*.md`],
    rows,
  };
}

/** The `name [stage]` listing shape for a skills row. */
export function skillRowLabel(row: SkillRow): string {
  return `${row.name} [${row.stage}]`;
}
