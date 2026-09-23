/**
 * Class-state backend (issue #4635, ADR-0034 §9.2 / PR #4617).
 *
 * Covers the design concept's invariants:
 *
 *   - INV-5/INV-6 — last-fired max(hash, latest snapshot) + server-side
 *     cooldown-remaining math (never a fabricated 0 for unknown, 0 only for
 *     a never-fired signal class, null for pipeline rows).
 *   - INV-7 — the four verdict freshness states (unknown / stale / fresh /
 *     not-evaluated) and the 15-minute freshness budget.
 *   - INV-8 — the starvation streak: budget/stagger outcomes, the
 *     transparent global-block + stale-plan turns, PROMOTION_THRESHOLD.
 *   - INV-9 — static dead derivation (trigger vs suppressor reads).
 *   - INV-10 — drift pins keeping PRODUCERLESS_SIGNALS,
 *     CLASS_TRIGGER_INPUTS, decide.py and reap_state.py honest.
 *   - INV-11 — pipeline-only slotOccupant under the verdict's freshness.
 *   - INV-12 — the envelope shape + header gates (scope, usage,
 *     burnedClasses, quotaDeltaCap, degraded).
 *   - INV-13 — readClassState degradation with injectable deps (never
 *     throws, names failed sources in header.degraded).
 *   - INV-2/INV-3 — recordTurn sanitisation + persistence of the new
 *     turn-row fields.
 *   - INV-4 — the key-literal pin against reap_state.py.
 *
 * Pure-composition cases take a tiny synthetic taxonomy slice so each
 * assertion names the row it is about; one parity case pins the REAL
 * DISPATCH_CLASSES ordering. No Redis: every source is injected.
 */

import test, { beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composeClassState,
  readClassState,
  VERDICT_FRESHNESS_BUDGET_SECONDS,
  STARVED_LOOKBACK_TURNS,
  type ClassStateInputs,
  type ClassStateResponse,
  type ClassStateRow,
  type ClassStateTurn,
  type ClassStateReaderDeps,
} from "../src/autopilot/class-state.ts";
import {
  PRODUCERLESS_SIGNALS,
  CLASS_TRIGGER_INPUTS,
  PRODUCERLESS_SUPPRESSORS,
} from "../src/autopilot/producerless-signals.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/constants.ts";
import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";
import type { DispatchClassRow } from "../src/taxonomy/classes.ts";
import { AUTOPILOT_SIGNAL_LAST_FIRED_KEY } from "../src/redis/autopilot-signals.ts";
import { recordTurn } from "../src/autopilot/runs.ts";
import type { AutopilotRunsDeps } from "../src/autopilot/runs.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1_750_000_000_000; // epoch 1750000000 — fixed clock.
const NOW_S = 1_750_000_000;

/** Synthetic taxonomy slice — every row the pure cases name. */
const TAXO: readonly DispatchClassRow[] = [
  {
    name: "dev_orch",
    kind: "pipeline",
    skill: "hydra-dev",
    costClass: "dev-orch",
    learningAgent: "executor",
    cooldownSeconds: null,
    scope: "orch",
    provenanceLabel: null,
  },
  {
    name: "research_target",
    kind: "pipeline",
    skill: "hydra-target-research",
    costClass: "research",
    learningAgent: null,
    cooldownSeconds: null,
    scope: "target",
    provenanceLabel: null,
  },
  {
    name: "sweep_orch",
    kind: "signal",
    skill: "hydra-sweep",
    costClass: "sweep",
    learningAgent: null,
    cooldownSeconds: 900,
    scope: "orch",
    provenanceLabel: null,
  },
  {
    name: "discover_target",
    kind: "signal",
    skill: "hydra-discover-target",
    costClass: "discover",
    learningAgent: null,
    cooldownSeconds: 1800,
    scope: "target",
    provenanceLabel: null,
  },
  {
    name: "skill_prune",
    kind: "signal",
    skill: "hydra-skill-prune",
    costClass: "sweep",
    learningAgent: null,
    cooldownSeconds: 604_800,
    scope: "orch",
    provenanceLabel: null,
  },
] as unknown as readonly DispatchClassRow[];

