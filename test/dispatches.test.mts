/**
 * Subagent-dispatch registry — round-trip + aggregator + sentinel tests
 * (issue #692).
 *
 * Three surfaces:
 *
 *   1. `src/redis/dispatches.ts` subagent namespace — register → get → list →
 *      step → end round-trip against a real Redis on DB 1 (same convention as
 *      `redis-dispatches.test.mts`). Production uses DB 0; tests never touch it.
 *   2. `src/aggregators/active-dispatches.ts` — the subagent sub-source merges
 *      into the unified `Dispatch[]` list (pure, deps-stubbed).
 *   3. `scripts/autopilot/decide.py` — `make_dispatch_sentinel` emits the
 *      `<!-- hydra-dispatch v1 ... -->` marker the SessionStart hook consumes,
 *      and `decide` stamps it onto dispatch actions.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.REDIS_URL = "redis://localhost:6379/1";

const {
  registerSubagentDispatch,
  endSubagentDispatch,
  listActiveSubagentDispatches,
  getSubagentDispatch,
  setSubagentDispatchStep,
  subagentDispatchKey,
  subagentDispatchIndexKey,
  projectSubagentRow,
} = await import("../src/redis/dispatches.ts");

const { getActiveDispatches } = await import("../src/aggregators/active-dispatches.ts");

let testRedis: any;

async function cleanSubagentKeys() {
  if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
  const keys = await testRedis.keys("hydra:dispatches:subagent:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

// ---------------------------------------------------------------------------
// Key builders + pure projector
// ---------------------------------------------------------------------------

describe("subagentDispatchKey + subagentDispatchIndexKey", () => {
  test("uses the hydra:dispatches:subagent namespace", () => {
    assert.equal(subagentDispatchKey("sess-1"), "hydra:dispatches:subagent:sess-1");
    assert.equal(subagentDispatchIndexKey(), "hydra:dispatches:subagent:index");
  });
});

describe("projectSubagentRow — pure helper", () => {
  test("returns null on a row missing required identity fields", () => {
    assert.equal(projectSubagentRow(null), null);
    assert.equal(projectSubagentRow({}), null);
    assert.equal(projectSubagentRow({ sessionId: "x", skill: "hydra-dev" } as any), null);
  });

  test("projects a full row, dropping empty optionals", () => {
    const got = projectSubagentRow({
      sessionId: "sess-1",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
      runId: "run-1",
      currentStep: "",
    });
    assert.deepEqual(got, {
      sessionId: "sess-1",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
      runId: "run-1",
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip against real Redis
// ---------------------------------------------------------------------------

describe("subagent dispatch register/get/list/step/end round-trip", () => {
  beforeEach(async () => {
    await cleanSubagentKeys();
  });

  after(async () => {
    await cleanSubagentKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("persists every field, returns matching shape on get + list", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-1",
      skill: "hydra-dev",
      dispatchId: "worktree-agent-abc-t1-dev_orch",
      startedAt: "2026-05-28T10:00:00.000Z",
      runId: "run-123",
      issueRef: "#692",
    });

    const got = await getSubagentDispatch("sess-1");
    assert.ok(got);
    assert.equal(got!.sessionId, "sess-1");
    assert.equal(got!.skill, "hydra-dev");
    assert.equal(got!.dispatchId, "worktree-agent-abc-t1-dev_orch");
    assert.equal(got!.runId, "run-123");
    assert.equal(got!.issueRef, "#692");
    assert.equal(got!.prRef, undefined);

    const list = await listActiveSubagentDispatches();
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, "sess-1");
  });

  test("persists hash + index entry at the documented keys with a TTL", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-ttl",
      skill: "hydra-grill",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
    });
    const ttl = await testRedis.ttl(subagentDispatchKey("sess-ttl"));
    assert.ok(ttl > 0 && ttl <= 24 * 60 * 60);
    const score = await testRedis.zscore(subagentDispatchIndexKey(), "sess-ttl");
    // 2026-05-28T10:00:00.000Z -> 1779962400 (seconds since epoch)
    assert.equal(Number(score), 1779962400);
  });

  test("listActiveSubagentDispatches returns newest-first", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-old",
      skill: "hydra-dev",
      dispatchId: "wt-old",
      startedAt: "2026-05-28T01:00:00.000Z",
    });
    await registerSubagentDispatch({
      sessionId: "sess-new",
      skill: "hydra-dev",
      dispatchId: "wt-new",
      startedAt: "2026-05-28T10:00:00.000Z",
    });
    const list = await listActiveSubagentDispatches();
    assert.equal(list.length, 2);
    assert.equal(list[0].sessionId, "sess-new");
    assert.equal(list[1].sessionId, "sess-old");
  });

  test("setSubagentDispatchStep patches currentStep without disturbing other fields", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-step",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
      currentStep: "initial",
    });
    await setSubagentDispatchStep("sess-step", "verifying");
    const got = await getSubagentDispatch("sess-step");
    assert.equal(got!.currentStep, "verifying");
    assert.equal(got!.skill, "hydra-dev");
  });

  test("re-registering the same sessionId is an idempotent overwrite (hook idempotency)", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-idem",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
    });
    await registerSubagentDispatch({
      sessionId: "sess-idem",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
    });
    const list = await listActiveSubagentDispatches();
    assert.equal(list.filter((d) => d.sessionId === "sess-idem").length, 1);
  });

  test("endSubagentDispatch removes both hash and index entry", async () => {
    await registerSubagentDispatch({
      sessionId: "sess-end",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T10:00:00.000Z",
    });
    await endSubagentDispatch("sess-end");
    const list = await listActiveSubagentDispatches();
    assert.equal(list.length, 0);
    assert.equal(await testRedis.exists(subagentDispatchKey("sess-end")), 0);
    assert.equal(await testRedis.zscore(subagentDispatchIndexKey(), "sess-end"), null);
  });

  test("endSubagentDispatch is idempotent on an unknown sessionId", async () => {
    await endSubagentDispatch("never-existed");
    const list = await listActiveSubagentDispatches();
    assert.deepEqual(list, []);
  });

  test("listActiveSubagentDispatches skips index entries whose hash expired", async () => {
    await testRedis.zadd(subagentDispatchIndexKey(), 1779789600, "orphan-sess");
    await registerSubagentDispatch({
      sessionId: "real-sess",
      skill: "hydra-dev",
      dispatchId: "wt-1",
      startedAt: "2026-05-28T11:00:00.000Z",
    });
    const list = await listActiveSubagentDispatches();
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, "real-sess");
  });
});

// ---------------------------------------------------------------------------
// Aggregator merge — subagent sub-source flows into the unified list
// ---------------------------------------------------------------------------

describe("getActiveDispatches — merges the subagent namespace", () => {
  test("subagent rows appear with source=subagent and skill as classLabel", async () => {
    const result = await getActiveDispatches({
      listAutopilotRunIds: async () => [],
      getAutopilotRunRow: async () => ({}),
      listOperatorDispatches: async () => [],
      listSubagentDispatches: async () => [
        {
          sessionId: "sess-agg",
          skill: "hydra-dev",
          dispatchId: "wt-1",
          startedAt: "2026-05-28T10:00:00.000Z",
          currentStep: "research",
          issueRef: "#692",
        },
      ],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "sess-agg");
    assert.equal(result[0].source, "subagent");
    assert.equal(result[0].classLabel, "hydra-dev");
    assert.equal(result[0].currentStep, "research");
    assert.equal(result[0].issueRef, "#692");
  });

  test("a failing subagent sub-source does not poison the other sources", async () => {
    const result = await getActiveDispatches({
      listAutopilotRunIds: async () => [],
      getAutopilotRunRow: async () => ({}),
      listOperatorDispatches: async () => [
        { id: "op-1", classLabel: "hydra-review", startedAt: "2026-05-28T09:00:00.000Z" },
      ],
      listSubagentDispatches: async () => {
        throw new Error("boom");
      },
    });
    // operator row still ships despite the subagent sub-source throwing.
    assert.equal(result.length, 1);
    assert.equal(result[0].source, "operator");
  });
});

// ---------------------------------------------------------------------------
// decide.py sentinel emission
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

describe("decide.py make_dispatch_sentinel", () => {
  function runPy(code: string): string {
    const r = spawnSync("python3", ["-c", code], { encoding: "utf8" });
    assert.equal(r.status, 0, `python exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  }

  // NOTE: `__file__` must be predefined — decide.py resolves its sibling
  // classes.json (the Dispatch-Class Taxonomy, issue #1670) relative to
  // `__file__` at import time, and a bare `python -c "exec(...)"` context
  // does not define it.
  test("emits a well-formed sentinel WITH runId", () => {
    const out = runPy(
      `import sys; sys.argv=['x']; __file__=${JSON.stringify(DECIDE)}; ` +
        `exec(open(${JSON.stringify(DECIDE)}).read().split("if __name__")[0]); ` +
        `print(make_dispatch_sentinel("hydra-dev", "wt-1", "run-9"))`,
    );
    assert.equal(out, "<!-- hydra-dispatch v1 skill=hydra-dev dispatchId=wt-1 runId=run-9 -->");
  });

  test("omits runId when not in an autopilot run", () => {
    const out = runPy(
      `__file__=${JSON.stringify(DECIDE)}; ` +
        `exec(open(${JSON.stringify(DECIDE)}).read().split("if __name__")[0]); ` +
        `print(make_dispatch_sentinel("hydra-grill", "wt-2", None))`,
    );
    assert.equal(out, "<!-- hydra-dispatch v1 skill=hydra-grill dispatchId=wt-2 -->");
  });
});

describe("decide.py stamps dispatchSentinel onto dispatch actions", () => {
  function runDecide(state: any, candidates: any, events: any[]): any {
    const dir = mkdtempSync(join(tmpdir(), "dispatches-sentinel-"));
    const sf = join(dir, "state.json");
    const cf = join(dir, "cands.json");
    const ef = join(dir, "events.json");
    writeFileSync(sf, JSON.stringify(state));
    writeFileSync(cf, JSON.stringify(candidates));
    writeFileSync(ef, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", sf, cf, ef], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, `decide.py exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  test("every dispatch action carries a dispatchSentinel matching its skill + worktreeBranch", () => {
    const plan = runDecide(
      {
        scope: "both",
        run_id: "abcdef12-3456-7890-abcd-ef1234567890",
        turn: 2,
        slots: {},
        cumulative_tokens: 0,
      },
      {
        dev_orch: { reference: "#692", confidence: 0.9, title: "build it" },
      },
      [],
    );
    const dispatches = (plan.actions || []).filter((a: any) => a.type === "dispatch");
    assert.ok(dispatches.length > 0, "expected at least one dispatch action");
    for (const d of dispatches) {
      assert.equal(typeof d.dispatchSentinel, "string");
      assert.match(d.dispatchSentinel, /^<!-- hydra-dispatch v1 skill=/);
      assert.ok(
        d.dispatchSentinel.includes(`skill=${d.skill}`),
        `sentinel should embed skill=${d.skill}: ${d.dispatchSentinel}`,
      );
      assert.ok(
        d.dispatchSentinel.includes(`dispatchId=${d.worktreeBranch}`),
        `sentinel should embed dispatchId=${d.worktreeBranch}: ${d.dispatchSentinel}`,
      );
      // run_id present in state -> runId present in sentinel.
      assert.match(d.dispatchSentinel, /runId=/);
    }
  });
});
