#!/usr/bin/env node
/**
 * parse-control-plane.mjs — generate the Orchestrator control-plane census
 * from repo source into a committed JSON artifact.
 *
 * Usage:
 *   node dashboard/scripts/parse-control-plane.mjs [--check]
 *
 * Reads three authoritative repo sources and emits
 * dashboard/src/data/control-plane.json:
 *
 *   1. Dispatch-class taxonomy — scripts/autopilot/classes.json.
 *      This is the single machine-readable table decide.py itself derives
 *      SIGNAL_CLASSES / PIPELINE_SLOTS / SIGNAL_COOLDOWNS from at import
 *      time (fail-loud, no fallback tuples; epic #1669). Parsing it — rather
 *      than re-scraping the SIGNAL_CLASSES *tuple expression* out of
 *      decide.py — keys the census on the same source of truth as the brain,
 *      so the two cannot drift. Per-class Model is enriched from the
 *      hydra-autopilot playbook's model-routing table.
 *
 *   2. Label vocabulary + happy-path transitions —
 *      docs/agents/triage-labels.md (the label table + the transitions
 *      fenced block).
 *
 *   3. Class -> skill edges — derived from the same classes.json rows
 *      (each row's `skill` column), which mirror the playbook taxonomy table.
 *
 * Every emitted entry carries a `sourcePath` (repo-relative) so the
 * downstream map component (#2609) can generate GitHub blob deep-links
 * rather than hand-typing them — the exact drift the skills mirror hit in
 * PR #2551.
 *
 * `--check` mode parses the sources and compares against the committed
 * artifact WITHOUT writing; exits non-zero if they differ. This is the
 * hook the advisory CI drift check (#2611) will call.
 *
 * Zero runtime dependencies (Node stdlib only) — respects the ADR-0005 /
 * allow-scripts posture, same as build-spritesheet.js.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dashboard/scripts/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Repo-relative source paths (the values stamped into every entry's
// sourcePath, and the files we read).
const SRC = {
  classes: "scripts/autopilot/classes.json",
  playbook: "docs/operator-playbooks/hydra-autopilot.md",
  labels: "docs/agents/triage-labels.md",
};

const OUT_REL = "dashboard/src/data/control-plane.json";

function readSource(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/**
 * Parse the per-class model-routing table out of the hydra-autopilot
 * playbook. Rows look like:
 *   | `dev_orch` | Fable 5 (keep) | Multi-file, tier-gated ... |
 *   | `sweep_orch` / `sweep_target` | Sonnet | ... |
 *   | `discover_orch` / `discover_target` | Haiku | ... |
 * A single row can name multiple classes (slash-separated). Returns a
 * Map<className, modelAlias> where modelAlias is the harness alias
 * (fable | sonnet | haiku | opus). Classes absent from the table inherit
 * the parent session, represented here as null.
 */
