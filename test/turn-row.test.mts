/**
 * Turn Row module (issue #5444): the parser's tolerance rule over a fixed set
 * of raw stored rows, the per-field guards shared by the write and read paths,
 * the stored-form pin, and the two named behaviour changes the tolerance rule
 * introduces in the adopting readers.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseTurnRow,
  parseTurnRows,
  readRunTurns,
  resolveCycleIdCandidate,
  resolveCycleId,
  serializeTurnMember,
  sanitizeParentExceptions,
} from "../src/autopilot/turn-row.ts";
import { foldParentExceptions, ledgerToRunTurns, runCarriesMirror } from "../src/aggregators/lifecycle-health.ts";
import { getRunDispatchClasses } from "../src/autopilot/run-reads.ts";
import { recordTurn } from "../src/autopilot/runs.ts";
import type { AutopilotRunsDeps } from "../src/autopilot/runs.ts";
import { readClassState } from "../src/autopilot/class-state.ts";
import { fetchTurnsWithJoins } from "../src/autopilot/run-projections.ts";
import { joinedTurnFromWire } from "../src/autopilot/turn-row.ts";
import { countOpenDispatches } from "../src/autopilot/health-signals/stalled-dispatch.ts";
import { defaultReadRecentTurns } from "../src/autopilot/recommendation-consumer.ts";

describe("parseTurnRow — tolerance rule", () => {
  test("a full current-era row parses to typed fields and keeps the raw object", () => {
    const row = parseTurnRow(
      JSON.stringify({
        turn_n: 4,
        epoch: 1000,
        actions: [{ type: "dispatch", slot: "dev_orch", cycleId: "c1" }, { type: "wait" }],
        slots_snapshot: { dev_orch: null },
        signals_snapshot: { sweep_orch: 5 },
        idle_turns: 2,
        decisions: { dev_orch: { outcome: "dispatch", reason: "ok" } },
        burned_classes: ["x"],
        usage_shed: ["y"],
        usage_allow: true,
        parent_exceptions: [{ cause: "c", turn: 4, source: "parent", detail: "d", ts_epoch: 9 }],
        extra_unknown_key: 1,
      }),
    );
    assert.ok(row);
    assert.equal(row.turn_n, 4);
    assert.equal(row.epoch, 1000);
    assert.equal(row.idle_turns, 2);
    assert.equal(row.usage_allow, true);
    assert.deepEqual(row.burned_classes, ["x"]);
    assert.equal(row.parent_exceptions?.length, 1);
    assert.equal(row.dispatches.length, 1);
    assert.equal(row.dispatches[0].class, "dev_orch");
    assert.equal(row.dispatches[0].cycleIdCandidate, "c1");
    assert.equal(row.raw.extra_unknown_key, 1);
  });

  test("a pre-mirror row (no parent_exceptions) reads parent_exceptions as absent, not []", () => {
    const row = parseTurnRow(JSON.stringify({ turn_n: 1, epoch: 5 }));
    assert.ok(row);
    assert.equal(row.parent_exceptions, undefined);
    assert.equal(row.decisions, undefined);
    assert.equal(row.usage_allow, undefined);
    assert.deepEqual(row.dispatches, []);
  });

  test("a legacy class-field dispatch resolves its class, ahead of slot", () => {
    const row = parseTurnRow(
      JSON.stringify({
        turn_n: 1,
        actions: [
          { type: "dispatch", class: "qa_orch", slot: "ignored" },
          { type: "dispatch", slot: "dev_orch" },
          { type: "dispatch" },
        ],
      }),
    );
    assert.ok(row);
    assert.deepEqual(row.dispatches.map((d) => d.class), ["qa_orch", "dev_orch", null]);
    assert.deepEqual(row.dispatches.map((d) => d.index), [0, 1, 2]);
  });

  test("a row with a malformed optional field keeps the row and reads that field as absent", () => {
    const row = parseTurnRow(
      JSON.stringify({
        turn_n: 2,
        epoch: "soon",
        actions: "nope",
        usage_allow: "yes",
        burned_classes: "all",
        decisions: [1],
        idle_turns: "many",
        parent_exceptions: { not: "a list" },
      }),
    );
    assert.ok(row);
    assert.equal(row.turn_n, 2);
    for (const k of ["epoch", "actions", "usage_allow", "burned_classes", "decisions", "idle_turns", "parent_exceptions"] as const) {
      assert.equal(row[k], undefined, `${k} must read as absent`);
    }
  });

  test("a row with no integer turn_n is null", () => {
    assert.equal(parseTurnRow(JSON.stringify({ epoch: 1 })), null);
    assert.equal(parseTurnRow(JSON.stringify({ turn_n: "3" })), null);
    assert.equal(parseTurnRow(JSON.stringify({ turn_n: 1.5 })), null);
  });

  test("non-object JSON and non-JSON are null", () => {
    for (const m of ["[1,2]", "null", "7", '"s"', "{not json"]) {
      assert.equal(parseTurnRow(m), null, m);
    }
  });

  test("parseTurnRows skips the null members and keeps order", () => {
    const rows = parseTurnRows(['{"turn_n":3}', "bad", '{"turn_n":2}']);
    assert.deepEqual(rows.map((r) => r.turn_n), [3, 2]);
  });

  test("readRunTurns reads through the injected accessor and parses", async () => {
    let seen = "";
    const rows = await readRunTurns("r1", 7, async (runId, limit) => {
      seen = `${runId}:${limit}`;
      return ['{"turn_n":1}'];
    });
    assert.equal(seen, "r1:7");
    assert.equal(rows.length, 1);
  });

  test("resolveCycleId synthesises run:turn:index only when no candidate; candidate wins (sibling pin)", () => {
    assert.equal(resolveCycleId("r1", 3, 2, null), "r1:3:2");
    assert.equal(resolveCycleId("r1", 3, 2, "c9"), "c9");
  });

  test("resolveCycleIdCandidate follows cycleId, autopilotTurnId, worktreeBranch order", () => {
    assert.equal(resolveCycleIdCandidate({ cycleId: "a", autopilotTurnId: "b" }), "a");
    assert.equal(resolveCycleIdCandidate({ autopilotTurnId: "b", worktreeBranch: "c" }), "b");
    assert.equal(resolveCycleIdCandidate({ worktreeBranch: "c" }), "c");
    assert.equal(resolveCycleIdCandidate({}), null);
  });
});

describe("one guard per field — write and read paths agree", () => {
  test("sanitizeParentExceptions output is a fixed point of parseTurnRow", () => {
    const raw = [
      { cause: "c", turn: 1, source: "s", ts_epoch: 2 },
      { cause: 5, turn: 1, source: "s", ts_epoch: 2 },
    ];
    const guarded = sanitizeParentExceptions(raw);
    assert.deepEqual(guarded, [{ cause: "c", turn: 1, source: "s", detail: "", ts_epoch: 2 }]);
    const row = parseTurnRow(JSON.stringify({ turn_n: 1, parent_exceptions: raw }));
    assert.deepEqual(row?.parent_exceptions, guarded);
  });
});

describe("recordTurn stored form", () => {
  function depsCapturing(out: string[]): AutopilotRunsDeps {
    return {
      runs: {
        getAutopilotRun: async () => ({ started: "1" }),
        initAutopilotRun: async () => {},
        updateAutopilotRunFields: async () => {},
        setAutopilotRunField: async () => {},
        incrAutopilotRunField: async () => {},
        refreshAutopilotRunTTL: async () => {},
        addAutopilotRunToIndex: async () => {},
        addAutopilotRunTurn: async (_r, _t, member) => {
          out.push(member);
        },
        hasAutopilotRunTurnAt: async () => false,
        listStreamEntriesSince: async () => [],
      },
      hasPendingDurableMergeSince: () => false,
      isPidAlive: () => true,
      now: () => 2_000_000,
      stampWorklessHint: async () => null,
      stampPostQuotaHint: async () => null,
    };
  }

  test("the stored member is byte-identical to the pre-module writer for the same body", async () => {
    const out: string[] = [];
    const r = await recordTurn(
      {
        run_id: "run-x",
        turn_n: 7,
        actions: [{ type: "dispatch", slot: "dev_orch" }],
        reasons: ["why"],
        tokens_after: 11,
        idle_turns: 1,
        decisions: { dev_orch: { outcome: "dispatch", reason: "ok" }, bad: { outcome: 1 } },
        burned_classes: ["a", 3],
        usage_shed: ["b"],
        usage_allow: false,
        parent_exceptions: [{ cause: "c", turn: 7, source: "parent", detail: "d", ts_epoch: 9 }],
      } as never,
      depsCapturing(out),
    );
    assert.equal(r.ok, true);
    assert.equal(
      out[0],
      '{"turn_n":7,"epoch":2000,"actions":[{"type":"dispatch","slot":"dev_orch"}],"reasons":["why"],"slots_snapshot":{},"signals_snapshot":{},"tokens_after":11,"idle_turns":1,"decisions":{"dev_orch":{"outcome":"dispatch","reason":"ok"}},"burned_classes":["a"],"usage_shed":["b"],"usage_allow":false,"parent_exceptions":[{"cause":"c","turn":7,"source":"parent","detail":"d","ts_epoch":9}]}',
    );
  });

  test("serializeTurnMember omits absent optional keys", () => {
    const m = serializeTurnMember({
      turn_n: 1,
      epoch: 2,
      actions: [],
      reasons: [],
      slots_snapshot: {},
      signals_snapshot: {},
      tokens_after: 0,
      idle_turns: 0,
    });
    assert.equal(
      m,
      '{"turn_n":1,"epoch":2,"actions":[],"reasons":[],"slots_snapshot":{},"signals_snapshot":{},"tokens_after":0,"idle_turns":0}',
    );
  });
});

describe("behaviour changes from the tolerance rule", () => {
  test("class-state no longer drops a row for a missing epoch", async () => {
    const res = await readClassState({
      getSignalLastFired: async () => ({ ok: true, lastFired: {} }),
      getCurrentLifecycle: async () =>
        ({ ok: true, lifecycle: { run_id: "run-x", state: "running" } }) as never,
      getRunRow: async () => ({ ok: false, code: "not-found", detail: "" }) as never,
      readTurns: async () =>
        parseTurnRows([
          JSON.stringify({
            turn_n: 3,
            decisions: { sweep_orch: { outcome: "budget", reason: "cap" } },
          }),
        ]),
      now: () => 10_000_000,
    });
    const sweep = res.classes.find((c) => c.name === "sweep_orch");
    assert.ok(sweep);
    assert.deepEqual(sweep.verdict, { outcome: "budget", reason: "cap", turnN: 3 });
    assert.equal(res.header.run?.latestTurnN, 3);
    assert.equal(res.header.run?.latestTurnEpoch, null);
    assert.equal(res.header.verdictFreshness, "unknown");
  });

  test("recommendation-consumer no longer reads a missing turn_n as turn 0 (the row is skipped)", async () => {
    const turns = await defaultReadRecentTurns("r", 10, async () =>
      parseTurnRows([
        JSON.stringify({ epoch: 5, actions: [{ type: "dispatch" }] }),
        JSON.stringify({ turn_n: 2, epoch: 6, actions: [{ type: "dispatch" }, { type: "wait" }] }),
      ]),
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0].turn_n, 2);
    assert.equal(turns[0].dispatches, 1);
  });
});

describe("reader parity and named tolerance cases (#5444)", () => {
  const ev = { cause: "script-error", turn: 2, source: "parent", detail: "d", ts_epoch: 9 };

  test("ledgerToRunTurns keeps a source-less event, matching the Redis read path (INV-8)", () => {
    const run = ledgerToRunTurns({
      run_id: "r",
      started_epoch: 1,
      turn: 2,
      parent_exceptions: [{ cause: "x", turn: 2, ts_epoch: 5 }],
    });
    assert.ok(run);
    assert.equal(run.turns[1].parent_exceptions?.length, 1);
    const redis = parseTurnRows([JSON.stringify({ turn_n: 2, parent_exceptions: [{ cause: "x", turn: 2, ts_epoch: 5 }] })]);
    assert.equal(redis[0].parent_exceptions?.length, 1);
    assert.equal(foldParentExceptions([run]).exceptionTurns, 1);
    assert.equal(foldParentExceptions([{ runId: "r", startedEpoch: 1, turns: redis }]).exceptionTurns, 1);
  });

  test("write guard stays strict: sanitizeParentExceptions without lenientSource drops a source-less row", () => {
    assert.equal(sanitizeParentExceptions([{ cause: "x", turn: 2, ts_epoch: 5 }]), undefined);
  });

  test("sibling pin: ledgerToRunTurns keeps a well-formed event", () => {
    const run = ledgerToRunTurns({ run_id: "r", started_epoch: 1, turn: 2, parent_exceptions: [ev] });
    assert.ok(run);
    assert.equal(run.turns[1].parent_exceptions?.length, 1);
    assert.equal(foldParentExceptions([run]).exceptionTurns, 1);
  });

  test("foldParentExceptions skips a row with no integer turn_n (no unnumbered turn)", () => {
    const f = foldParentExceptions([
      { runId: "r", startedEpoch: 1, turns: parseTurnRows([JSON.stringify({ parent_exceptions: [] }), JSON.stringify({ turn_n: 1 })]) },
    ]);
    assert.equal(f.turns, 1);
  });

  test("runCarriesMirror: an all-malformed parent_exceptions array still reads as mirror-era (pre-module behaviour)", () => {
    const turns = parseTurnRows([JSON.stringify({ turn_n: 1, parent_exceptions: [{ cause: "x" }] })]);
    assert.equal(runCarriesMirror({ runId: "r", startedEpoch: 1, turns }), true);
    const absent = parseTurnRows([JSON.stringify({ turn_n: 1 })]);
    assert.equal(runCarriesMirror({ runId: "r", startedEpoch: 1, turns: absent }), false);
  });

  test("runCarriesMirror: an empty array marks mirror", () => {
    const empty = parseTurnRows([JSON.stringify({ turn_n: 1, parent_exceptions: [] })]);
    assert.equal(runCarriesMirror({ runId: "r", startedEpoch: 1, turns: empty }), true);
  });

  test("getRunDispatchClasses skips a row with no turn_n, keeps a numbered one", async () => {
    const classes = await getRunDispatchClasses("r", {
      readTurns: async () =>
        parseTurnRows([
          JSON.stringify({ actions: [{ type: "dispatch", slot: "ghost_orch" }] }),
          JSON.stringify({ turn_n: 1, actions: [{ type: "dispatch", slot: "dev_orch" }] }),
        ]),
    });
    assert.deepEqual(classes, ["dev_orch"]);
  });
});

describe("joined turns (issue #5445)", () => {
  const noCycles = async () => ({});

  test("fetchTurnsWithJoins skips a member with no integer turn_n instead of keeping it as turn 0", async () => {
    const turns = await fetchTurnsWithJoins("r", 10, {
      listTurnsDesc: async () => [
        JSON.stringify({ actions: [{ type: "dispatch", slot: "ghost_orch" }] }),
        JSON.stringify({ turn_n: "3", actions: [] }),
        JSON.stringify({ turn_n: 2, actions: [{ type: "dispatch", slot: "dev_orch" }] }),
      ],
      getCycleHashesBatch: noCycles,
    });
    assert.deepEqual(turns.map((t) => t.turn_n), [2]);
  });

  test("a dispatch with no id synthesises <run>:<turn>:<index> and joins that cycle hash", async () => {
    const turns = await fetchTurnsWithJoins("r", 10, {
      listTurnsDesc: async () => [
        JSON.stringify({ turn_n: 7, actions: [{ type: "noop" }, { type: "dispatch", slot: "dev_orch" }] }),
      ],
      getCycleHashesBatch: async (ids) => (ids.includes("r:7:1") ? { "r:7:1": { status: "merged" } } : {}),
    });
    assert.equal(turns[0].dispatches[0].outcome?.cycleId, "r:7:1");
    assert.equal(turns[0].dispatches[0].outcome?.status, "merged");
  });

  test("joinedTurnFromWire round-trips unknown keys and countOpenDispatches counts null outcomes", () => {
    const wire = {
      turn_n: 1,
      mystery: { a: 1 },
      actions: [
        { type: "dispatch", outcome: null },
        { type: "dispatch", outcome: { status: "merged" } },
        { type: "noop" },
      ],
    };
    const joined = joinedTurnFromWire(wire);
    assert.ok(joined);
    assert.deepEqual(joined.raw, wire);
    assert.equal(countOpenDispatches(joined), 1);
    assert.equal(joinedTurnFromWire({ actions: [] }), null);
  });
});