const row = (res: ClassStateResponse, name: string): ClassStateRow => {
  const found = res.classes.find((r) => r.name === name);
  assert.ok(found, `row ${name} present`);
  return found;
};

// The lifecycle fixture type is DERIVED from the composer's inputs type
// rather than imported from src/autopilot/run-lifecycle-state.ts: the
// test-file sprawl ratchet (issue #4134) attributes each test file to its
// rarest src import, and a type-only import still counts toward that
// module's popularity — importing it here re-attributed an unrelated
// now-page test onto a baselined subject.
type LifecycleLike = NonNullable<ClassStateInputs["lifecycle"]>;

const running = (runId: string): LifecycleLike =>
  ({ state: "running", run_id: runId, term_reason: null, ended_epoch: null }) as LifecycleLike;
const idle = (runId: string | null): LifecycleLike =>
  ({ state: "idle", run_id: runId, term_reason: null, ended_epoch: null }) as LifecycleLike;

function turn(n: number, epoch: number, extra: Partial<ClassStateTurn> = {}): ClassStateTurn {
  return { turn_n: n, epoch, ...extra };
}

/** The quiet baseline: one running run, one fresh turn, no Redis data. */
function baselineInputs(over: Partial<ClassStateInputs> = {}): ClassStateInputs {
  return {
    taxonomy: TAXO,
    lastFired: {},
    lifecycle: running("run-x"),
    runRow: {},
    turns: [turn(7, NOW_S - 60, { decisions: { sweep_orch: { outcome: "cooldown", reason: "431s left" } } })],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// INV-5/INV-6 — last-fired + cooldown math
// ---------------------------------------------------------------------------

describe("class-state cooldown math (INV-5/INV-6)", () => {
  test("never-fired signal class with a cooldown reads 0 remaining (fully cooled)", () => {
    const res = composeClassState(baselineInputs(), NOW_MS);
    const sweep = row(res, "sweep_orch");
    assert.equal(sweep.lastFiredEpoch, null);
    assert.equal(sweep.cooldownRemainingSeconds, 0);
  });

  test("in-window last-fired yields the exact remaining seconds", () => {
    const res = composeClassState(
      baselineInputs({ lastFired: { sweep_orch: NOW_S - 300 } }),
      NOW_MS,
    );
    // 900s cooldown, fired 300s ago → 600s left.
    assert.equal(row(res, "sweep_orch").cooldownRemainingSeconds, 600);
  });

  test("expired last-fired clamps at 0, never negative", () => {
    const res = composeClassState(
      baselineInputs({ lastFired: { sweep_orch: NOW_S - 5_000 } }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").cooldownRemainingSeconds, 0);
  });

  test("last-fired = max(hash, latest signals_snapshot) — the fresher source wins", () => {
    const hashOlder = NOW_S - 900;
    const snapNewer = NOW_S - 100;
    const withSnap = baselineInputs({
      lastFired: { sweep_orch: hashOlder },
      turns: [
        turn(9, NOW_S - 60, {
          decisions: { sweep_orch: { outcome: "cooldown", reason: "x" } },
          signals_snapshot: { sweep_orch: snapNewer },
        }),
      ],
    });
    const snapOlderHashNewer = baselineInputs({
      lastFired: { sweep_orch: NOW_S - 100 },
      turns: [
        turn(9, NOW_S - 60, {
          decisions: { sweep_orch: { outcome: "cooldown", reason: "x" } },
          signals_snapshot: { sweep_orch: NOW_S - 900 },
        }),
      ],
    });
    assert.equal(row(composeClassState(withSnap, NOW_MS), "sweep_orch").lastFiredEpoch, snapNewer);
    assert.equal(
      row(composeClassState(snapOlderHashNewer, NOW_MS), "sweep_orch").lastFiredEpoch,
      NOW_S - 100,
    );
  });

  test("Redis-failed hash degrades to the snapshot alone and names 'last-fired'", () => {
    const res = composeClassState(
      baselineInputs({
        lastFired: null,
        turns: [
          turn(9, NOW_S - 60, {
            decisions: {},
            signals_snapshot: { sweep_orch: NOW_S - 30 },
          }),
        ],
      }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").lastFiredEpoch, NOW_S - 30);
    assert.equal(row(res, "sweep_orch").cooldownRemainingSeconds, 900 - 30);
    assert.ok(res.header.degraded.includes("last-fired"));
  });

  test("pipeline rows (null cooldown) report null remaining even with a last-fired", () => {
    const res = composeClassState(
      baselineInputs({
        lastFired: { dev_orch: NOW_S - 10 },
        turns: [turn(9, NOW_S - 60, { decisions: { dev_orch: { outcome: "idle", reason: "no slot" } } })],
      }),
      NOW_MS,
    );
    const dev = row(res, "dev_orch");
    assert.equal(dev.lastFiredEpoch, NOW_S - 10);
    assert.equal(dev.cooldownRemainingSeconds, null);
  });
});

// ---------------------------------------------------------------------------
// INV-7 — verdict freshness
// ---------------------------------------------------------------------------

describe("class-state verdict freshness (INV-7)", () => {
  test("no active run → verdict null, freshness unknown, header unknown", () => {
    const res = composeClassState(
      baselineInputs({
        lifecycle: idle("run-x"),
        turns: [turn(7, NOW_S - 60, { decisions: { sweep_orch: { outcome: "cooldown", reason: "x" } } })],
      }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").verdict, null);
    assert.equal(row(res, "sweep_orch").verdictFreshness, "unknown");
    assert.equal(row(res, "sweep_orch").starved, null);
    assert.equal(res.header.verdictFreshness, "unknown");
    assert.equal(res.header.verdictAsOf, null);
    // header.run still reports the most-recent (terminal) run's markers.
    assert.equal(res.header.run?.lifecycle, "idle");
    // With no active run, usage/burnedClasses read null — never fabricated.
    assert.equal(res.header.usage, null);
    assert.equal(res.header.burnedClasses, null);
  });

  test("active run whose latest turn lacks decisions → unknown", () => {
    const res = composeClassState(baselineInputs({ turns: [turn(7, NOW_S - 60)] }), NOW_MS);
    assert.equal(row(res, "sweep_orch").verdictFreshness, "unknown");
    assert.equal(res.header.verdictFreshness, "unknown");
  });

  test("decisions within the budget → fresh verdict + verdictAsOf", () => {
    const res = composeClassState(baselineInputs(), NOW_MS);
    const sweep = row(res, "sweep_orch");
    assert.deepEqual(sweep.verdict, { outcome: "cooldown", reason: "431s left", turnN: 7 });
    assert.equal(sweep.verdictFreshness, "fresh");
    assert.equal(res.header.verdictFreshness, "fresh");
    assert.equal(res.header.verdictAsOf, new Date((NOW_S - 60) * 1000).toISOString());
  });

  test("the budget boundary is inclusive (exactly 900s old is still fresh)", () => {
    const res = composeClassState(
      baselineInputs({
        turns: [
          turn(7, NOW_S - VERDICT_FRESHNESS_BUDGET_SECONDS, {
            decisions: { sweep_orch: { outcome: "cooldown", reason: "x" } },
          }),
        ],
      }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").verdictFreshness, "fresh");
  });

  test("beyond the budget → stale, verdict retained", () => {
    const res = composeClassState(
      baselineInputs({
        turns: [
          turn(7, NOW_S - VERDICT_FRESHNESS_BUDGET_SECONDS - 1, {
            decisions: { sweep_orch: { outcome: "cooldown", reason: "old reason" } },
          }),
        ],
      }),
      NOW_MS,
    );
    const sweep = row(res, "sweep_orch");
    assert.equal(sweep.verdictFreshness, "stale");
    assert.deepEqual(sweep.verdict, { outcome: "cooldown", reason: "old reason", turnN: 7 });
    assert.equal(res.header.verdictFreshness, "stale");
  });

  test("class absent from a present decisions map → not-evaluated, verdict null", () => {
    const res = composeClassState(
      baselineInputs({ turns: [turn(7, NOW_S - 60, { decisions: { dev_orch: { outcome: "dispatched", reason: "w2" } } })] }),
      NOW_MS,
    );
    const sweep = row(res, "sweep_orch");
    assert.equal(sweep.verdict, null);
    assert.equal(sweep.verdictFreshness, "not-evaluated");
    // starved is a boolean here (not null) — decide.py simply did not
    // consider this class this turn.
    assert.equal(typeof sweep.starved, "boolean");
  });
});

// ---------------------------------------------------------------------------
// INV-8 — starvation streak
// ---------------------------------------------------------------------------

describe("class-state starvation streak (INV-8)", () => {
  const budgetTurn = (n: number, cls = "sweep_orch"): ClassStateTurn =>
    turn(n, NOW_S - n * 60, { decisions: { [cls]: { outcome: "budget", reason: "cap" } }, usage_allow: true });

  test("budget outcome for >= PROMOTION_THRESHOLD consecutive turns → starved", () => {
    assert.equal(PROMOTION_THRESHOLD, 3);
    const res = composeClassState(
      baselineInputs({ turns: [budgetTurn(7), budgetTurn(6), budgetTurn(5)] }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").starved, true);
  });

  test("PROMOTION_THRESHOLD - 1 consecutive turns → not starved", () => {
    const res = composeClassState(baselineInputs({ turns: [budgetTurn(7), budgetTurn(6)] }), NOW_MS);
    assert.equal(row(res, "sweep_orch").starved, false);
  });

  test("stagger outcomes count like budget", () => {
    const stagger = (n: number): ClassStateTurn =>
      turn(n, NOW_S - n * 60, { decisions: { sweep_orch: { outcome: "stagger", reason: "backfill" } } });
    const res = composeClassState(baselineInputs({ turns: [budgetTurn(7), stagger(6), stagger(5)] }), NOW_MS);
    assert.equal(row(res, "sweep_orch").starved, true);
  });

  test("a global-block turn (usage_allow false) is transparent — neither counts nor breaks", () => {
    const blocked = turn(6, NOW_S - 6 * 60, {
      decisions: { sweep_orch: { outcome: "idle", reason: "gate" } },
      usage_allow: false,
    });
    // Two budget turns + a blocked turn between: false proves the blocked
    // turn did not COUNT (a counting blocked turn would make the streak 3).
    const res = composeClassState(baselineInputs({ turns: [budgetTurn(7), blocked, budgetTurn(5)] }), NOW_MS);
    assert.equal(row(res, "sweep_orch").starved, false);
    // Three budget turns with the same blocked turn interleaved: true
    // proves it did not BREAK the walk either.
    const res2 = composeClassState(
      baselineInputs({ turns: [budgetTurn(8), blocked, budgetTurn(6), budgetTurn(5)] }),
      NOW_MS,
    );
    assert.equal(row(res2, "sweep_orch").starved, true);
  });

  test("a stale-plan turn (no decisions / empty map) is transparent too", () => {
    const noDecisions = turn(6, NOW_S - 6 * 60);
    const emptyMap = turn(5, NOW_S - 5 * 60, { decisions: {} });
    // Two budget turns with transparent turns interleaved → streak 2.
    const res = composeClassState(
      baselineInputs({ turns: [budgetTurn(7), noDecisions, emptyMap, budgetTurn(3)] }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").starved, false);
    // Three budget turns with the same transparent turns interleaved → 3.
    const res2 = composeClassState(
      baselineInputs({ turns: [budgetTurn(8), noDecisions, emptyMap, budgetTurn(6), budgetTurn(4)] }),
      NOW_MS,
    );
    assert.equal(row(res2, "sweep_orch").starved, true);
  });

  test("any other outcome breaks the walk — older budget turns do not count", () => {
    const dispatched = turn(6, NOW_S - 6 * 60, {
      decisions: { sweep_orch: { outcome: "dispatched", reason: "w1" } },
    });
    const res = composeClassState(
      baselineInputs({ turns: [budgetTurn(7), dispatched, budgetTurn(5)] }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").starved, false);
  });

  test("the class absent from a turn's decisions breaks the walk", () => {
    const other = turn(6, NOW_S - 6 * 60, {
      decisions: { dev_orch: { outcome: "dispatched", reason: "w2" } },
    });
    const res = composeClassState(
      baselineInputs({ turns: [budgetTurn(7), other, budgetTurn(5)] }),
      NOW_MS,
    );
    assert.equal(row(res, "sweep_orch").starved, false);
  });

  test("the walk is bounded at STARVED_LOOKBACK_TURNS", () => {
    assert.equal(typeof STARVED_LOOKBACK_TURNS, "number");
    assert.ok(STARVED_LOOKBACK_TURNS >= 10);
    // 60 budget turns — the streak saturates long before the cap, which is
    // the point: the bound bounds the read, never the verdict.
    const many = Array.from({ length: 60 }, (_, i) => budgetTurn(60 - i));
    const res = composeClassState(baselineInputs({ turns: many }), NOW_MS);
    assert.equal(row(res, "sweep_orch").starved, true);
  });
});

// ---------------------------------------------------------------------------
// INV-9 — static dead derivation
// ---------------------------------------------------------------------------

describe("class-state dead derivation (INV-9)", () => {
  test("discover_target is ALIVE — its trigger is the produced target_backfill_idle (#4607)", () => {
    // #4607 rewired the selector off the producerless `target_idle` onto the
    // produced `target_backfill_idle`, so deadClassification flips to alive.
    // REMOVAL-ORDERING (CLAUDE.md): this case asserted `dead: true` on the
    // dead derivation and was flipped before the rewire landed.
    const res = composeClassState(baselineInputs(), NOW_MS);
    const dead = row(res, "discover_target");
    assert.equal(dead.dead, false);
    assert.equal("deadReason" in dead, false);
  });

  test("research_target stays alive — one trigger is produced", () => {
    const res = composeClassState(baselineInputs(), NOW_MS);
    const rt = row(res, "research_target");
    assert.equal(rt.dead, false);
    assert.equal("deadReason" in rt, false);
  });

  test("skill_prune stays alive — its producerless read is a suppressor, not a trigger", () => {
    const res = composeClassState(baselineInputs(), NOW_MS);
    assert.equal(row(res, "skill_prune").dead, false);
  });
});

// ---------------------------------------------------------------------------
// INV-11 + INV-12 — slot occupant + envelope/header
// ---------------------------------------------------------------------------

describe("class-state envelope + header (INV-11/INV-12)", () => {
  test("pipeline rows carry slotOccupant verbatim under a non-unknown freshness; signal rows never", () => {
    const res = composeClassState(
      baselineInputs({
        turns: [
          turn(7, NOW_S - 60, {
            decisions: { sweep_orch: { outcome: "cooldown", reason: "x" } },
            slots_snapshot: { dev_orch: "task-abc", research_target: null },
          }),
        ],
      }),
      NOW_MS,
    );
    assert.equal(row(res, "dev_orch").slotOccupant, "task-abc");
    assert.equal(row(res, "research_target").slotOccupant, null);
    assert.equal("slotOccupant" in row(res, "sweep_orch"), false);
  });

  test("slotOccupant is omitted entirely when freshness is unknown", () => {
    const res = composeClassState(
      baselineInputs({
        lifecycle: idle(null),
        turns: [turn(7, NOW_S - 60, { slots_snapshot: { dev_orch: "task-abc" } })],
      }),
      NOW_MS,
    );
    assert.equal("slotOccupant" in row(res, "dev_orch"), false);
  });

  test("scope + quotaDeltaCap parse from the run hash's limits JSON", () => {
    const res = composeClassState(
      baselineInputs({
        runRow: {
          limits: JSON.stringify({ scope: "orch-only", quota_5h_max_pts: 15, quota_week_max_pts: 900 }),
        },
      }),
      NOW_MS,
    );
    assert.equal(res.header.scope, "orch-only");
    assert.deepEqual(res.header.quotaDeltaCap, { fiveHourMaxPts: 15, weekMaxPts: 900 });
  });

  test("unparseable limits JSON degrades scope/quota to null and names 'run-row'", () => {
    const res = composeClassState(baselineInputs({ runRow: { limits: "{not-json" } }), NOW_MS);
    assert.equal(res.header.scope, null);
    assert.equal(res.header.quotaDeltaCap, null);
    assert.ok(res.header.degraded.includes("run-row"));
  });

  test("usage + burnedClasses come from the latest turn when active", () => {
    const res = composeClassState(
      baselineInputs({
        turns: [
          turn(7, NOW_S - 60, {
            decisions: {},
            burned_classes: ["sweep_orch", "cleanup_orch"],
            usage_shed: ["architecture_orch"],
            usage_allow: false,
          }),
        ],
      }),
      NOW_MS,
    );
    assert.deepEqual(res.header.usage, { allow: false, shed: ["architecture_orch"] });
    assert.deepEqual(res.header.burnedClasses, ["sweep_orch", "cleanup_orch"]);
  });

  test("absent usage fields fail-open (allow true, shed []) and absent burned reads null", () => {
    const res = composeClassState(baselineInputs({ turns: [turn(7, NOW_S - 60, { decisions: {} })] }), NOW_MS);
    assert.deepEqual(res.header.usage, { allow: true, shed: [] });
    assert.equal(res.header.burnedClasses, null);
  });

  test("header.run carries the run identity + latest turn markers", () => {
    const res = composeClassState(baselineInputs(), NOW_MS);
    assert.deepEqual(res.header.run, {
      runId: "run-x",
      lifecycle: "running",
      latestTurnN: 7,
      latestTurnEpoch: NOW_S - 60,
    });
  });

  test("generatedAt is the ISO instant of the injected now; scanned == classes.length", () => {
    const res = composeClassState(baselineInputs(), NOW_MS);
    assert.equal(res.generatedAt, new Date(NOW_MS).toISOString());
    assert.equal(res.scanned, res.classes.length);
    assert.equal(res.scanned, TAXO.length);
  });
});

// ---------------------------------------------------------------------------
// INV-12 — the real alphabet, in file order
// ---------------------------------------------------------------------------

describe("class-state taxonomy parity (INV-12)", () => {
  test("classes are EXACTLY DISPATCH_CLASSES, in file order", () => {
    const res = composeClassState(
      {
        taxonomy: DISPATCH_CLASSES,
        lastFired: {},
        lifecycle: idle(null),
        runRow: null,
        turns: [],
      },
      NOW_MS,
    );
    assert.deepEqual(
      res.classes.map((r) => r.name),
      DISPATCH_CLASSES.map((r) => r.name),
    );
    assert.equal(res.scanned, DISPATCH_CLASSES.length);
    // discover_target is alive in the REAL alphabet too — #4607 rewired its
    // trigger onto the produced target_backfill_idle (INV-9's "today" was
    // `dead: true` before the rewire).
    const dt = res.classes.find((r) => r.name === "discover_target");
    assert.ok(dt);
    assert.equal(dt.dead, false);
  });
});

// ---------------------------------------------------------------------------
// INV-13 — reader degradation with injectable deps
// ---------------------------------------------------------------------------

describe("class-state readClassState degradation (INV-13)", () => {
  const okLifecycle = async () => ({ ok: true as const, lifecycle: running("run-x") });

  function fakeDeps(over: Partial<ClassStateReaderDeps> = {}): ClassStateReaderDeps {
    return {
      getSignalLastFired: async () => ({ ok: true, lastFired: {} }),
      getCurrentLifecycle: okLifecycle,
      getRunRow: async () => ({ ok: false, code: "not-found", detail: "" }) as never,
      listTurnsDesc: async () => [],
      now: () => NOW_MS,
      ...over,
    };
  }

  test("every source failing still composes a full envelope, never throws", async () => {
    const res = await readClassState(
      fakeDeps({
        getSignalLastFired: async () => ({ ok: false, error: "redis down" }),
        getCurrentLifecycle: async () => ({ ok: false, code: "redis-error" } as never),
      }),
    );
    assert.equal(res.classes.length, DISPATCH_CLASSES.length);
    assert.equal(res.header.run, null);
    assert.equal(res.header.verdictFreshness, "unknown");
    assert.ok(res.header.degraded.includes("last-fired"));
    assert.ok(res.header.degraded.includes("lifecycle"));
    // Cooldowns still compute (0 for never-fired signal classes) — the
    // static rows degrade to their static truth, not to absence.
    assert.equal(typeof res.classes[0].name, "string");
  });

  test("a throwing dep degrades to 'lifecycle', not a 500", async () => {
    const res = await readClassState(
      fakeDeps({
        getCurrentLifecycle: async () => {
          throw new Error("boom");
        },
      }),
    );
    assert.ok(res.header.degraded.includes("lifecycle"));
  });

  test("run-row + turns failures are named when a run exists", async () => {
    const res = await readClassState(
      fakeDeps({
        getRunRow: async () => ({ ok: false, code: "redis-error" } as never),
        listTurnsDesc: async () => {
          throw new Error("zrevrange failed");
        },
      }),
    );
    assert.ok(res.header.degraded.includes("run-row"));
    assert.ok(res.header.degraded.includes("turns"));
    assert.equal(res.header.run?.runId, "run-x");
  });

  test("unparseable turn members are skipped; parseable ones feed the composition", async () => {
    const res = await readClassState(
      fakeDeps({
        listTurnsDesc: async () => [
          JSON.stringify({
            turn_n: 9,
            epoch: NOW_S - 60,
            decisions: { sweep_orch: { outcome: "budget", reason: "cap" } },
          }),
          "not-json-at-all",
          JSON.stringify(["an", "array"]),
          JSON.stringify({ epoch: NOW_S }), // missing turn_n
        ],
      }),
    );
    const sweep = res.classes.find((r) => r.name === "sweep_orch");
    assert.ok(sweep);
    assert.deepEqual(sweep.verdict, { outcome: "budget", reason: "cap", turnN: 9 });
  });

  test("deps.now drives generatedAt deterministically", async () => {
    const res = await readClassState(fakeDeps());
    assert.equal(res.generatedAt, new Date(NOW_MS).toISOString());
  });
});

// ---------------------------------------------------------------------------
// INV-10 — drift pins
// ---------------------------------------------------------------------------

describe("class-state drift pins (INV-10)", () => {
  const decideSrc = readFileSync(new URL("../scripts/autopilot/decide.py", import.meta.url), "utf8");
  const reapSrc = readFileSync(new URL("../scripts/autopilot/reap_state.py", import.meta.url), "utf8");

  test("every PRODUCERLESS_SIGNALS key is classified as a trigger input or a suppressor", () => {
    const classified = new Set<string>([...PRODUCERLESS_SUPPRESSORS]);
    for (const list of Object.values(CLASS_TRIGGER_INPUTS)) {
      for (const sig of list) classified.add(sig);
    }
    for (const key of PRODUCERLESS_SIGNALS.keys()) {
      assert.ok(
        classified.has(key),
        `PRODUCERLESS_SIGNALS key '${key}' is in neither CLASS_TRIGGER_INPUTS nor PRODUCERLESS_SUPPRESSORS — classify it (issue #4635 INV-10a)`,
      );
    }
  });

  test("every CLASS_TRIGGER_INPUTS literal is a real _signal_present read in decide.py", () => {
    for (const [cls, triggers] of Object.entries(CLASS_TRIGGER_INPUTS)) {
      for (const sig of triggers) {
        assert.ok(
          decideSrc.includes(`_signal_present(state, events, "${sig}")`),
          `CLASS_TRIGGER_INPUTS['${cls}'] lists '${sig}' but decide.py never reads it via _signal_present(state, events, ...) — the trigger transcription drifted (issue #4635 INV-10b)`,
        );
      }
    }
  });

  test("every CLASS_TRIGGER_INPUTS key is a DISPATCH_CLASSES name", () => {
    const names = new Set(DISPATCH_CLASSES.map((r) => r.name));
    for (const cls of Object.keys(CLASS_TRIGGER_INPUTS)) {
      assert.ok(
        names.has(cls),
        `CLASS_TRIGGER_INPUTS key '${cls}' is not a classes.json class (issue #4635 INV-10c)`,
      );
    }
  });

  test("the last-fired key literal matches reap_state.py's writer (INV-4)", () => {
    assert.equal(AUTOPILOT_SIGNAL_LAST_FIRED_KEY, "hydra:autopilot:signal-last-fired");
    assert.ok(
      reapSrc.includes('REDIS_SIGNAL_LAST_FIRED_KEY = "hydra:autopilot:signal-last-fired"'),
      "reap_state.py's REDIS_SIGNAL_LAST_FIRED_KEY literal drifted from src/redis/autopilot-signals.ts — the reader would read a hash nothing writes (issue #4635 INV-4)",
    );
  });
});

// ---------------------------------------------------------------------------
// INV-2/INV-3 — recordTurn persistence + sanitisation (injected runs facade)
// ---------------------------------------------------------------------------

describe("recordTurn persists + sanitises the observability fields (INV-2/INV-3)", () => {
  interface CapturedTurn {
    runId: string;
    turnN: number;
    member: string;
  }

  let captured: CapturedTurn[];

  beforeEach(() => {
    captured = [];
  });

  function makeRunsDeps(): AutopilotRunsDeps {
    return {
      runs: {
        getAutopilotRun: async () => ({ started: String(NOW_S - 100) }),
        initAutopilotRun: async () => {},
        updateAutopilotRunFields: async () => {},
        setAutopilotRunField: async () => {},
        incrAutopilotRunField: async () => {},
        refreshAutopilotRunTTL: async () => {},
        addAutopilotRunToIndex: async () => {},
        addAutopilotRunTurn: async (runId, turnN, member) => {
          captured.push({ runId, turnN, member });
        },
        hasAutopilotRunTurnAt: async () => false,
      },
      isPidAlive: () => true,
      now: () => NOW_MS,
      stampWorklessHint: async () => null,
    };
  }

  const baseBody = {
    run_id: "run-x",
    turn_n: 7,
    actions: [{ type: "dispatch" }],
    reasons: ["work available"],
  };

  test("sanitised fields persist under snake_case keys alongside the existing shape", async () => {
    const r = await recordTurn(
      {
        ...baseBody,
        decisions: {
          sweep_orch: { outcome: "cooldown", reason: "431s left" },
          "bad-class": { outcome: 42, reason: "not strings" },
        },
        burned_classes: ["sweep_orch", 7, null],
        usage_shed: ["architecture_orch"],
        usage_allow: false,
      } as never,
      makeRunsDeps(),
    );
    assert.equal(r.ok, true);
    assert.equal(captured.length, 1);
    const member = JSON.parse(captured[0].member) as Record<string, unknown>;
    // INV-3: the new keys appear only when present, after the existing ones.
    assert.deepEqual(member.decisions, { sweep_orch: { outcome: "cooldown", reason: "431s left" } });
    assert.deepEqual(member.burned_classes, ["sweep_orch"]);
    assert.deepEqual(member.usage_shed, ["architecture_orch"]);
    assert.equal(member.usage_allow, false);
    // The pre-existing keys are unchanged.
    assert.equal(member.turn_n, 7);
    assert.equal(member.epoch, NOW_S);
    assert.deepEqual(member.actions, [{ type: "dispatch" }]);
    assert.deepEqual(member.reasons, ["work available"]);
    assert.deepEqual(member.slots_snapshot, {});
    assert.deepEqual(member.signals_snapshot, {});
  });

  test("absent fields stay ABSENT — never {} / [] / true placeholders", async () => {
    await recordTurn({ ...baseBody } as never, makeRunsDeps());
    const member = JSON.parse(captured[0].member) as Record<string, unknown>;
    assert.equal("decisions" in member, false);
    assert.equal("burned_classes" in member, false);
    assert.equal("usage_shed" in member, false);
    assert.equal("usage_allow" in member, false);
  });

  test("non-object decisions and non-boolean usage_allow are dropped wholesale", async () => {
    await recordTurn(
      {
        ...baseBody,
        decisions: "nope",
        usage_allow: "yes",
      } as never,
      makeRunsDeps(),
    );
    const member = JSON.parse(captured[0].member) as Record<string, unknown>;
    assert.equal("decisions" in member, false);
    assert.equal("usage_allow" in member, false);
  });
});
