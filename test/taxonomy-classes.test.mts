/**
 * Dispatch-Class Taxonomy tests (epic #1669, slice #1670).
 *
 * `scripts/autopilot/classes.json` is the single machine-readable table that
 * owns the autopilot dispatch-class alphabet. Two derived views exist:
 *
 *   - Python: `decide.py` derives PIPELINE_SLOTS / SIGNAL_CLASSES /
 *     SIGNAL_COOLDOWNS from it at import time (fail-loud, no fallback).
 *   - TS: `src/taxonomy/classes.ts` re-exports typed rows + lookups.
 *
 * These tests pin three things:
 *
 *   1. The TS view and the JSON row set agree (the issue's acceptance
 *      criterion), and the alphabet is exactly the 17 classes decide.py
 *      embedded before this slice — same names, same order.
 *   2. Python ↔ TS parity: decide.py's derived tuples (slot order AND
 *      cooldown values) equal the TS module's derived views, byte-for-byte
 *      through JSON. This is the "decide.py observable behavior unchanged"
 *      criterion made mechanical.
 *   3. Fail-loud: a missing/malformed/contract-violating table makes
 *      decide.py exit non-zero at import (no silent fallback tuples), and
 *      makes the TS parser throw `InvariantViolationError`.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DISPATCH_CLASSES,
  PIPELINE_SLOT_NAMES,
  SIGNAL_CLASS_NAMES,
  SIGNAL_CLASS_COOLDOWNS,
  classByName,
  classBySkill,
  parseClassTaxonomy,
} from "../src/taxonomy/classes.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLASSES_JSON = join(REPO_ROOT, "scripts", "autopilot", "classes.json");
const DECIDE_PY = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// The exact alphabet decide.py embedded before slice #1670 — order matters
// (it is the dispatch order). Any change here is a deliberate taxonomy edit.
const EXPECTED_PIPELINE = [
  "dev_orch",
  "qa_orch",
  "research_orch",
  "dev_target",
  "qa_target",
  "research_target",
  "design_concept_orch",
];
const EXPECTED_SIGNAL = [
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
const EXPECTED_COOLDOWNS: Record<string, number> = {
  health: 0,
  sweep_orch: 900,
  sweep_target: 900,
  discover_orch: 3600,
  discover_target: 1800,
  scout_orch: 7 * 24 * 60 * 60,
  architecture_orch: 3600,
  retro_orch: 24 * 60 * 60,
  cleanup_orch: 3600,
  cleanup_target: 3600,
};

const REQUIRED_COLUMNS = [
  "name",
  "kind",
  "skill",
  "costClass",
  "learningAgent",
  "cooldownSeconds",
  "scope",
  "provenanceLabel",
];

// ---------------------------------------------------------------------------
// 1. TS view ↔ JSON row set agreement + the pinned 17-class alphabet
// ---------------------------------------------------------------------------

describe("taxonomy: TS view agrees with classes.json", () => {
  const rawRows = (
    JSON.parse(readFileSync(CLASSES_JSON, "utf-8")) as {
      classes: Record<string, unknown>[];
    }
  ).classes;

  test("row names + order are identical between file and TS view", () => {
    assert.deepEqual(
      DISPATCH_CLASSES.map((r) => r.name),
      rawRows.map((r) => r.name),
    );
  });

  test("every column survives the parse verbatim", () => {
    for (const [i, row] of DISPATCH_CLASSES.entries()) {
      for (const col of REQUIRED_COLUMNS) {
        assert.deepEqual(
          (row as unknown as Record<string, unknown>)[col],
          rawRows[i][col],
          `${row.name}.${col}`,
        );
      }
    }
  });

  test("exactly the 17 known classes, in dispatch order", () => {
    assert.deepEqual(PIPELINE_SLOT_NAMES, EXPECTED_PIPELINE);
    assert.deepEqual(SIGNAL_CLASS_NAMES, EXPECTED_SIGNAL);
    assert.equal(DISPATCH_CLASSES.length, 17);
  });

  test("cooldown values match the pre-#1670 embedded SIGNAL_COOLDOWNS", () => {
    assert.deepEqual({ ...SIGNAL_CLASS_COOLDOWNS }, EXPECTED_COOLDOWNS);
  });

  test("nullable columns are explicit null, never absent (file-level)", () => {
    for (const row of rawRows) {
      for (const col of REQUIRED_COLUMNS) {
        assert.ok(col in row, `${String(row.name)} is missing column ${col}`);
      }
    }
  });

  test("lookups: classByName / classBySkill resolve the documented examples", () => {
    assert.equal(classByName("dev_orch")?.skill, "hydra-dev");
    assert.equal(classByName("cleanup_orch")?.skill, "hydra-cleanup");
    assert.equal(classByName("cleanup_orch")?.provenanceLabel, "cleanup-scan");
    assert.equal(
      classByName("architecture_orch")?.provenanceLabel,
      "architecture-scan",
    );
    assert.equal(classByName("scout_orch")?.provenanceLabel, "tool-scout");
    assert.equal(classByName("qa_orch")?.learningAgent, "planner");
    assert.equal(classByName("dev_target")?.learningAgent, "executor");
    assert.equal(classByName("health")?.scope, "both");
    assert.equal(classBySkill("hydra-target-build")?.name, "dev_target");
    assert.equal(classByName("nope_no_such_class"), undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Python ↔ TS parity (decide.py derives the same alphabet)
// ---------------------------------------------------------------------------

describe("taxonomy: decide.py derives identical tuples from the same file", () => {
  test("PIPELINE_SLOTS / SIGNAL_CLASSES / SIGNAL_COOLDOWNS parity", () => {
    const res = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, sys",
          `sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, "scripts", "autopilot"))})`,
          "import decide",
          "print(json.dumps({",
          "  'pipeline': list(decide.PIPELINE_SLOTS),",
          "  'signal': list(decide.SIGNAL_CLASSES),",
          "  'cooldowns': decide.SIGNAL_COOLDOWNS,",
          "}))",
        ].join("\n"),
      ],
      { encoding: "utf-8" },
    );
    assert.equal(res.status, 0, `decide.py import failed: ${res.stderr}`);
    const py = JSON.parse(res.stdout) as {
      pipeline: string[];
      signal: string[];
      cooldowns: Record<string, number>;
    };
    assert.deepEqual(py.pipeline, [...PIPELINE_SLOT_NAMES]);
    assert.deepEqual(py.signal, [...SIGNAL_CLASS_NAMES]);
    assert.deepEqual(py.cooldowns, { ...SIGNAL_CLASS_COOLDOWNS });
    // And against the pinned pre-#1670 values, so a same-bug-both-sides
    // regression in the shared file cannot pass silently.
    assert.deepEqual(py.pipeline, EXPECTED_PIPELINE);
    assert.deepEqual(py.signal, EXPECTED_SIGNAL);
    assert.deepEqual(py.cooldowns, EXPECTED_COOLDOWNS);
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-loud: no fallback tuples on either side
// ---------------------------------------------------------------------------

/** Import decide.py from `dir` (a tempdir copy) and return the spawn result. */
function importDecideFrom(dir: string) {
  return spawnSync(
    "python3",
    ["-c", `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport decide`],
    { encoding: "utf-8" },
  );
}

