/**
 * Cycle-metrics anchorType heal leaf (issue #3627).
 *
 * #3627 extracted the enrichment-path anchorType HEAL (`isSentinelAnchorType` +
 * `healSentinelAnchorType`) out of the `cycle-close.ts` coordinator into a
 * focused I/O leaf, modelled on the `outcome-record.ts` extraction (#3323). The
 * behaviour through `recordCycle` is already pinned end-to-end against real Redis
 * by `cycle-close-anchor-type-heal-3604.test.mts`; this sibling suite pins the
 * EXTRACTED seam directly — the whole point of the extraction is that the leaf is
 * now importable and testable with an in-memory fake facade, no Redis and no full
 * `CycleCloseDeps` bag.
 *
 * Pure `node:test` with a hand-rolled fake `CycleMetricsHealFacade` — no Redis,
 * no shared connection, so this is a standalone top-level suite with no teardown
 * lifecycle to leak into sibling suites.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isSentinelAnchorType,
  healSentinelAnchorType,
  type CycleMetricsHealFacade,
} from "../src/autopilot/cycle-metrics-heal.ts";

/**
 * A minimal in-memory metrics facade: `getCycleMetrics` returns a seeded stored
 * hash; `recordCycleMetrics` records the writes so a test can assert what the
 * heal wrote. `omitReader:true` drops `getCycleMetrics` to exercise the
 * optional-reader degradation path.
 */
function fakeFacade(
  stored: Record<string, string>,
  opts: { omitReader?: boolean } = {},
): { facade: CycleMetricsHealFacade; writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  const facade: CycleMetricsHealFacade = {
    async recordCycleMetrics(_cycleId, metrics) {
      writes.push(metrics as Record<string, unknown>);
    },
  };
  if (!opts.omitReader) {
    facade.getCycleMetrics = async () => stored;
  }
  return { facade, writes };
}

describe("isSentinelAnchorType (issue #3627 extraction)", () => {
  test("every sentinel/absent form is a sentinel", () => {
    for (const v of ["", "   ", "unclassified", "UNKNOWN", "null", "undefined", undefined]) {
      assert.equal(isSentinelAnchorType(v), true, `expected sentinel for ${JSON.stringify(v)}`);
    }
  });

  test("a genuine class is NOT a sentinel", () => {
    for (const v of ["work-queue", "qa-review", "grill", "discover"]) {
      assert.equal(isSentinelAnchorType(v), false, `expected non-sentinel for ${v}`);
    }
  });
});

describe("healSentinelAnchorType (issue #3627 extraction)", () => {
  test("heals a stored sentinel to the class decoded from a fenced worktreeBranch", async () => {
    const { facade, writes } = fakeFacade({ anchorType: "unclassified" });
    const healed = await healSentinelAnchorType(
      "4a2fc33e-9478-49dc-88cd-69dd393787dd",
      { cycleId: "x", worktreeBranch: "worktree-agent-4a2fc33e-t2-dev_orch-3600" } as any,
      facade,
    );
    assert.equal(healed, true);
    assert.deepEqual(writes, [{ anchorType: "work-queue" }]);
  });

  test("heals a stored sentinel to an explicit forwarded anchorType", async () => {
    const { facade, writes } = fakeFacade({ anchorType: "unknown" });
    const healed = await healSentinelAnchorType(
      "5959d1f2-a804-4a2b-ab11-2b40d0b3a026",
      { cycleId: "x", anchorType: "grill" } as any,
      facade,
    );
    assert.equal(healed, true);
    assert.deepEqual(writes, [{ anchorType: "grill" }]);
  });

  test("NEVER-GUESS: an undecodable follow-up over a sentinel writes nothing", async () => {
    const { facade, writes } = fakeFacade({ anchorType: "unclassified" });
    const healed = await healSentinelAnchorType(
      "afa22ef1-7e11-41e6-a78f-c725b46c7870",
      { cycleId: "x", worktreeBranch: "worktree-agent-ab91ac60dc99081cd" } as any,
      facade,
    );
    assert.equal(healed, false);
    assert.deepEqual(writes, []);
  });

  test("NEVER-DOWNGRADE: a genuine stored class is left untouched", async () => {
    const { facade, writes } = fakeFacade({ anchorType: "work-queue" });
    const healed = await healSentinelAnchorType(
      "worktree-agent-3604aaaa-t1-dev_orch",
      { cycleId: "x", worktreeBranch: "worktree-agent-ab91ac60dc99081cd" } as any,
      facade,
    );
    assert.equal(healed, false);
    assert.deepEqual(writes, []);
  });

  test("optional-reader degradation: a facade without getCycleMetrics skips the heal", async () => {
    const { facade, writes } = fakeFacade({ anchorType: "unclassified" }, { omitReader: true });
    const healed = await healSentinelAnchorType(
      "worktree-agent-3604cccc-t1-dev_orch",
      { cycleId: "x", anchorType: "grill" } as any,
      facade,
    );
    assert.equal(healed, false);
    assert.deepEqual(writes, []);
  });

  test("best-effort: a throwing reader is swallowed and returns false", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const facade: CycleMetricsHealFacade = {
      async recordCycleMetrics(_c, m) {
        writes.push(m as Record<string, unknown>);
      },
      async getCycleMetrics() {
        throw new Error("boom");
      },
    };
    const healed = await healSentinelAnchorType(
      "some-cycle",
      { cycleId: "x", anchorType: "grill" } as any,
      facade,
    );
    assert.equal(healed, false);
    assert.deepEqual(writes, []);
  });
});
