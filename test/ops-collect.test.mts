import { spawnSync } from "node:child_process";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectAgentMemory,
  collectBoard,
  collectCycles,
  collectScheduler,
  learningAgents,
  renderText,
} from "../scripts/ops-collect-logic.ts";

describe("collectCycles", () => {
  test("summarises merge rate, durations, anchors and repeated tasks", () => {
    const r = collectCycles({
      trend: [
        { tasksMerged: 1, totalDurationMs: 4000, anchorType: "a", taskTitle: "t1", testsAfter: 110 },
        { tasksFailed: 1, totalDurationMs: 2000, anchorType: "a", taskTitle: "t1", testsAfter: 100 },
        { tasksAbandoned: 1, anchorType: "b" },
      ],
      coverage: { recordedClasses: ["dev_orch"], classesNotRecorded: ["research_orch"] },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.cycles, 3);
    assert.equal(r.data.merged, 1);
    assert.equal(r.data.failed, 1);
    assert.equal(r.data.abandoned, 1);
    assert.equal(r.data.mergeRatePct, 33);
    assert.equal(r.data.avgDurationSec, 3);
    assert.deepEqual(r.data.anchors, { a: 2, b: 1 });
    assert.deepEqual(r.data.repeatedTasks, [{ title: "t1", count: 2 }]);
    assert.equal(r.data.testsDelta, 110 - 0);
    assert.equal(r.data.avgCostUsd, null);
    assert.equal(r.data.totalCostUsd, null);
    assert.deepEqual(r.data.coverage?.classesNotRecorded, ["research_orch"]);
  });

  test("degrades to a coded failure instead of throwing", () => {
    assert.deepEqual(collectCycles(null), { ok: false, code: "bad-input", reason: "metrics response is not an object" });
    const empty = collectCycles({ trend: [] });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "no-data");
    const bad = collectCycles({});
    assert.equal(bad.ok, false);
  });
});

describe("collectCycles cost and malformed entries", () => {
  test("reports avg and total cost per cycle over cycles that recorded cost", () => {
    const r = collectCycles({ trend: [{ costUsd: 1.5 }, { costUsd: 0.5 }, {}] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.avgCostUsd, 1);
    assert.equal(r.data.totalCostUsd, 2);
  });
  test("null trend entries are skipped instead of throwing", () => {
    const r = collectCycles({ trend: [null, { tasksMerged: 1 }] });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data.cycles, 1);
    const allBad = collectCycles({ trend: [null] });
    assert.equal(allBad.ok, false);
  });
});

describe("ops-collect CLI always exits 0 and degrades", () => {
  const cli = new URL("../scripts/ops-collect.ts", import.meta.url).pathname;
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, HYDRA_API_URL: "http://127.0.0.1:1" },
      timeout: 30000,
    });
  test("unreachable API yields ok:false and exit 0", () => {
    const r = run(["--collectors", "cycles,scheduler"]);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.cycles.ok, false);
    assert.equal(out.cycles.code, "unreachable");
    assert.equal(out.scheduler.ok, false);
  });
  test("unknown collector yields unknown-collector, exit 0; --text prints a line", () => {
    const r = run(["--collectors", "bogus", "--text"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^bogus: unknown-collector/);
  });
  test("trailing --collectors with no value falls back to defaults without crashing", () => {
    const r = run(["--collectors"]);
    assert.equal(r.status, 0);
    assert.ok(JSON.parse(r.stdout).cycles);
  });
});

describe("collectAgentMemory", () => {
  test("counts patterns and hits; absent key is zero, bad JSON is a coded failure", () => {
    const ok = collectAgentMemory("planner", JSON.stringify([{ hitCount: 2 }, { hitCount: 5 }, {}]));
    assert.deepEqual(ok, { ok: true, data: { agent: "planner", patterns: 3, totalHits: 7 } });
    assert.deepEqual(collectAgentMemory("executor", null), {
      ok: true,
      data: { agent: "executor", patterns: 0, totalHits: 0 },
    });
    const bad = collectAgentMemory("x", "{nope");
    assert.equal(bad.ok, false);
    const notArr = collectAgentMemory("x", "{}");
    assert.equal(notArr.ok, false);
  });
});

describe("learningAgents", () => {
  test("returns distinct non-null agents from the classes table", () => {
    assert.deepEqual(
      learningAgents({ classes: [{ learningAgent: "executor" }, { learningAgent: null }, { learningAgent: "planner" }, { learningAgent: "executor" }] }),
      ["executor", "planner"],
    );
    assert.deepEqual(learningAgents(null), []);
  });
});

describe("collectBoard / collectScheduler / renderText", () => {
  test("board counts labels per open issue", () => {
    const r = collectBoard([{ labels: [{ name: "a" }, { name: "b" }] }, { labels: [{ name: "a" }] }]);
    assert.deepEqual(r, { ok: true, data: { open: 2, byLabel: { a: 2, b: 1 } } });
    assert.equal(collectBoard("x").ok, false);
  });

  test("scheduler summarises status and rejects non-objects", () => {
    assert.deepEqual(collectScheduler({ running: true, cyclesRun: 9, consecutiveErrors: 1 }), {
      ok: true,
      data: { running: true, cyclesRun: 9, consecutiveErrors: 1 },
    });
    assert.equal(collectScheduler(null).ok, false);
  });

  test("renderText prints failures as code (reason)", () => {
    assert.equal(renderText("cycles", { ok: false, code: "unreachable", reason: "down" }), "cycles: unreachable (down)");
  });
});

describe("hydra-architect playbook", () => {
  const body = readFileSync(new URL("../docs/operator-playbooks/hydra-architect.md", import.meta.url), "utf8");

  test("holds no inline parsing and no redis-cli", () => {
    assert.doesNotMatch(body, /python3\s+-/);
    assert.doesNotMatch(body, /\bjq\b/);
    assert.doesNotMatch(body, /redis-cli/);
  });

  test("calls the ops-collect CLI", () => {
    assert.match(body, /scripts\/ops-collect\.ts --collectors/);
  });

  test("drops the dead research.dailySpendUsd line and the hand-listed agent loop", () => {
    assert.doesNotMatch(body, /dailySpendUsd/);
    assert.doesNotMatch(body, /planner executor/);
  });
});
