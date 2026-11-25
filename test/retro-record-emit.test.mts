/**
 * test/retro-record-emit.test.mts — the hydra-retro section 8 emit sequence
 * (issue #5739): create, first-state, then record, in that order.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { emitIssue, recheckEntry, parseIssueNumber, type EmitPorts, type EmitInput } from "../scripts/retro/record-emit.ts";
import type { RetroSeenEntry } from "../src/redis/retro-seen.ts";

const INPUT: EmitInput = { title: "t", body: "b", cue: "some-cue", runId: "run-1", labels: [], repo: "o/r", decision: "issue" };

function fakePorts(over: Partial<EmitPorts> = {}) {
  const calls: string[] = [];
  const recorded: RetroSeenEntry[] = [];
  const ports: EmitPorts = {
    async createIssue() {
      calls.push("create");
      return "https://github.com/o/r/issues/77\n";
    },
    async advanceFirstState(n) {
      calls.push(`advance:${n}`);
      return { code: 0, json: { ok: true } };
    },
    async record(e) {
      calls.push("record");
      recorded.push(e);
    },
    now: () => "2026-11-25T00:00:00.000Z",
    ...over,
  };
  return { ports, calls, recorded };
}

describe("retro record-emit", () => {
  test("happy path runs create, first-state, record in order and records the issue ref", async () => {
    const { ports, calls, recorded } = fakePorts();
    const res = await emitIssue(INPUT, ports);
    assert.deepEqual(calls, ["create", "advance:77", "record"]);
    assert.equal(res.ok, true);
    assert.deepEqual(recorded, [{ cue: "some-cue", decision: "issue", runId: "run-1", ref: "77", at: "2026-11-25T00:00:00.000Z" }]);
  });

  test("a failed first-state advance leaves the cue unrecorded", async () => {
    const { ports, calls, recorded } = fakePorts({
      async advanceFirstState() {
        return { code: 1, json: { ok: false, error: "gate-refused" } };
      },
    });
    const res = await emitIssue(INPUT, ports);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.stage, "first-state");
    assert.equal(recorded.length, 0);
    assert.ok(!calls.includes("record"));
  });

  test("illegal-transition observed at needs-triage (backstop race) still records", async () => {
    const { ports, recorded } = fakePorts({
      async advanceFirstState() {
        return { code: 1, json: { ok: false, code: "illegal-transition", observed: { state: "needs-triage" } } };
      },
    });
    const res = await emitIssue(INPUT, ports);
    assert.equal(res.ok, true);
    assert.equal(recorded.length, 1);
  });

  test("illegal-transition from any other observed state is a failure", async () => {
    const { ports, recorded } = fakePorts({
      async advanceFirstState() {
        return { code: 1, json: { ok: false, code: "illegal-transition", observed: { state: "closed" } } };
      },
    });
    const res = await emitIssue(INPUT, ports);
    assert.equal(res.ok, false);
    assert.equal(recorded.length, 0);
  });

  test("a failed gh issue create runs no later step", async () => {
    const { ports, calls } = fakePorts({
      async createIssue() {
        throw new Error("gh down");
      },
    });
    const res = await emitIssue(INPUT, ports);
    assert.equal(res.ok === false && res.stage, "create");
    assert.deepEqual(calls, []);
  });

  test("an unparseable issue URL stops before first-state", async () => {
    const { ports, calls } = fakePorts({
      async createIssue() {
        return "no url here";
      },
    });
    const res = await emitIssue(INPUT, ports);
    assert.equal(res.ok === false && res.stage, "parse-url");
    assert.ok(!calls.some((c) => c.startsWith("advance")));
  });

  test("recheck re-records the entry with a fresh timestamp", async () => {
    const { ports, recorded } = fakePorts();
    const res = await recheckEntry({ cue: "review:check:x", decision: "issue", runId: "r", ref: "5" }, ports);
    assert.equal(res.ok, true);
    assert.equal(recorded[0].at, "2026-11-25T00:00:00.000Z");
    assert.equal(recorded[0].ref, "5");
  });

  test("parseIssueNumber reads the trailing issue number", () => {
    assert.equal(parseIssueNumber("https://github.com/o/r/issues/12\n"), 12);
    assert.equal(parseIssueNumber("nope"), null);
  });
});
