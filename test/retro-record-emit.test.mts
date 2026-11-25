/**
 * test/retro-record-emit.test.mts — scripts/retro/record-emit.ts decision
 * function (issue #5739), driven with fakes: no Redis, gh or network IO.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runRecordEmit, parseIssueNumber, main, type RecordEmitPorts } from "../scripts/retro/record-emit.ts";
import type { RetroSeenEntry } from "../src/redis/retro-seen.ts";
import type { AdvanceResult } from "../src/lifecycle/index.ts";

const OK_ADVANCE = { ok: true, issue: 77, from: null, to: "needs-triage", mode: "enforce", observed: { state: "needs-triage", labels: [] } } as unknown as AdvanceResult;
const REFUSED = (code: string): AdvanceResult => ({ ok: false, issue: 77, code, mode: "enforce", written: false });

function fakePorts(over: Partial<RecordEmitPorts> = {}, files: Record<string, string> = {}) {
  const calls: string[] = [];
  const recorded: RetroSeenEntry[] = [];
  const bumped: string[] = [];
  const ports: RecordEmitPorts = {
    async gh() {
      calls.push("gh");
      return { ok: true, stdout: "https://github.com/o/r/issues/77\n" };
    },
    async advance() {
      calls.push("advance");
      return OK_ADVANCE;
    },
    async recordSeen(e) {
      calls.push("record");
      recorded.push(e);
    },
    async bumpRecurrence(c) {
      bumped.push(c);
      return 1;
    },
    async getSeen() {
      return { a: {} as RetroSeenEntry, b: {} as RetroSeenEntry };
    },
    async getRecurrence() {
      return { a: 2 };
    },
    now: () => "2026-11-25T00:00:00.000Z",
    readFile: (p) => files[p] ?? "body",
    ...over,
  };
  return { ports, calls, recorded, bumped };
}

const ISSUE_ARGV = ["issue", "--title", "t", "--body-file", "f", "--cue", "some-cue", "--run-id", "run-1"];

describe("retro record-emit", () => {
  test("issue runs gh create, advance, record in order and records the issue ref", async () => {
    const { ports, calls, recorded } = fakePorts();
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 0);
    assert.deepEqual(calls, ["gh", "advance", "record"]);
    assert.deepEqual(recorded, [{ cue: "some-cue", decision: "issue", runId: "run-1", ref: "77", at: "2026-11-25T00:00:00.000Z" }]);
  });

  test("a refused first-state advance leaves the cue unrecorded and exits 1 with the code", async () => {
    const { ports, recorded } = fakePorts({ advance: async () => REFUSED("parked:cap") });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 1);
    assert.equal(out.result.code, "parked:cap");
    assert.equal(out.result.issue, 77);
    assert.equal(recorded.length, 0);
  });

  test("illegal-transition that the identical retry resolves (backstop race) still records", async () => {
    let n = 0;
    const { ports, recorded } = fakePorts({ advance: async () => (n++ === 0 ? REFUSED("illegal-transition") : OK_ADVANCE) });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 0);
    assert.equal(recorded.length, 1);
  });

  test("illegal-transition whose retry succeeds but observes a non-needs-triage state is a refusal", async () => {
    let n = 0;
    const moved = { ...OK_ADVANCE, observed: { state: "in-progress", labels: [] } } as unknown as AdvanceResult;
    const { ports, recorded } = fakePorts({ advance: async () => (n++ === 0 ? REFUSED("illegal-transition") : moved) });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 1);
    assert.equal(out.result.code, "illegal-transition");
    assert.equal(recorded.length, 0);
  });

  test("main reports crashed with exit 1 when port construction throws", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (writes.push(String(c)), true)) as typeof process.stdout.write;
    const origErr = console.error;
    console.error = () => {};
    let code: number;
    try {
      code = await main(["pr"], () => {
        throw new Error("redis down");
      });
    } finally {
      process.stdout.write = orig;
      console.error = origErr;
    }
    assert.equal(code, 1);
    assert.equal(JSON.parse(writes.join("")).code, "crashed");
  });

  test("illegal-transition that persists is a refusal", async () => {
    const { ports, recorded } = fakePorts({ advance: async () => REFUSED("illegal-transition") });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 1);
    assert.equal(recorded.length, 0);
  });

  test("a seam throw exits 1 unrecorded", async () => {
    const { ports, recorded } = fakePorts({
      advance: async () => {
        throw new Error("boom");
      },
    });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 1);
    assert.equal(recorded.length, 0);
  });

  test("an unparseable gh issue create stdout exits 1 before any advance", async () => {
    const { ports, calls } = fakePorts({ gh: async () => ({ ok: true, stdout: "no url" }) });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 1);
    assert.ok(!calls.includes("advance"));
  });

  test("a failed gh create runs no later step", async () => {
    const { ports, calls } = fakePorts({ gh: async () => ({ ok: false, code: "gh-auth" }) });
    const out = await runRecordEmit(ISSUE_ARGV, ports);
    assert.equal(out.code, 1);
    assert.ok(!calls.includes("advance") && !calls.includes("record"));
  });

  test("recheck preserves every field but at, and never creates or advances", async () => {
    const entry = { cue: "review:check:x", decision: "issue", runId: "r", ref: "5", at: "old" };
    const { ports, calls, recorded } = fakePorts({}, { "e.json": JSON.stringify([entry]) });
    const out = await runRecordEmit(["recheck", "--entries-file", "e.json"], ports);
    assert.equal(out.code, 0);
    assert.deepEqual(recorded, [{ ...entry, at: "2026-11-25T00:00:00.000Z" }]);
    assert.deepEqual(calls, ["record"]);
  });

  test("pr writes decision pr", async () => {
    const { ports, recorded } = fakePorts();
    const out = await runRecordEmit(["pr", "--cue", "c", "--run-id", "r", "--ref", "9"], ports);
    assert.equal(out.code, 0);
    assert.equal(recorded[0].decision, "pr");
    assert.equal(recorded[0].ref, "9");
  });

  test("ledger bumps once per cue in order and prints the seenCues and recurrence shape", async () => {
    const { ports, bumped } = fakePorts({}, { "c.json": JSON.stringify(["x", "y"]) });
    const out = await runRecordEmit(["ledger", "--cues-file", "c.json"], ports);
    assert.equal(out.code, 0);
    assert.deepEqual(bumped, ["x", "y"]);
    assert.deepEqual(out.result, { seenCues: ["a", "b"], recurrence: { a: 2 } });
  });

  test("missing flags and unknown verbs exit 2", async () => {
    const { ports } = fakePorts();
    assert.equal((await runRecordEmit(["issue"], ports)).code, 2);
    assert.equal((await runRecordEmit(["nope"], ports)).code, 2);
  });

  test("parseIssueNumber reads the trailing issue number", () => {
    assert.equal(parseIssueNumber("https://github.com/o/r/issues/12\n"), 12);
    assert.equal(parseIssueNumber("nope"), null);
  });
});