describe("taxonomy: decide.py hard-fails without a valid classes.json", () => {
  test("missing file → non-zero exit, clear message, no fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "taxonomy-missing-"));
    try {
      copyFileSync(DECIDE_PY, join(dir, "decide.py"));
      // No classes.json copied alongside.
      const res = importDecideFrom(dir);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /dispatch-class taxonomy/);
      assert.match(res.stderr, /missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON → non-zero exit naming the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "taxonomy-malformed-"));
    try {
      copyFileSync(DECIDE_PY, join(dir, "decide.py"));
      writeFileSync(join(dir, "classes.json"), "{ not json", "utf-8");
      const res = importDecideFrom(dir);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /malformed JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("row lacking a required column → non-zero exit naming the column", () => {
    const dir = mkdtempSync(join(tmpdir(), "taxonomy-column-"));
    try {
      copyFileSync(DECIDE_PY, join(dir, "decide.py"));
      const table = JSON.parse(readFileSync(CLASSES_JSON, "utf-8")) as {
        classes: Record<string, unknown>[];
      };
      delete table.classes[0].costClass;
      writeFileSync(join(dir, "classes.json"), JSON.stringify(table), "utf-8");
      const res = importDecideFrom(dir);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /lacks required column/);
      assert.match(res.stderr, /costClass/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("taxonomy: TS parser hard-fails with InvariantViolationError", () => {
  const validText = readFileSync(CLASSES_JSON, "utf-8");

  function assertThrowsInvariant(mutate: (t: { classes: Record<string, unknown>[] }) => void, re: RegExp) {
    const table = JSON.parse(validText) as { classes: Record<string, unknown>[] };
    mutate(table);
    assert.throws(
      () => parseClassTaxonomy(JSON.stringify(table)),
      (err: unknown) => {
        assert.ok(err instanceof Error, "throws an Error");
        assert.equal(
          (err as { code?: string }).code,
          "invariant-violation",
          "carries the machine-readable code",
        );
        assert.match((err as Error).message, re);
        return true;
      },
    );
  }

  test("valid file parses clean", () => {
    assert.equal(parseClassTaxonomy(validText).length, 17);
  });

  test("malformed JSON throws", () => {
    assert.throws(
      () => parseClassTaxonomy("{ not json"),
      (err: unknown) =>
        (err as { code?: string }).code === "invariant-violation" &&
        /malformed JSON/.test((err as Error).message),
    );
  });

  test("missing required column throws, naming the column", () => {
    assertThrowsInvariant((t) => {
      delete t.classes[3].learningAgent;
    }, /lacks required column.*learningAgent/);
  });

  test("duplicate class name throws", () => {
    assertThrowsInvariant((t) => {
      t.classes[1].name = t.classes[0].name;
    }, /duplicate class name/);
  });

  test("signal row with null cooldown throws", () => {
    assertThrowsInvariant((t) => {
      const sig = t.classes.find((r) => r.kind === "signal")!;
      sig.cooldownSeconds = null;
    }, /non-negative integer cooldownSeconds/);
  });

  test("pipeline row with a cooldown throws", () => {
    assertThrowsInvariant((t) => {
      const slot = t.classes.find((r) => r.kind === "pipeline")!;
      slot.cooldownSeconds = 900;
    }, /pipeline rows must carry cooldownSeconds: null/);
  });

  test("unknown kind / scope / learningAgent throw", () => {
    assertThrowsInvariant((t) => {
      t.classes[0].kind = "cron";
    }, /kind must be one of/);
    assertThrowsInvariant((t) => {
      t.classes[0].scope = "everywhere";
    }, /scope must be one of/);
    assertThrowsInvariant((t) => {
      t.classes[0].learningAgent = "critic";
    }, /learningAgent must be null or/);
  });
});

// ---------------------------------------------------------------------------
// Slice #1671 — the three TS projections derive from the table.
//
// These pins make the consolidation mechanical: changing a row's costClass /
// learningAgent / cooldownSeconds column must be reflected by the projection
// with NO edit to the projection module, and (for subagent-capture) the
// hand-written SubagentSkill literal union cannot silently drift from the
// table's learningAgent rows.
// ---------------------------------------------------------------------------

describe("TS projections read the taxonomy (slice #1671)", () => {
  test("skillToCostClass returns each row's costClass column verbatim", async () => {
    const { skillToCostClass } = await import("../src/metrics/aggregate.ts");
    for (const row of DISPATCH_CLASSES) {
      assert.equal(
        skillToCostClass(row.skill),
        row.costClass,
        `costClass projection drifted for class "${row.name}" (${row.skill})`,
      );
    }
  });

  test("every taxonomy costClass is a declared CostClass bucket", async () => {
    const { COST_CLASS_ORDER } = await import("../src/metrics/aggregate.ts");
    const buckets: readonly string[] = COST_CLASS_ORDER;
    for (const row of DISPATCH_CLASSES) {
      assert.ok(
        buckets.includes(row.costClass),
        `class "${row.name}" carries undeclared costClass "${row.costClass}"`,
      );
    }
  });

  test("agentForSkill / isValidSkill mirror the learningAgent column", async () => {
    const mod = await import("../src/pattern-memory/subagent-capture.ts");
    for (const row of DISPATCH_CLASSES) {
      if (row.learningAgent !== null) {
        assert.equal(
          mod.isValidSkill(row.skill),
          true,
          `${row.skill} has a learningAgent row but isValidSkill rejects it`,
        );
        assert.equal(
          mod.agentForSkill(row.skill as never),
          row.learningAgent,
          `agentForSkill projection drifted for class "${row.name}"`,
        );
      } else {
        assert.equal(
          mod.isValidSkill(row.skill),
          false,
          `${row.skill} has no learningAgent row but isValidSkill accepts it`,
        );
      }
    }
  });

  test("scout CLASS_COOLDOWN_DAYS equals the scout_orch row's cooldownSeconds", async () => {
    const { CLASS_COOLDOWN_DAYS } = await import("../src/scout/calendar-walk.ts");
    const row = classByName("scout_orch");
    assert.ok(row, "taxonomy must carry a scout_orch row");
    assert.equal(CLASS_COOLDOWN_DAYS * 24 * 60 * 60, row!.cooldownSeconds);
  });

  test('no "mirrors decide.py" hand-mirror comment remains in calendar-walk', () => {
    const src = readFileSync(
      join(REPO_ROOT, "src", "scout", "calendar-walk.ts"),
      "utf-8",
    );
    assert.equal(
      /mirrors\s+`?decide\.py/i.test(src),
      false,
      "calendar-walk.ts still claims to hand-mirror decide.py",
    );
  });
});
