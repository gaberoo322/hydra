import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blocksMerge,
  classifyRollupEntry,
  foldRollup,
  isRed,
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
