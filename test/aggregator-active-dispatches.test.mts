/**
 * Regression tests for the active-dispatches aggregator (issue #618).
 *
 * Pure-aggregator-style: every external touchpoint stubbed via `deps`.
 * Pure helpers (`mergeDispatches`, `projectAutopilotRow`,
 * `projectOperatorRow`) are tested directly; the integration shape is
 * tested with stubs that return canned rows.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getActiveDispatches,
  mergeDispatches,
  projectAutopilotRow,
  projectOperatorRow,
  type Dispatch,
} from "../src/aggregators/active-dispatches.ts";

describe("projectOperatorRow — pure helper", () => {
  test("copies every present field; marks source=operator", () => {
    const got = projectOperatorRow({
      id: "x1",
      classLabel: "hydra-grill",
      startedAt: "2026-05-26T10:00:00Z",
      currentStep: "step",
      issueRef: "#618",
      prRef: "#624",
    });
    assert.equal(got.source, "operator");
    assert.equal(got.id, "x1");
    assert.equal(got.classLabel, "hydra-grill");
    assert.equal(got.startedAt, "2026-05-26T10:00:00Z");
    assert.equal(got.currentStep, "step");
    assert.equal(got.issueRef, "#618");
    assert.equal(got.prRef, "#624");
  });

  test("omits undefined optional fields", () => {
    const got = projectOperatorRow({
      id: "x2",
      classLabel: "hydra-review",
      startedAt: "2026-05-26T10:00:00Z",
    });
    assert.equal(got.currentStep, undefined);
    assert.equal(got.issueRef, undefined);
    assert.equal(got.prRef, undefined);
  });
});

describe("projectAutopilotRow — pure helper", () => {
  test("happy path uses `started` ISO field", () => {
    const got = projectAutopilotRow({
      run_id: "ap-1",
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      trigger: "scheduled",
      status: "running",
    });
    assert.ok(got, "projection should not be null");
    assert.equal(got!.id, "ap-1");
    assert.equal(got!.source, "autopilot");
    assert.equal(got!.classLabel, "autopilot (scheduled)");
    assert.equal(got!.startedAt, "2026-05-26T11:00:00Z");
  });

  test("synthesises startedAt from started_epoch when started is missing", () => {
    const got = projectAutopilotRow({
      run_id: "ap-2",
      started_epoch: "1779796800",
      trigger: "manual",
      status: "running",
    });
    assert.ok(got);
    // 1779796800 → 2026-05-26T12:00:00.000Z
    assert.equal(got!.startedAt, "2026-05-26T12:00:00.000Z");
  });

  test("returns null when both run_id and id are missing", () => {
    const got = projectAutopilotRow({ started: "2026-05-26T10:00:00Z", status: "running" });
    assert.equal(got, null);
  });

  test("returns null when no usable startedAt is present", () => {
    const got = projectAutopilotRow({ run_id: "ap-3", status: "running" });
    assert.equal(got, null);
  });

  test("falls back to a bare 'autopilot' label when trigger is absent", () => {
    const got = projectAutopilotRow({
      run_id: "ap-4",
      started: "2026-05-26T10:00:00Z",
      status: "running",
    });
    assert.equal(got!.classLabel, "autopilot");
  });
});

describe("mergeDispatches — pure helper", () => {
  test("dedupes by id, first occurrence wins", () => {
    const items: Dispatch[] = [
      { id: "a", classLabel: "autopilot", source: "autopilot", startedAt: "2026-05-26T11:00:00Z" },
      { id: "a", classLabel: "operator-shadow", source: "operator", startedAt: "2026-05-26T12:00:00Z" },
    ];
    const merged = mergeDispatches(items);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].classLabel, "autopilot");
  });

  test("sorts by startedAt descending", () => {
    const items: Dispatch[] = [
      { id: "old", classLabel: "x", source: "operator", startedAt: "2026-05-26T01:00:00Z" },
      { id: "new", classLabel: "x", source: "operator", startedAt: "2026-05-26T11:00:00Z" },
      { id: "mid", classLabel: "x", source: "operator", startedAt: "2026-05-26T05:00:00Z" },
    ];
    const merged = mergeDispatches(items);
    assert.deepEqual(merged.map((i) => i.id), ["new", "mid", "old"]);
  });

  test("returns [] for empty input", () => {
    assert.deepEqual(mergeDispatches([]), []);
  });
});

// ---------------------------------------------------------------------------
// getActiveDispatches — happy path + mixed scenarios + isolation
// ---------------------------------------------------------------------------

describe("getActiveDispatches — autopilot-only", () => {
  test("returns just autopilot rows when no operator dispatches present", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => ["ap-1"],
      getAutopilotRunRow: async () => ({
        run_id: "ap-1",
        started: "2026-05-26T11:00:00Z",
        started_epoch: "1779836400",
        trigger: "scheduled",
        status: "running",
      }),
      listOperatorDispatches: async () => [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "autopilot");
    assert.equal(items[0].classLabel, "autopilot (scheduled)");
  });

  test("filters out autopilot rows whose status is not running", async () => {
    const rows: Record<string, Record<string, string>> = {
      "ap-running": {
        run_id: "ap-running",
        started: "2026-05-26T11:00:00Z",
        trigger: "manual",
        status: "running",
      },
      "ap-ended": {
        run_id: "ap-ended",
        started: "2026-05-26T10:00:00Z",
        trigger: "manual",
        status: "ended",
      },
      "ap-killed": {
        run_id: "ap-killed",
        started: "2026-05-26T09:00:00Z",
        trigger: "manual",
        status: "killed",
      },
    };
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => Object.keys(rows),
      getAutopilotRunRow: async (id) => rows[id],
      listOperatorDispatches: async () => [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "ap-running");
  });
});

describe("getActiveDispatches — autopilot liveness (#888)", () => {
  // A no-op sweep that mirrors the live pid probe: a running row whose pid
  // is alive comes back unchanged; a dead pid gets promoted to killed/crash.
  // Tests stub this directly so we never touch a real process.
  const sweepByPidAlive =
    (alivePids: Set<number>) =>
    async (id: string, row: Record<string, string>) => {
      if (row.status !== "running") return { row, swept: false };
      const pid = Number(row.pid || "0");
      if (alivePids.has(pid)) return { row, swept: false };
      return {
        row: { ...row, status: "killed", term_reason: "crash", ended_epoch: "1779836400" },
        swept: true,
      };
    };

  test("dead-pid running row is swept and never counted as in-flight", async () => {
    let sweptId: string | null = null;
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => ["ap-zombie"],
      getAutopilotRunRow: async () => ({
        run_id: "ap-zombie",
        started: "2026-05-26T11:00:00Z",
        trigger: "scheduled",
        status: "running",
        pid: "424242",
      }),
      sweepAutopilotRun: async (id, row) => {
        sweptId = id;
        // dead pid → promoted to killed/crash
        return {
          row: { ...row, status: "killed", term_reason: "crash" },
          swept: true,
        };
      },
      listOperatorDispatches: async () => [],
    });
    assert.deepEqual(items, [], "a dead-pid run must not appear as in-flight");
    assert.equal(sweptId, "ap-zombie", "the running row must be passed through the sweeper");
  });

  test("live-pid running row survives the sweep and is counted", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => ["ap-live"],
      getAutopilotRunRow: async () => ({
        run_id: "ap-live",
        started: "2026-05-26T11:00:00Z",
        trigger: "manual",
        status: "running",
        pid: "1000",
      }),
      sweepAutopilotRun: sweepByPidAlive(new Set([1000])),
      listOperatorDispatches: async () => [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "ap-live");
    assert.equal(items[0].source, "autopilot");
  });

  test("phantom zombies do not accumulate: many dead-pid rows collapse to the one live run", async () => {
    const rows: Record<string, Record<string, string>> = {
      "ap-live": {
        run_id: "ap-live",
        started: "2026-05-26T12:00:00Z",
        trigger: "manual",
        status: "running",
        pid: "1000",
      },
    };
    // 12 zombie runs — the observed accumulation in #888 — each a stale
    // running row whose pid is dead.
    for (let i = 0; i < 12; i++) {
      rows[`ap-zombie-${i}`] = {
        run_id: `ap-zombie-${i}`,
        started: `2026-05-26T0${i % 10}:00:00Z`,
        trigger: "scheduled",
        status: "running",
        pid: String(900000 + i),
      };
    }
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => Object.keys(rows),
      getAutopilotRunRow: async (id) => rows[id],
      sweepAutopilotRun: sweepByPidAlive(new Set([1000])),
      listOperatorDispatches: async () => [],
    });
    assert.equal(items.length, 1, "only the live run counts; 12 zombies are swept out");
    assert.equal(items[0].id, "ap-live");
  });

  test("default sweep treats a pid-less running row as live (older writers)", async () => {
    // No `sweepAutopilotRun` stub → the real sweepRunIfDead runs. A running
    // row with no pid (pid <= 0) is treated as alive, so it is still counted.
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => ["ap-no-pid"],
      getAutopilotRunRow: async () => ({
        run_id: "ap-no-pid",
        started: "2026-05-26T11:00:00Z",
        trigger: "manual",
        status: "running",
      }),
      listOperatorDispatches: async () => [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "ap-no-pid");
  });
});

describe("getActiveDispatches — operator-only", () => {
  test("returns just operator rows when no autopilot is running", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => [],
      getAutopilotRunRow: async () => ({}),
      listOperatorDispatches: async () => [
        {
          id: "grill-1",
          classLabel: "hydra-grill",
          startedAt: "2026-05-26T10:00:00Z",
          currentStep: "Q3 of 6",
        },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "operator");
    assert.equal(items[0].currentStep, "Q3 of 6");
  });
});

describe("getActiveDispatches — mixed scenario", () => {
  test("merges autopilot + operator and sorts newest-first", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => ["ap-1"],
      getAutopilotRunRow: async () => ({
        run_id: "ap-1",
        started: "2026-05-26T09:00:00Z",
        trigger: "manual",
        status: "running",
      }),
      listOperatorDispatches: async () => [
        {
          id: "op-1",
          classLabel: "hydra-grill",
          startedAt: "2026-05-26T12:00:00Z",
        },
        {
          id: "op-old",
          classLabel: "hydra-review",
          startedAt: "2026-05-26T01:00:00Z",
        },
      ],
    });
    assert.equal(items.length, 3);
    // Order: op-1 (12:00), ap-1 (09:00), op-old (01:00).
    assert.deepEqual(items.map((i) => i.id), ["op-1", "ap-1", "op-old"]);
  });
});

describe("getActiveDispatches — sub-source failure isolation", () => {
  test("autopilot reader throws → operator dispatches still ship", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => {
        throw new Error("redis blew up");
      },
      listOperatorDispatches: async () => [
        {
          id: "op-survived",
          classLabel: "hydra-review",
          startedAt: "2026-05-26T10:00:00Z",
        },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "op-survived");
  });

  test("operator reader throws → autopilot rows still ship", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => ["ap-survived"],
      getAutopilotRunRow: async () => ({
        run_id: "ap-survived",
        started: "2026-05-26T10:00:00Z",
        trigger: "manual",
        status: "running",
      }),
      listOperatorDispatches: async () => {
        throw new Error("redis dispatches read failed");
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "ap-survived");
  });

  test("both sources fail → empty list, no throw", async () => {
    const items = await getActiveDispatches({
      listAutopilotRunIds: async () => {
        throw new Error("redis down");
      },
      listOperatorDispatches: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(items, []);
  });
});
