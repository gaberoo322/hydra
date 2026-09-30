/**
 * ci-gates family extractor (issue #4595 — docs-epic 9/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * One row per job id in .github/workflows/*.yml =
 *   {workflow, job, name, triggers, required, requiredBy, source}
 *
 * - Job ids are the two-space keys under the top-level `jobs:`; `name` is the
 *   job's own four-space `name:` (never a step's), or null.
 * - `triggers` is the sorted event keys of `on:`. Supported forms: the block
 *   form (two-space event keys), scalar `on: push`, and flow-list
 *   `on: [a, b]`. Any other form throws, and so does a workflow with zero jobs
 *   — a misparse must never produce a green, wrong catalogue.
 * - `required` = (workflow === "ci.yml"). Branch protection lives in no repo
 *   file, so this is a documented CONVENTION (#4542): EVERY row carries
 *   requiredBy: "ci.yml convention", naming the evidence behind both values.
 *   The extractor never calls gh and never reads branch protection.
 *
 * READ-ONLY over the workflow files (Verifier Core paths among them): the
 * YAML is line-scanned, never edited, and no YAML dependency is added
 * (ADR-0005). Rows sort by `workflow/job`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiGateRow, CiGatesInventory } from "./envelope.ts";
import { byString, fail } from "./scan.ts";

const WORKFLOW_DIR = ".github/workflows";

const GENERATED_FROM = [".github/workflows/*.yml"];

const REQUIRED_BY = "ci.yml convention" as const;

/** A YAML key token: bare or quoted. */
function keyOf(text: string): string {
  return text.trim().replace(/^["']|["']$/g, "");
}

/** Is this line a top-level (column-0) mapping key — not a comment, not blank? */
function topLevelKey(line: string): string | null {
  const m = /^(["']?[A-Za-z_][\w-]*["']?)\s*:(.*)$/.exec(line);
  return m ? keyOf(m[1]) : null;
}

/** The sorted `on:` event keys of one workflow's text; throws on an unsupported form. */
export function parseTriggers(file: string, src: string): string[] {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => {
    const k = topLevelKey(l);
    return k === "on" || k === "true"; // YAML 1.1 reads a bare `on` key as boolean true
  });
  if (at === -1) fail(`${file}: no top-level "on:" key`);
  const rest = lines[at].slice(lines[at].indexOf(":") + 1).replace(/\s+#.*$/, "").trim();
  if (rest.startsWith("[")) {
    if (!rest.endsWith("]")) fail(`${file}: unsupported "on:" form (unterminated flow list): ${rest}`);
    const items = rest.slice(1, -1).split(",").map(keyOf).filter((s) => s.length > 0);
    if (items.length === 0) fail(`${file}: "on:" flow list is empty`);
    return items.sort(byString);
  }
  if (rest.length > 0) {
    if (!/^["']?[A-Za-z_][\w-]*["']?$/.test(rest)) fail(`${file}: unsupported "on:" form: ${rest}`);
    return [keyOf(rest)];
  }
  const events: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break; // next top-level key ends the block
    const m = /^ {2}(["']?[A-Za-z_][\w-]*["']?)\s*:/.exec(line);
    if (m) events.push(keyOf(m[1]));
  }
  if (events.length === 0) fail(`${file}: unsupported "on:" form (empty block)`);
  return events.sort(byString);
}

/** Pure row-builder for ONE workflow file: its basename + text in, its job rows out. */
export function buildCiGateRows(workflow: string, src: string): CiGateRow[] {
  const file = `${WORKFLOW_DIR}/${workflow}`;
  const triggers = parseTriggers(file, src);
  const lines = src.split("\n");
  const jobsAt = lines.findIndex((l) => topLevelKey(l) === "jobs");
  if (jobsAt === -1) fail(`${file}: no top-level "jobs:" key`);

  const jobs: Array<{ job: string; line: number; name: string | null }> = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const jobM = /^ {2}(["']?[A-Za-z_][\w-]*["']?)\s*:\s*(#.*)?$/.exec(line);
    if (jobM) {
      jobs.push({ job: keyOf(jobM[1]), line: i + 1, name: null });
      continue;
    }
    const nameM = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    const current = jobs[jobs.length - 1];
    if (nameM && current && current.name === null) current.name = keyOf(nameM[1].replace(/\s+#.*$/, ""));
  }
  if (jobs.length === 0) fail(`${file}: workflow has zero jobs`);

  return jobs.map((j) => ({
    workflow,
    job: j.job,
    name: j.name,
    triggers,
    required: workflow === "ci.yml",
    requiredBy: REQUIRED_BY,
    source: { path: file, line: j.line },
  }));
}

/** The listing label of a ci-gates row; rows sort by it. */
export function ciGateRowLabel(row: CiGateRow): string {
  return `${row.workflow}/${row.job}`;
}

export function extractCiGates(repoRoot: string): CiGatesInventory {
  const dir = join(repoRoot, WORKFLOW_DIR);
  const workflows = readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .sort(byString);
  if (workflows.length === 0) fail(`${WORKFLOW_DIR}: no *.yml workflows found`);
  const rows: CiGateRow[] = [];
  for (const wf of workflows) rows.push(...buildCiGateRows(wf, readFileSync(join(dir, wf), "utf8")));
  rows.sort((a, b) => byString(ciGateRowLabel(a), ciGateRowLabel(b)));
  return { family: "ci-gates", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