function parseModelRouting(playbookText) {
  const models = new Map();
  const modelAlias = (raw) => {
    const m = raw.toLowerCase();
    if (m.includes("fable")) return "fable";
    if (m.includes("sonnet")) return "sonnet";
    if (m.includes("haiku")) return "haiku";
    if (m.includes("opus")) return "opus";
    return null;
  };
  // Match table rows whose FIRST cell contains one or more `backticked`
  // class names and whose SECOND cell names a model. The routing table is
  // the only table in the playbook whose first-cell backtick tokens are
  // paired with a model word in the second cell, so this is unambiguous.
  const rowRe = /^\|([^|]*`[^|]*)\|([^|]+)\|/gm;
  let match;
  while ((match = rowRe.exec(playbookText)) !== null) {
    const firstCell = match[1];
    const secondCell = match[2].trim();
    const alias = modelAlias(secondCell);
    if (!alias) continue; // header / rationale-only rows have no model word
    const classNames = [...firstCell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    if (classNames.length === 0) continue;
    for (const name of classNames) {
      // First occurrence wins (the model table precedes any later mention).
      if (!models.has(name)) models.set(name, alias);
    }
  }
  return models;
}

/**
 * Build classes[] and skillEdges[] from classes.json, enriched with the
 * playbook model routing.
 */
function buildClassesAndSkillEdges(classesJson, models) {
  const parsed = JSON.parse(classesJson);
  if (!parsed || !Array.isArray(parsed.classes) || parsed.classes.length === 0) {
    throw new Error(
      `${SRC.classes}: expected a non-empty { classes: [...] } object`,
    );
  }
  const classes = [];
  const skillEdges = [];
  const seenSkillEdge = new Set();
  for (const row of parsed.classes) {
    if (!row || typeof row.name !== "string" || !row.name) {
      throw new Error(`${SRC.classes}: a class row is missing a name`);
    }
    if (typeof row.kind !== "string" || !row.kind) {
      throw new Error(`${SRC.classes}: class ${row.name} is missing kind`);
    }
    if (typeof row.skill !== "string" || !row.skill) {
      throw new Error(`${SRC.classes}: class ${row.name} is missing skill`);
    }
    classes.push({
      name: row.name,
      kind: row.kind,
      skill: row.skill,
      scope: row.scope ?? null,
      // cooldownSeconds is null for pipeline slots; a non-negative int for
      // signal classes (the classes.json contract, enforced by decide.py).
      cooldownSeconds: row.cooldownSeconds ?? null,
      // Model routing lives in the playbook, not classes.json; null means
      // "inherit the parent session".
      model: models.get(row.name) ?? null,
      sourcePath: SRC.classes,
    });
    const edgeKey = `${row.name}->${row.skill}`;
    if (!seenSkillEdge.has(edgeKey)) {
      seenSkillEdge.add(edgeKey);
      skillEdges.push({
        class: row.name,
        skill: row.skill,
        sourcePath: SRC.classes,
      });
    }
  }
  return { classes, skillEdges };
}

/**
 * Parse the label vocabulary table from triage-labels.md. Rows look like:
 *   | `needs-triage` | New issue, not yet classified | Auto on issue open |
 * The "Classification" row groups three slash-separated labels
 * (`enhancement` / `bug` / `refactor`) — each becomes its own entry.
 */
function parseLabels(labelsText) {
  const labels = [];
  const seen = new Set();
  // Only scan the "## Label vocabulary" section so we don't accidentally
  // pick up any other backtick-first table.
  const start = labelsText.indexOf("## Label vocabulary");
  const rest = start === -1 ? labelsText : labelsText.slice(start);
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  let match;
  while ((match = rowRe.exec(rest)) !== null) {
    const nameCell = match[1];
    // A vocabulary row's first cell is one or more `backticked` labels.
    const names = [...nameCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (names.length === 0) continue; // header / separator rows
    const meaning = match[2].replace(/`/g, "").trim();
    const whoApplies = match[3].replace(/`/g, "").trim();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      labels.push({
        name,
        meaning,
        whoApplies,
        sourcePath: SRC.labels,
      });
    }
  }
  if (labels.length === 0) {
    throw new Error(`${SRC.labels}: no label vocabulary rows parsed`);
  }
  return labels;
}

/**
 * Parse the happy-path transition edges from the transitions fenced block
 * in triage-labels.md:
 *
 *   needs-triage → ready-for-agent → in-progress → needs-qa → (close)
 *                        ↓                              ↓
 *                   blocked / needs-info        ready-for-human
 *
 * The main horizontal spine is a chain of `A → B → C ...`. The two ↓
 * branches drop from a spine node to the labels on the line below. We
 * encode: the spine chain as sequential edges, plus each branch as an edge
 * from the spine node above the ↓ to each label on the branch line.
 */
function parseEdges(labelsText) {
  const start = labelsText.indexOf("## Transitions (typical happy path)");
  if (start === -1) {
    throw new Error(`${SRC.labels}: transitions section not found`);
  }
  const fenceStart = labelsText.indexOf("```", start);
  const fenceEnd = labelsText.indexOf("```", fenceStart + 3);
  if (fenceStart === -1 || fenceEnd === -1) {
    throw new Error(`${SRC.labels}: transitions fenced block not found`);
  }
  const block = labelsText.slice(fenceStart + 3, fenceEnd);
  const lines = block.split("\n");

  const labelRe = /[a-z][a-z-]+/g;
  // Extract labels (and their column position) from a line.
  const labelsOnLine = (line) =>
    [...line.matchAll(labelRe)].map((m) => ({
      name: m[0],
      col: m.index,
    }));

  const edges = [];
  const seen = new Set();
  const addEdge = (from, to) => {
    if (from === to) return;
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, sourcePath: SRC.labels });
  };

  // First pass: build the horizontal spine (the first line that carries a
  // → chain of real labels). "(close)" is not a label, so it is skipped by
  // labelRe's [a-z] anchor requiring a leading letter — but "close" inside
  // "(close)" DOES match, so we treat it as a terminal state node.
  let spineLine = null;
  let spineLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("→")) {
      spineLine = lines[i];
      spineLineIdx = i;
      break;
    }
  }
  if (!spineLine) {
    throw new Error(`${SRC.labels}: no horizontal transition spine found`);
  }
  const spine = labelsOnLine(spineLine);
  for (let i = 0; i + 1 < spine.length; i++) {
    addEdge(spine[i].name, spine[i + 1].name);
  }

  // Second pass: branch drops. A line containing "↓" marks columns where a
  // branch descends from the spine node above it to the label(s) on the
  // NEXT non-arrow line, aligned by column proximity.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("↓")) continue;
    const arrowCols = [];
    for (let c = 0; c < lines[i].length; c++) {
      if (lines[i][c] === "↓") arrowCols.push(c);
    }
    // The branch-target labels are on the next line that has labels.
    let targetLine = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = labelsOnLine(lines[j]);
      if (l.length > 0) {
        targetLine = l;
        break;
      }
    }
    if (!targetLine) continue;
    // Map each ↓ column to the nearest spine node (source) and the
    // branch-line label(s) it sits above (targets), by column proximity.
    for (const arrowCol of arrowCols) {
      const source = nearestByCol(spine, arrowCol);
      if (!source) continue;
      // Targets on this branch line whose column is closest to this arrow.
      for (const t of targetLine) {
        if (nearestCol(arrowCols, t.col) === arrowCol) {
          addEdge(source.name, t.name);
        }
      }
    }
  }

  return edges;
}

