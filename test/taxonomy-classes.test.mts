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
  PROVENANCE_LABELS,
  RESIDUAL_PROVENANCE_LABELS,
  SIGNAL_CLASS_NAMES,
  SIGNAL_CLASS_COOLDOWNS,
  classByName,
  classBySkill,
  parseClassTaxonomy,
  parseDispatchCycleId,
  producerClassFromCycleId,
  provenanceFromLabels,
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
  // issue #2722, epic #2720 — the Target wire-or-retire resolver (24h).
  "wire_or_retire_target",
  // issue #2739, parent #2732 — the Target design-QA visual pass (7d).
  "design_qa_target",
  // issue #2949, epic #2944 — the eval-gated skill pruner (orch, 7d).
  "skill_prune",
  // issue #3351, epic #3350, ADR-0029 — the wayfinder-map AFK working class
  // (orch, 1h; works the next unblocked frontier ticket).
  "wayfinder_orch",
  // issue #3421, epic #3419, ADR-0030 Decision 2 — the tickets-stage producer
  // class (orch, 1h; dispatches the upstream to-tickets skill + Hydra overlay;
  // hydra-prd is demoted to the called renderer library).
  "tickets_orch",
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
  wire_or_retire_target: 24 * 60 * 60,
  design_qa_target: 7 * 24 * 60 * 60,
  skill_prune: 7 * 24 * 60 * 60,
  wayfinder_orch: 3600,
  tickets_orch: 3600,
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
// 1. TS view ↔ JSON row set agreement + the pinned 21-class alphabet
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

  test("exactly the 22 known classes, in dispatch order", () => {
    assert.deepEqual(PIPELINE_SLOT_NAMES, EXPECTED_PIPELINE);
    assert.deepEqual(SIGNAL_CLASS_NAMES, EXPECTED_SIGNAL);
    assert.equal(DISPATCH_CLASSES.length, 22);
  });

  // Regression for issue #3421 (epic #3419, ADR-0030 Decision 2): the
  // tickets-stage class row. The row binds the Pocock `tickets` stage to the
  // vendored upstream `to-tickets` skill (+ Hydra AFK overlay); hydra-prd is
  // demoted to the called PrdInput→issue renderer library and deliberately
  // has NO class row of its own. Expand step only — decide.py's hardcoded
  // pipeline_priority / signal iteration tuples do not dispatch this class
  // yet (that wiring is delta #3423's contract phase).
  test("tickets_orch row: the ADR-0030 tickets-stage class shape (#3421)", () => {
    const row = classByName("tickets_orch");
    assert.ok(row, "tickets_orch row must exist");
    assert.equal(row.kind, "signal");
    assert.equal(row.skill, "to-tickets");
    assert.equal(row.costClass, "other");
    assert.equal(row.learningAgent, null);
    assert.equal(row.cooldownSeconds, 3600);
    assert.equal(row.scope, "orch");
    assert.equal(row.provenanceLabel, null);
    // classBySkill resolves the upstream skill name to the same row.
    assert.equal(classBySkill("to-tickets")?.name, "tickets_orch");
    // hydra-prd itself must NOT (re)gain a dispatch-class row — it is the
    // callee renderer library, not a dispatch identity.
    assert.equal(classBySkill("hydra-prd"), undefined);
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
    assert.equal(parseClassTaxonomy(validText).length, 22);
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
    const { skillToCostClass } = await import("../src/cost/index.ts");
    for (const row of DISPATCH_CLASSES) {
      assert.equal(
        skillToCostClass(row.skill),
        row.costClass,
        `costClass projection drifted for class "${row.name}" (${row.skill})`,
      );
    }
  });

  test("every taxonomy costClass is a declared CostClass bucket", async () => {
    const { COST_CLASS_ORDER } = await import("../src/cost/index.ts");
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

  // ADR-0030 delta seam (issue #3423, epic #3419, Decision 5). The learning loop
  // must not be silently severed when the stage identities move. The two
  // hand-enumerated learning seams — subagent-capture.ts's SubagentSkill union
  // (which learningAgent rows train pattern-memory) and demotion.ts's
  // DEFAULT_FRICTION_SKILLS (which skills' resolved cues get demoted) — are the
  // "break silently on a rename" surfaces Decision 5 flags. The tickets-stage
  // producer (`tickets_orch` → `to-tickets`) is a NON-learning producer
  // (learningAgent null; it renders issues, POSTs no /memory/subagent-friction),
  // so it is CORRECTLY excluded from BOTH seams — the learning-capture pathway is
  // untouched for the classes that DO learn.
  test("ADR-0030: to-tickets is a non-learning producer, absent from both learning seams (#3423)", async () => {
    const cap = await import("../src/pattern-memory/subagent-capture.ts");
    // Learning seam #1 — subagent-capture.ts: to-tickets is NOT a valid
    // lesson-producing skill (learningAgent null → isValidSkill false).
    assert.equal(
      cap.isValidSkill("to-tickets"),
      false,
      "to-tickets renders issues (learningAgent null) — it must not be a lesson skill",
    );
    const ticketsRow = classBySkill("to-tickets");
    assert.ok(ticketsRow, "tickets_orch row must resolve by its to-tickets skill");
    assert.equal(
      ticketsRow.learningAgent,
      null,
      "the tickets producer trains no pattern-memory agent",
    );
    // Learning seam #2 — demotion.ts DEFAULT_FRICTION_SKILLS mirrors the friction
    // producers (the skills that POST /memory/subagent-friction). Read the source
    // list and confirm to-tickets is absent (renders issues, emits no friction)
    // and every learning-class fork skill is still present (not silently dropped).
    const demotionSrc = readFileSync(
      join(REPO_ROOT, "src", "pattern-memory", "demotion.ts"),
      "utf-8",
    );
    const listMatch = demotionSrc.match(
      /DEFAULT_FRICTION_SKILLS\s*=\s*\[([^\]]*)\]/,
    );
    assert.ok(listMatch, "DEFAULT_FRICTION_SKILLS array literal must be present");
    const frictionSkills = listMatch[1];
    assert.equal(
      /["']to-tickets["']/.test(frictionSkills),
      false,
      "to-tickets emits no friction — it must not be in DEFAULT_FRICTION_SKILLS",
    );
    for (const forkSkill of ["hydra-dev", "hydra-qa", "hydra-target-build"]) {
      assert.ok(
        new RegExp(`["']${forkSkill}["']`).test(frictionSkills),
        `${forkSkill} friction capture must not be silently severed (#3423)`,
      );
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

// ---------------------------------------------------------------------------
// 6. Provenance vocabulary + classifier (slice #1672)
// ---------------------------------------------------------------------------

describe("taxonomy: provenance labels derive from the provenanceLabel column (slice #1672)", () => {
  test("PROVENANCE_LABELS equals exactly the non-null provenanceLabel rows, in file order", () => {
    const expected = DISPATCH_CLASSES.filter((r) => r.provenanceLabel !== null).map(
      (r) => r.provenanceLabel,
    );
    assert.deepEqual([...PROVENANCE_LABELS], expected);
    // The live column today: scout, architecture, cleanup. A change here is a
    // deliberate classes.json taxonomy edit, not drift.
    assert.deepEqual([...PROVENANCE_LABELS], [
      "tool-scout",
      "architecture-scan",
      "cleanup-scan",
    ]);
  });

  test("residual list carries sentry — a filing label with no owning class", () => {
    assert.deepEqual([...RESIDUAL_PROVENANCE_LABELS], ["sentry"]);
    // sentry must NOT gain a fake classes.json row (it would pollute the
    // decide.py PIPELINE_SLOTS/SIGNAL_CLASSES derivations).
    assert.equal(
      DISPATCH_CLASSES.some((r) => r.provenanceLabel === "sentry"),
      false,
    );
  });

  test("provenanceFromLabels matches column labels and residual labels alike", () => {
    assert.equal(provenanceFromLabels(["ready-for-agent", "cleanup-scan"]), "cleanup-scan");
    assert.equal(provenanceFromLabels(["tool-scout"]), "tool-scout");
    assert.equal(provenanceFromLabels(["architecture-scan", "tier:3"]), "architecture-scan");
    assert.equal(provenanceFromLabels(["sentry", "bug"]), "sentry");
  });

  test("provenanceFromLabels returns null for no-match — including the dead class alphabet", () => {
    assert.equal(provenanceFromLabels([]), null);
    assert.equal(provenanceFromLabels(["bug", "needs-info"]), null);
    // The pre-#1672 fictional class labels never classify: no writer stamps them.
    assert.equal(provenanceFromLabels(["dev_orch", "qa", "sweep_target"]), null);
  });

  test("first matching label wins and non-string entries are skipped", () => {
    assert.equal(
      provenanceFromLabels(["cleanup-scan", "tool-scout"]),
      "cleanup-scan",
    );
    assert.equal(
      provenanceFromLabels([undefined as unknown as string, "sentry"]),
      "sentry",
    );
  });
});

// ---------------------------------------------------------------------------
// producerClassFromCycleId — the third class lookup (cycleId → class name).
// Relocated here from test/outcome-attribution-subscribe.test.mts (issue #2920),
// so the pure classification invariant lives with the Taxonomy Module it now
// belongs to — no I/O-coordinator dependency graph loaded to assert it.
// ---------------------------------------------------------------------------

describe("taxonomy: producerClassFromCycleId (cycleId → class name, #2920)", () => {
  test("extracts the trailing signal-class token", () => {
    assert.equal(producerClassFromCycleId("worktree-agent-abc-t8-dev_orch"), "dev_orch");
    assert.equal(producerClassFromCycleId("run-1-dev_target"), "dev_target");
    assert.equal(producerClassFromCycleId("sweep_orch"), "sweep_orch");
  });
  test("defaults to unknown for unparseable / empty", () => {
    assert.equal(producerClassFromCycleId("random-id"), "unknown");
    assert.equal(producerClassFromCycleId(""), "unknown");
    assert.equal(producerClassFromCycleId(null), "unknown");
    assert.equal(producerClassFromCycleId(undefined), "unknown");
  });
});

// ---------------------------------------------------------------------------
// parseDispatchCycleId — the fourth cycleId lookup (issue #2942): the full
// {runIdPrefix, turn, className} attribution triple the per-dispatch outcome
// record persists. PURE — string in, parsed triple or null out.
// ---------------------------------------------------------------------------

describe("taxonomy: parseDispatchCycleId (cycleId → attribution triple, #2942)", () => {
  test("parses the harness-stamped worktree-agent-<prefix>-t<N>-<class> form", () => {
    assert.deepEqual(parseDispatchCycleId("worktree-agent-277e4476-t4-dev_orch"), {
      runIdPrefix: "277e4476",
      turn: 4,
      className: "dev_orch",
    });
    assert.deepEqual(parseDispatchCycleId("worktree-agent-deadbeef-t12-dev_target"), {
      runIdPrefix: "deadbeef",
      turn: 12,
      className: "dev_target",
    });
  });

  test("captures multi-underscore class tokens in full (unlike the suffix regex)", () => {
    assert.deepEqual(
      parseDispatchCycleId("worktree-agent-0a1b2c3d-t2-wire_or_retire_target"),
      { runIdPrefix: "0a1b2c3d", turn: 2, className: "wire_or_retire_target" },
    );
  });

  test("lowercases prefix + class and tolerates surrounding whitespace", () => {
    assert.deepEqual(parseDispatchCycleId("  worktree-agent-ABCDEF01-t7-QA_ORCH "), {
      runIdPrefix: "abcdef01",
      turn: 7,
      className: "qa_orch",
    });
  });

  test("returns null for bare-UUID / legacy / malformed ids (dark-tolerant arm)", () => {
    assert.equal(parseDispatchCycleId("8f1c2d3e-aaaa-bbbb-cccc-000000000000"), null);
    assert.equal(parseDispatchCycleId("worktree-agent-277e4476-dev_orch"), null); // no -t<N>-
    assert.equal(parseDispatchCycleId("worktree-agent-277e447-t4-dev_orch"), null); // 7-char prefix
    assert.equal(parseDispatchCycleId("worktree-agent-277e4476-t4-devorch"), null); // no _orch/_target
    assert.equal(parseDispatchCycleId("cycle-2026-05-01T00:00:00"), null);
    assert.equal(parseDispatchCycleId(""), null);
    assert.equal(parseDispatchCycleId(null), null);
    assert.equal(parseDispatchCycleId(undefined), null);
  });
});
