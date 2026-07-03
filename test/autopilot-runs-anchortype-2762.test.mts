/**
 * Issue #2762 — anchorType inference from worktree-branch cycleId.
 *
 * holdback-merge-watch.ts calls recordCycle({cycleId, prNumber, filesChanged})
 * WITHOUT an anchorType. Its cycleId is the autopilot-synthesised worktreeBranch
 * (`worktree-agent-{8hex}-t{N}-{slot}`), whose slot suffix encodes the dispatch
 * class. classifyAnchorType now decodes it to recover the anchorType without
 * requiring the caller to forward the field.
 *
 * This file exercises that inference path in isolation — no Redis, no clock.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { AutopilotRunsDeps } from "../src/autopilot/runs.ts";
// recordCycle + UNCLASSIFIED_ANCHOR_TYPE + the CycleCloseDeps bag moved to the
// sibling cycle-close Module (#2768). The fixture builds a single object
// satisfying both deps bags so it is passed to recordCycle unchanged.
import {
  recordCycle,
  UNCLASSIFIED_ANCHOR_TYPE,
  type CycleCloseDeps,
} from "../src/autopilot/cycle-close.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory deps fixture (same shape as autopilot-runs-deps.test.mts,
// but scoped to only the stores this suite exercises).
// ---------------------------------------------------------------------------

interface MemStore {
  runs: Map<string, Record<string, string>>;
  runIndex: Map<string, number>;
  runTurns: Map<string, Set<number>>;
  cycles: Map<string, Record<string, string>>;
  cycleIndex: Map<string, number>;
  metrics: Map<string, Record<string, string>>;
  counters: Record<string, number>;
}

function newStore(): MemStore {
  return {
    runs: new Map(),
    runIndex: new Map(),
    runTurns: new Map(),
    cycles: new Map(),
    cycleIndex: new Map(),
    metrics: new Map(),
    counters: { run: 0, merged: 0, failed: 0, unaccounted: 0 },
  };
}

const FIXED_NOW_MS = 1_750_000_000_000;

function makeDeps(store: MemStore): AutopilotRunsDeps & CycleCloseDeps {
  return {
    runs: {
      async getAutopilotRun(runId) {
        return { ...(store.runs.get(runId) ?? {}) };
      },
      async initAutopilotRun(runId, fields) {
        store.runs.set(runId, { ...fields });
      },
      async updateAutopilotRunFields(runId, fields) {
        const existing = store.runs.get(runId) ?? {};
        store.runs.set(runId, { ...existing, ...fields });
      },
      async setAutopilotRunField(runId, field, value) {
        const existing = store.runs.get(runId) ?? {};
        existing[field] = value;
        store.runs.set(runId, existing);
      },
      async incrAutopilotRunField(runId, field, by) {
        const existing = store.runs.get(runId) ?? {};
        existing[field] = String(Number(existing[field] || "0") + by);
        store.runs.set(runId, existing);
      },
      async refreshAutopilotRunTTL() {
        /* no-op */
      },
      async addAutopilotRunToIndex(runId, scoreEpochSeconds) {
        store.runIndex.set(runId, scoreEpochSeconds);
      },
      async addAutopilotRunTurn(runId, turnN) {
        const set = store.runTurns.get(runId) ?? new Set<number>();
        set.add(turnN);
        store.runTurns.set(runId, set);
      },
      async hasAutopilotRunTurnAt(runId, turnN) {
        return store.runTurns.get(runId)?.has(turnN) ?? false;
      },
    },
    cycle: {
      async getCycleHash(cycleId) {
        return { ...(store.cycles.get(cycleId) ?? {}) };
      },
      async initCycleHash(cycleId, fields) {
        store.cycles.set(cycleId, { ...fields });
      },
      async addCycleToIndex(cycleId, score) {
        store.cycleIndex.set(cycleId, score);
      },
    },
    scheduler: {
      async incrSchedulerCyclesRun() {
        return ++store.counters.run;
      },
      async incrSchedulerCyclesMerged() {
        return ++store.counters.merged;
      },
      async incrSchedulerCyclesFailed() {
        return ++store.counters.failed;
      },
      async incrSchedulerCyclesUnaccounted() {
        return ++store.counters.unaccounted;
      },
    },
    metrics: {
      async recordCycleMetrics(cycleId, metrics) {
        const existing = store.metrics.get(cycleId) ?? {};
        for (const [k, v] of Object.entries(metrics)) {
          if (v === undefined) continue;
          existing[k] =
            typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
        }
        store.metrics.set(cycleId, existing);
      },
    },
    isPidAlive: () => true,
    now: () => FIXED_NOW_MS,
  };
}