function nearestByCol(nodes, col) {
  let best = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const d = Math.abs(n.col - col);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

function nearestCol(cols, col) {
  let best = null;
  let bestDist = Infinity;
  for (const c of cols) {
    const d = Math.abs(c - col);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function build() {
  const classesJson = readSource(SRC.classes);
  const playbookText = readSource(SRC.playbook);
  const labelsText = readSource(SRC.labels);

  const models = parseModelRouting(playbookText);
  const { classes, skillEdges } = buildClassesAndSkillEdges(classesJson, models);
  const labels = parseLabels(labelsText);
  const edges = parseEdges(labelsText);

  return {
    doc:
      "Orchestrator control-plane census. GENERATED by " +
      "dashboard/scripts/parse-control-plane.mjs from repo source — do NOT " +
      "hand-edit. Regenerate with `node dashboard/scripts/parse-control-plane.mjs`. " +
      "classes[] derive from scripts/autopilot/classes.json (the taxonomy " +
      "decide.py itself reads) enriched with the hydra-autopilot playbook's " +
      "model routing; labels[]/edges[] from docs/agents/triage-labels.md; " +
      "skillEdges[] from the classes.json skill column. Every entry carries a " +
      "repo-relative sourcePath for downstream GitHub blob deep-links (epic #2607).",
    sources: SRC,
    classes,
    labels,
    edges,
    skillEdges,
  };
}

// Stable 2-space JSON with a trailing newline (matches the repo's committed
// JSON convention and gives byte-stable diffs for the drift check).
function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function main() {
  const check = process.argv.includes("--check");
  const outPath = path.join(REPO_ROOT, OUT_REL);
  const next = serialize(build());

  if (check) {
    let current = null;
    try {
      current = readFileSync(outPath, "utf8");
    } catch {
      current = null;
    }
    if (current !== next) {
      console.error(
        `control-plane.json is STALE — regenerate with\n` +
          `  node ${path.relative(REPO_ROOT, path.join(__dirname, "parse-control-plane.mjs"))}\n` +
          `and commit ${OUT_REL}.`,
      );
      process.exit(1);
    }
    console.log(`${OUT_REL} is up to date.`);
    return;
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, next);
  console.log(`Wrote ${OUT_REL}`);
}

main();
