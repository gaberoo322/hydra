/**
 * test/parse-control-plane.test.mts — verifies the control-plane census
 * generator at dashboard/scripts/parse-control-plane.mjs.
 *
 * The generator parses three repo sources (scripts/autopilot/classes.json,
 * docs/operator-playbooks/hydra-autopilot.md, docs/agents/triage-labels.md)
 * into the committed dashboard/src/data/control-plane.json artifact. These
 * tests assert:
 *   1. The committed artifact is up to date (the `--check` drift path that
 *      #2611's advisory CI check will call exits 0), so the repo can never
 *      ship a stale census.
 *   2. The artifact's shape (classes[]/labels[]/edges[]/skillEdges[], each
 *      entry carrying a sourcePath) matches the acceptance criteria.
 *   3. The generated class list matches the same source of truth decide.py
 *      derives its tuples from — spot-checked against the classes named in
 *      the issue (dev_orch, qa_orch, retro_orch, cleanup_orch,
 *      cleanup_target, design_concept_orch).
 *
 * Slice 1 (tracer bullet) of the Orchestrator-Map epic (#2607, child #2608).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const script = path.join(repoRoot, "dashboard/scripts/parse-control-plane.mjs");
const artifactPath = path.join(repoRoot, "dashboard/src/data/control-plane.json");

type Entry = Record<string, unknown> & { sourcePath?: unknown };
type Census = {
  classes: Array<
    Entry & {
      name: string;
      kind: string;
      skill: string;
      model: unknown;
      cooldownSeconds: unknown;
    }
  >;
  labels: Array<Entry & { name: string }>;
  edges: Array<Entry & { from: string; to: string }>;
  skillEdges: Array<Entry & { class: string; skill: string }>;
};

function loadArtifact(): Census {
  return JSON.parse(readFileSync(artifactPath, "utf8")) as Census;
}

test("committed control-plane.json is up to date (--check drift path)", () => {
  // Exits 0 iff the committed artifact byte-matches a fresh parse. This is
  // the exact invocation the advisory CI drift check (#2611) will run.
  execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });
});

test("artifact has all four collections with a sourcePath on every entry", () => {
  const census = loadArtifact();
  for (const key of ["classes", "labels", "edges", "skillEdges"] as const) {
    const arr = census[key];
    assert.ok(Array.isArray(arr), `${key} must be an array`);
    assert.ok(arr.length > 0, `${key} must be non-empty`);
    for (const entry of arr) {
      assert.equal(
        typeof entry.sourcePath,
        "string",
        `every ${key} entry needs a sourcePath`,
      );
      assert.ok((entry.sourcePath as string).length > 0);
    }
  }
});

test("class census matches decide.py's derived taxonomy names + order", () => {
  const census = loadArtifact();
  // These are decide.py's PIPELINE_SLOTS + SIGNAL_CLASSES, in dispatch
  // order — the tuples decide.py derives from classes.json at import time.
  const expected = [
    "dev_orch",
    "qa_orch",
    "research_orch",
    "dev_target",
    "qa_target",
    "research_target",
    "design_concept_orch",
    "health",
    "sweep_orch",
    "sweep_target",
    "discover_orch",
    "discover_target",
    "scout_orch",
    "architecture_orch",
    "retro_orch",
    "cleanup_orch",
    "cleanup_target",
  ];
  assert.deepEqual(
    census.classes.map((c) => c.name),
    expected,
  );
});

test("spot-checked classes carry the expected kind/skill/model", () => {
  const census = loadArtifact();
  const byName = new Map(census.classes.map((c) => [c.name, c]));
  const check = (
    name: string,
    kind: string,
    skill: string,
    model: string | null,
  ) => {
    const row = byName.get(name);
    assert.ok(row, `class ${name} present`);
    assert.equal(row!.kind, kind, `${name} kind`);
    assert.equal(row!.skill, skill, `${name} skill`);
    assert.equal(row!.model, model, `${name} model`);
  };
  // The exact classes the acceptance criteria names.
  check("dev_orch", "pipeline", "hydra-dev", "fable");
  check("qa_orch", "pipeline", "hydra-qa", "sonnet");
  check("retro_orch", "signal", "hydra-retro", "fable");
  check("cleanup_orch", "signal", "hydra-cleanup", "haiku");
  check("cleanup_target", "signal", "hydra-target-cleanup", "haiku");
  check("design_concept_orch", "pipeline", "hydra-grill", "fable");
});

test("signal classes carry a numeric cooldown; pipeline slots carry null", () => {
  const census = loadArtifact();
  for (const c of census.classes) {
    if (c.kind === "signal") {
      assert.equal(
        typeof c.cooldownSeconds,
        "number",
        `${c.name} (signal) needs a numeric cooldownSeconds`,
      );
    } else {
      assert.equal(
        c.cooldownSeconds,
        null,
        `${c.name} (pipeline) must have null cooldownSeconds`,
      );
    }
  }
});

test("label vocabulary includes the canonical lifecycle labels", () => {
  const census = loadArtifact();
  const names = new Set(census.labels.map((l) => l.name));
  for (const expected of [
    "needs-triage",
    "ready-for-agent",
    "in-progress",
    "needs-qa",
    "blocked",
    "ready-for-human",
    "target-backlog",
  ]) {
    assert.ok(names.has(expected), `label ${expected} present`);
  }
});

test("happy-path edges encode the lifecycle spine and its branches", () => {
  const census = loadArtifact();
  const has = (from: string, to: string) =>
    census.edges.some((e) => e.from === from && e.to === to);
  // Spine.
  assert.ok(has("needs-triage", "ready-for-agent"));
  assert.ok(has("ready-for-agent", "in-progress"));
  assert.ok(has("in-progress", "needs-qa"));
  assert.ok(has("needs-qa", "close"));
  // Branch drops.
  assert.ok(has("ready-for-agent", "blocked"));
  assert.ok(has("ready-for-agent", "needs-info"));
  assert.ok(has("needs-qa", "ready-for-human"));
});

test("skillEdges map every class to its class-skill", () => {
  const census = loadArtifact();
  const classSkill = new Map(census.classes.map((c) => [c.name, c.skill]));
  assert.equal(census.skillEdges.length, census.classes.length);
  for (const edge of census.skillEdges) {
    assert.equal(
      edge.skill,
      classSkill.get(edge.class),
      `skillEdge for ${edge.class} matches its class skill`,
    );
  }
});