// ---------------------------------------------------------------------------
// Regression tests for #2762
// ---------------------------------------------------------------------------

describe("recordCycle — worktreeBranch cycleId anchorType inference (#2762)", () => {
  test("infers work-queue from a dev_orch worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    // No anchorType supplied — caller is holdback-merge-watch.ts, which uses the
    // synthesised worktreeBranch as cycleId and does not forward anchorType.
    await recordCycle(
      { cycleId: "worktree-agent-568fde2a-t9-dev_orch", status: "completed" } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-568fde2a-t9-dev_orch")!.anchorType,
      "work-queue",
    );
  });

  test("infers work-queue from a dev_target worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "worktree-agent-abc12345-t3-dev_target", status: "completed" } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-abc12345-t3-dev_target")!.anchorType,
      "work-queue",
    );
  });

  test("infers qa-review from a qa_orch worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "worktree-agent-deadbeef-t12-qa_orch", status: "completed" } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-deadbeef-t12-qa_orch")!.anchorType,
      "qa-review",
    );
  });

  test("infers qa-review from a qa_target worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "worktree-agent-cafe1234-t5-qa_target", status: "completed" } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-cafe1234-t5-qa_target")!.anchorType,
      "qa-review",
    );
  });

  test("infers grill from a design_concept_orch worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      {
        cycleId: "worktree-agent-11223344-t2-design_concept_orch",
        status: "completed",
      } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-11223344-t2-design_concept_orch")!.anchorType,
      "grill",
    );
  });

  test("infers research from a research_orch worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "worktree-agent-aabbccdd-t7-research_orch", status: "completed" } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-aabbccdd-t7-research_orch")!.anchorType,
      "research",
    );
  });

  test("infers work-queue from a `local` run-token cycleId (run_id-absent fallback)", async () => {
    // _synthesize_worktree_branch (decide.py) emits the literal `local` as the
    // run token when state.run_id is absent (legacy/test callers), so the
    // run-token segment is not always hex. The regex must still decode the slot.
    const store = newStore();
    const deps = makeDeps(store);
    await recordCycle(
      { cycleId: "worktree-agent-local-t2-dev_orch", status: "completed" } as any,
      deps,
    );
    assert.equal(
      store.metrics.get("worktree-agent-local-t2-dev_orch")!.anchorType,
      "work-queue",
    );
  });

  test("does NOT infer from a harness worktree-agent branch with no -tN- slot suffix", async () => {
    // The Claude harness creates `worktree-agent-<longhash>` branches with no
    // turn/slot suffix — those carry no slot and must NOT be mis-decoded; they
    // fall through to the unclassified sentinel + warn.
    const store = newStore();
    const deps = makeDeps(store);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await recordCycle(
        { cycleId: "worktree-agent-ab3a8b01c3f11f366", status: "completed" } as any,
        deps,
      );
    } finally {
      console.warn = orig;
    }
    assert.equal(
      store.metrics.get("worktree-agent-ab3a8b01c3f11f366")!.anchorType,
      UNCLASSIFIED_ANCHOR_TYPE,
    );
    assert.equal(warnings.length, 1, "warns for a slot-less harness branch");
  });

  test("does NOT emit a console.warn when anchorType is inferred from the cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await recordCycle(
        { cycleId: "worktree-agent-568fde2a-t9-dev_orch", status: "completed" } as any,
        deps,
      );
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 0, "no warn when anchorType can be inferred from cycleId");
  });

  test("still falls back to unclassified for an unknown slot suffix in worktree-branch cycleId", async () => {
    const store = newStore();
    const deps = makeDeps(store);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await recordCycle(
        {
          cycleId: "worktree-agent-aabbccdd-t1-unknown_class",
          status: "completed",
        } as any,
        deps,
      );
    } finally {
      console.warn = orig;
    }
    assert.equal(
      store.metrics.get("worktree-agent-aabbccdd-t1-unknown_class")!.anchorType,
      UNCLASSIFIED_ANCHOR_TYPE,
    );
    assert.equal(warnings.length, 1, "still warns for unknown slot");
  });
});
