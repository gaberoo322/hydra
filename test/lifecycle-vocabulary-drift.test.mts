import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";
import {
  DESIGN_CONCEPT_FLAG,
  HUMAN_HOLD_STATES,
  OPEN_STATES,
} from "../src/lifecycle/index.ts";

const DOC = "docs/agents/triage-labels.md";
const read = (rel: string) => readFileSync(fileURLToPath(new URL("../" + rel, import.meta.url)), "utf8");
const doc = read(DOC);

const stateSet = new Set<string>(OPEN_STATES);
const boardValues = Object.values(ORCH_BOARD_LABELS) as string[];
const boardStates = boardValues.filter((v) => stateSet.has(v));
const boardFlags = boardValues.filter((v) => !stateSet.has(v));

/** Rows (trimmed cells) of the table under `## <heading>` whose first cell is a backticked label. */
function tableRows(heading: string): string[][] {
  const start = doc.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `${DOC} has no "## ${heading}" section`);
  const rest = doc.slice(start + heading.length + 3);
  const next = rest.search(/\n## /);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  return section
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => /^`[^`]+`$/.test(cells[0] ?? ""));
}
const label = (c: string) => c.replace(/`/g, "");

function diff(want: readonly string[], got: readonly string[]): string {
  const missing = want.filter((x) => !got.includes(x));
  const extra = got.filter((x) => !want.includes(x));
  return `missing=[${missing}] extra=[${extra}] — edit ${DOC} / src/board-labels.ts`;
}

test("ORCH_BOARD_LABELS lifecycle-state values equal OPEN_STATES", () => {
  assert.deepEqual([...boardStates].sort(), [...OPEN_STATES].sort(), diff(OPEN_STATES, boardStates));
  for (const s of OPEN_STATES) {
    const key = s.replaceAll("-", "_") as keyof typeof ORCH_BOARD_LABELS;
    assert.equal(ORCH_BOARD_LABELS[key], s, `ORCH_BOARD_LABELS.${key} must be "${s}"`);
  }
});

test("pre-existing ORCH_BOARD_LABELS keys keep their values and new state values stay out of glm/eligibility.ts", () => {
  const pinned: Record<string, string> = {
    needs_qa: "needs-qa",
    ready_for_agent: "ready-for-agent",
    needs_triage: "needs-triage",
    needs_research: "needs-research",
    in_progress: "in-progress",
    blocked: "blocked",
    target_backlog: "target-backlog",
    glm_eligible: "glm-eligible",
    glm_withhold: "glm-withhold",
    glm_ab_control: "glm-ab-control",
    cleanup_scan: "cleanup-scan",
    needs_design_concept: "needs-design-concept",
  };
  for (const [k, v] of Object.entries(pinned)) {
    assert.equal((ORCH_BOARD_LABELS as Record<string, string>)[k], v, `ORCH_BOARD_LABELS.${k} changed`);
  }
  const eligibility = read("src/glm/eligibility.ts");
  for (const v of ["needs-info", "hitl-grill", "needs-tickets", "needs-dev-resume", "qa-passed", "ready-for-human", "parked"]) {
    assert.ok(!eligibility.includes(`"${v}"`), `src/glm/eligibility.ts quotes the new label literal "${v}"`);
  }
});

test("needs_design_concept flag spelling matches DESIGN_CONCEPT_FLAG", () => {
  assert.equal(ORCH_BOARD_LABELS.needs_design_concept, DESIGN_CONCEPT_FLAG);
  assert.ok(boardFlags.includes(DESIGN_CONCEPT_FLAG));
});

test("triage-labels.md State labels table equals OPEN_STATES in order", () => {
  const got = tableRows("State labels").map((r) => label(r[0]));
  assert.deepEqual(got, [...OPEN_STATES], diff(OPEN_STATES, got));
});

test("triage-labels.md Human-hold column matches HUMAN_HOLD_STATES", () => {
  const holds = tableRows("State labels").filter((r) => r[2] === "yes").map((r) => label(r[0]));
  assert.deepEqual([...holds].sort(), [...HUMAN_HOLD_STATES].sort(), diff(HUMAN_HOLD_STATES, holds));
});

test("triage-labels.md Flag labels table lists every non-state board label and no state", () => {
  const got = tableRows("Flag labels").map((r) => label(r[0]));
  assert.deepEqual([...got].sort(), [...boardFlags].sort(), diff(boardFlags, got));
  for (const g of got) assert.ok(!stateSet.has(g), `flag table lists lifecycle state ${g}`);
});

/** Whole-token match: `target-backlog` must not count as `backlog`. */
function mentions(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w:-])${esc}(?![\\w-])`).test(text);
}

test("retired labels appear nowhere in the vocabulary surfaces", () => {
  const dead = ["backlog", "refactor-batch-2026-05", "merge-ready", "ready-for-merge", "wayfinder:handoff-pending"];
  const board = read("src/board-labels.ts");
  for (const d of dead) {
    assert.ok(!mentions(doc, d), `${DOC} mentions retired label ${d}`);
    assert.ok(!mentions(board, d), `src/board-labels.ts mentions retired label ${d}`);
  }
});
