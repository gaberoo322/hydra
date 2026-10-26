import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blocksMerge,
  classifyRollupEntry,
  foldRollup,
  isRed,
  isSettled,
} from "../src/github/check-rollup.ts";

const run = (name: string, conclusion: string, extra: Record<string, string> = {}) => ({
  name,
  conclusion,
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  ...extra,
});

describe("classifyRollupEntry", () => {
  it("maps CheckRun conclusions four ways", () => {
    for (const c of ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"])
      assert.equal(classifyRollupEntry(run("a", c)), "red");
    for (const c of ["SUCCESS", "NEUTRAL", "SKIPPED"])
      assert.equal(classifyRollupEntry(run("a", c)), "green");
    assert.equal(classifyRollupEntry(run("a", "CANCELLED")), "cancelled");
    for (const c of ["", "STALE", "WEIRD"]) assert.equal(classifyRollupEntry(run("a", c)), "pending");
    assert.equal(classifyRollupEntry(undefined), "pending");
  });
  it("maps StatusContext states", () => {
    assert.equal(classifyRollupEntry({ context: "c", state: "FAILURE" }), "red");
    assert.equal(classifyRollupEntry({ context: "c", state: "ERROR" }), "red");
    assert.equal(classifyRollupEntry({ context: "c", state: "SUCCESS" }), "green");
    assert.equal(classifyRollupEntry({ context: "c", state: "PENDING" }), "pending");
    assert.equal(classifyRollupEntry({ context: "c", state: "EXPECTED" }), "pending");
    assert.equal(classifyRollupEntry({ context: "c", state: "NEUTRAL" }), "pending");
  });
});

describe("foldRollup", () => {
  it("a superseded cancelled run followed by a success rerun folds to green, in either list order", () => {
    const a = run("test", "CANCELLED", { completedAt: "2026-01-01T00:00:00Z" });
    const b = run("test", "SUCCESS", { completedAt: "2026-01-01T00:05:00Z" });
    for (const list of [[a, b], [b, a]])
      assert.equal(foldRollup(list).contexts.get("test")?.status, "green");
  });
  it("timestamp ties and untimestamped entries go to the later list index", () => {
    const t = "2026-01-01T00:00:00Z";
    const tie = [run("x", "FAILURE", { completedAt: t }), run("x", "SUCCESS", { completedAt: t })];
    assert.equal(foldRollup(tie).contexts.get("x")?.status, "green");
    const none = [run("x", "SUCCESS"), run("x", "FAILURE")];
    assert.equal(foldRollup(none).contexts.get("x")?.status, "red");
  });
  it("treats the 0001 sentinel as absent", () => {
    const l = [
      run("x", "SUCCESS", { completedAt: "2026-01-01T00:00:00Z" }),
      run("x", "FAILURE", { completedAt: "0001-01-01T00:00:00Z" }),
    ];
    assert.equal(foldRollup(l).contexts.get("x")?.status, "green");
  });
  it("keys CheckRun on name, StatusContext on context, else 'check'", () => {
    const f = foldRollup([run("a", "SUCCESS"), { context: "b", state: "FAILURE" }, { conclusion: "SUCCESS" }]);
    assert.deepEqual([...f.contexts.keys()].sort(), ["a", "b", "check"]);
  });
  it("order parameter changes which entry wins, not classification", () => {
    const l = [
      run("x", "FAILURE", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:30:00Z" }),
      run("x", "SUCCESS", { startedAt: "2026-01-01T00:10:00Z", completedAt: "2026-01-01T00:20:00Z" }),
    ];
    assert.equal(foldRollup(l).contexts.get("x")?.status, "red");
    assert.equal(foldRollup(l, { order: "started-only" }).contexts.get("x")?.status, "green");
  });
  it("restricts to required contexts; an absent required context is pending with no entry", () => {
    const f = foldRollup([run("a", "SUCCESS"), run("noise", "FAILURE")], { required: ["a", "b"] });
    assert.deepEqual([...f.contexts.keys()], ["a", "b"]);
    assert.deepEqual(f.contexts.get("b"), { status: "pending", entry: undefined });
    assert.equal(isRed(f), false);
  });
  it("an in-progress rerun (0001 completedAt, later startedAt) beats an older FAILURE, in either list order", () => {
    const l = [
      { name: "test", conclusion: "FAILURE", completedAt: "2026-09-29T08:00:00Z" },
      { name: "test", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-09-29T09:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
    ];
    for (const list of [l, [...l].reverse()]) {
      const c = foldRollup(list).contexts.get("test");
      assert.equal(c?.entry?.status, "IN_PROGRESS");
      assert.equal(c?.status, "pending");
    }
  });
  it("CheckRun and StatusContext with the same name collapse to one context; the later StatusContext wins", () => {
    const f = foldRollup([
      { name: "deep-qa-gate", conclusion: "SUCCESS", completedAt: "2026-09-29T08:00:00Z" },
      { context: "deep-qa-gate", state: "FAILURE", startedAt: "2026-09-29T09:00:00Z" },
    ]);
    assert.equal(f.contexts.size, 1);
    assert.equal(f.contexts.get("deep-qa-gate")?.status, "red");
  });
  it("tolerates a non-array rollup", () => {
    assert.equal(foldRollup(null).contexts.size, 0);
  });
});

describe("predicates", () => {
  it("cancelled is never red but blocks merge", () => {
    const f = foldRollup([run("a", "CANCELLED")]);
    assert.equal(isRed(f), false);
    assert.equal(blocksMerge(f), true);
  });
  it("red implies blocksMerge; all green blocks nothing", () => {
    const red = foldRollup([run("a", "FAILURE")]);
    assert.equal(isRed(red) && blocksMerge(red), true);
    const green = foldRollup([run("a", "SUCCESS")]);
    assert.equal(isRed(green), false);
    assert.equal(blocksMerge(green), false);
  });
  it("pending blocks merge but is not red", () => {
    const f = foldRollup([run("a", "")]);
    assert.equal(isRed(f), false);
    assert.equal(blocksMerge(f), true);
  });
});

describe("isSettled and started-only order (#5089)", () => {
  it("isSettled: absent / pending required are unsettled; cancelled and green are settled", () => {
    assert.equal(isSettled(foldRollup([run("a", "SUCCESS")], { required: ["a", "b"] })), false);
    assert.equal(isSettled(foldRollup([run("a", "")], { required: ["a"] })), false);
    assert.equal(isSettled(foldRollup([run("a", "CANCELLED")], { required: ["a"] })), true);
    assert.equal(isSettled(foldRollup([run("a", "SUCCESS")], { required: ["a"] })), true);
    assert.equal(isSettled(foldRollup([], { required: [] })), true);
  });
  it("red + pending: isRed true, isSettled false", () => {
    const f = foldRollup([run("a", "FAILURE"), run("b", "")], { required: ["a", "b"] });
    assert.equal(isRed(f), true);
    assert.equal(isSettled(f), false);
  });
  it("started-only picks the later-startedAt CANCELLED over an earlier FAILURE", () => {
    const f = foldRollup(
      [
        run("a", "CANCELLED", { startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T00:00:01Z" }),
        run("a", "FAILURE", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-03T00:00:00Z" }),
      ],
      { required: ["a"], order: "started-only" },
    );
    assert.equal(isRed(f), false);
  });
});

describe("parseRollupEntries (#5089 QA round 1)", () => {
  it("non-array -> [], non-object entries dropped, non-string fields become undefined", async () => {
    const { parseRollupEntries } = await import("../src/github/prs.ts");
    for (const raw of [undefined, null, {}, "x", 3]) assert.deepEqual(parseRollupEntries(raw), []);
    const out = parseRollupEntries([null, 4, "s", { name: "a", conclusion: 5, state: "SUCCESS" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "a");
    assert.equal(out[0].conclusion, undefined);
    assert.equal(out[0].state, "SUCCESS");
  });
});
