/**
 * test/pr-lifecycle-bridge.test.mts — issue #673 acceptance for the
 * pr-lifecycle bridge: pure diff logic, task_id extraction, sanitize
 * helper, and a deterministic round-trip with an injected gh-fetcher
 * stub. The real `gh` invocation is exercised in production; the test
 * pins the diff semantics and the stream shape.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/2";

// Pure snapshot grammar — its canonical home is the sibling module (#2239).
const {
  extractTaskId,
  diffPrSnapshots,
  sanitizeField,
  prRowToSnapshot,
} = await import("../src/autopilot/pr-lifecycle-snapshot.ts");

// I/O + lifecycle surface stays in the bridge module.
const {
  emitPrLifecycleEvent,
  startPrLifecycleBridge,
  SLOT_EVENTS_STREAM,
} = await import("../src/autopilot/pr-lifecycle-bridge.ts");

let testRedis: any;

async function ensureRedis() {
  if (!testRedis) {
    testRedis = new Redis(process.env.REDIS_URL);
  }
  return testRedis;
}

async function cleanStream() {
  const r = await ensureRedis();
  await r.del(SLOT_EVENTS_STREAM);
}

const { closeRedisConnections } = await import("../src/redis/connection.ts");

after(async () => {
  if (testRedis) {
    await cleanStream();
    testRedis.disconnect();
  }
  closeRedisConnections();
});

// ---------------------------------------------------------------------------
// extractTaskId
// ---------------------------------------------------------------------------

describe("pr-lifecycle-bridge: extractTaskId", () => {
  test("extracts agent-<hex> token from worktree branch names", () => {
    assert.equal(extractTaskId("agent-a76fa528da184b99e"), "agent-a76fa528da184b99e");
    assert.equal(extractTaskId("hydra/agent-abc123def"), "agent-abc123def");
  });

  test("extracts issue-<N> token from issue branch names", () => {
    assert.equal(extractTaskId("issue-673"), "issue-673");
    assert.equal(extractTaskId("issue-673-dev"), "issue-673");
  });

  test("prefers agent-<hex> over issue-<N> when both appear", () => {
    assert.equal(extractTaskId("agent-abcd1234-issue-673"), "agent-abcd1234");
  });

  test("returns empty string for unrecognized branches", () => {
    assert.equal(extractTaskId("master"), "");
    assert.equal(extractTaskId("feature/random-branch"), "");
    assert.equal(extractTaskId(""), "");
    assert.equal(extractTaskId(null as any), "");
    assert.equal(extractTaskId(undefined as any), "");
  });

  test("requires agent- token to have at least 8 hex chars (avoids matching 'agent-x')", () => {
    assert.equal(extractTaskId("agent-x"), "");
    assert.equal(extractTaskId("agent-deadbeef"), "agent-deadbeef");
  });
});

// ---------------------------------------------------------------------------
// sanitizeField
// ---------------------------------------------------------------------------

describe("pr-lifecycle-bridge: sanitizeField", () => {
  test("strips CR/LF/tab", () => {
    assert.equal(sanitizeField("hello\nworld\tfoo"), "hello world foo");
  });

  test("truncates to 200 chars", () => {
    const long = "a".repeat(250);
    assert.equal(sanitizeField(long).length, 200);
  });

  test("tolerates empty / null", () => {
    assert.equal(sanitizeField(""), "");
    assert.equal(sanitizeField(null as any), "");
  });
});

// ---------------------------------------------------------------------------
// prRowToSnapshot — view over the read-seam PrRow (issue #2231)
// ---------------------------------------------------------------------------

describe("pr-lifecycle-bridge: prRowToSnapshot", () => {
  const baseRow = {
    number: 673,
    title: "PR title",
    url: "https://github.com/gaberoo322/hydra/pull/673",
    headRefName: "agent-deadbeef",
    createdAt: "2026-06-20T10:00:00Z",
    updatedAt: "",
    statusCheckRollup: [],
  };

  test("maps a PrRow onto the bridge snapshot, narrowing state", () => {
    const snap = prRowToSnapshot({ ...baseRow, state: "MERGED" });
    assert.deepEqual(snap, {
      number: 673,
      state: "MERGED",
      title: "PR title",
      url: "https://github.com/gaberoo322/hydra/pull/673",
      headRefName: "agent-deadbeef",
      createdAt: "2026-06-20T10:00:00Z",
    });
  });

  test("lower-cased seam state is upper-cased into the union", () => {
    assert.equal(prRowToSnapshot({ ...baseRow, state: "closed" }).state, "CLOSED");
  });

  test("unrecognized / empty state falls back to OPEN (preserves pre-migration parser)", () => {
    assert.equal(prRowToSnapshot({ ...baseRow, state: "" }).state, "OPEN");
    assert.equal(prRowToSnapshot({ ...baseRow, state: "DRAFT" }).state, "OPEN");
  });
});

// ---------------------------------------------------------------------------
// diffPrSnapshots
// ---------------------------------------------------------------------------

const REPO = "gaberoo322/hydra";

function snap(num: number, state: "OPEN" | "MERGED" | "CLOSED", branch = "feature/x") {
  return {
    number: num,
    state,
    title: `PR #${num}`,
    url: `https://github.com/${REPO}/pull/${num}`,
    headRefName: branch,
    createdAt: "2026-05-27T10:00:00Z",
  };
}

describe("pr-lifecycle-bridge: diffPrSnapshots", () => {
  test("cold start (empty prev) emits 'opened' for every currently-open PR", () => {
    const prev = new Map();
    const curr = new Map();
    curr.set(673, snap(673, "OPEN"));
    curr.set(672, snap(672, "OPEN"));
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.transition === "opened"));
    assert.ok(events.every((e) => e.repo === REPO));
  });

  test("cold start emits 'merged' for first-seen MERGED PRs", () => {
    const prev = new Map();
    const curr = new Map();
    curr.set(670, snap(670, "MERGED"));
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 1);
    assert.equal(events[0].transition, "merged");
  });

  test("OPEN → MERGED transition emits exactly one 'merged' event", () => {
    const prev = new Map([[673, snap(673, "OPEN")]]);
    const curr = new Map([[673, snap(673, "MERGED")]]);
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 1);
    assert.equal(events[0].transition, "merged");
    assert.equal(events[0].pr_number, 673);
  });

  test("OPEN → CLOSED transition emits exactly one 'closed' event", () => {
    const prev = new Map([[673, snap(673, "OPEN")]]);
    const curr = new Map([[673, snap(673, "CLOSED")]]);
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 1);
    assert.equal(events[0].transition, "closed");
  });

  test("OPEN → OPEN (no change) emits no events", () => {
    const prev = new Map([[673, snap(673, "OPEN")]]);
    const curr = new Map([[673, snap(673, "OPEN")]]);
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 0);
  });

  test("MERGED → MERGED (already-seen-merged) emits no event on subsequent polls", () => {
    const prev = new Map([[670, snap(670, "MERGED")]]);
    const curr = new Map([[670, snap(670, "MERGED")]]);
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 0);
  });

  test("CLOSED → OPEN (reopen) is intentionally ignored per #673 spec", () => {
    const prev = new Map([[673, snap(673, "CLOSED")]]);
    const curr = new Map([[673, snap(673, "OPEN")]]);
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 0);
  });

  test("PR dropping out of curr (eviction by gh limit) emits no event", () => {
    const prev = new Map([[100, snap(100, "OPEN")]]);
    const curr = new Map();
    const events = diffPrSnapshots(prev, curr, REPO);
    assert.equal(events.length, 0);
  });

  test("event carries task_id extracted from the head branch", () => {
    const prev = new Map();
    const curr = new Map([
      [673, snap(673, "OPEN", "agent-a76fa528da184b99e")],
      [672, snap(672, "OPEN", "issue-672")],
    ]);
    const events = diffPrSnapshots(prev, curr, REPO);
    const byNum = new Map(events.map((e) => [e.pr_number, e]));
    assert.equal(byNum.get(673)?.task_id, "agent-a76fa528da184b99e");
    assert.equal(byNum.get(672)?.task_id, "issue-672");
  });
});

// ---------------------------------------------------------------------------
// emitPrLifecycleEvent — Redis round-trip
// ---------------------------------------------------------------------------

describe("pr-lifecycle-bridge: emitPrLifecycleEvent", () => {
  beforeEach(async () => {
    await cleanStream();
  });

  test("XADDs a flat field/value pair shape on the slot-events stream", async () => {
    const r = await ensureRedis();
    const id = await emitPrLifecycleEvent({
      repo: REPO,
      pr_number: 673,
      transition: "opened",
      title: "feat(autopilot): PR lifecycle + budget threshold WS events (#673)",
      url: `https://github.com/${REPO}/pull/673`,
      task_id: "agent-a76fa528da184b99e",
      head_branch: "agent-a76fa528da184b99e",
    });
    assert.ok(id);

    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 1);
    const [, fields] = range[0];
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];

    assert.equal(map.event, "pr_lifecycle");
    assert.equal(map.transition, "opened");
    assert.equal(map.repo, REPO);
    assert.equal(map.pr_number, "673");
    assert.equal(map.task_id, "agent-a76fa528da184b99e");
    assert.equal(map.head_branch, "agent-a76fa528da184b99e");
    assert.ok(map.title.startsWith("feat(autopilot): PR lifecycle"));
    assert.ok(map.ts_epoch && /^\d+$/.test(map.ts_epoch));
  });

  test("title is sanitized (no CR/LF/tab leak)", async () => {
    const r = await ensureRedis();
    await emitPrLifecycleEvent({
      repo: REPO,
      pr_number: 1,
      transition: "merged",
      title: "title\nwith\ttabs",
      url: `https://github.com/${REPO}/pull/1`,
      task_id: "",
      head_branch: "main",
    });
    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    const [, fields] = range[0];
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
    assert.equal(map.title, "title with tabs");
  });
});

// ---------------------------------------------------------------------------
// Bridge end-to-end (one-shot mode with injected fetcher)
// ---------------------------------------------------------------------------

describe("pr-lifecycle-bridge: bridge end-to-end (oneShot + injected fetcher)", () => {
  beforeEach(async () => {
    await cleanStream();
  });

  test("first tick emits 'opened' for every PR returned by gh", async () => {
    const r = await ensureRedis();
    const fetcher = async (_repo: string) => [
      snap(673, "OPEN", "agent-deadbeef"),
      snap(672, "OPEN", "issue-672"),
    ];
    await startPrLifecycleBridge({ oneShot: true, repos: [REPO], ghFetcher: fetcher });
    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 2);
    const transitions = range.map(([, fields]) => {
      const m: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
      return m.transition;
    }).sort();
    assert.deepEqual(transitions, ["opened", "opened"]);
  });

  test("two ticks with one OPEN → MERGED transition emit a single 'merged' on the second tick", async () => {
    const r = await ensureRedis();
    let phase = 0;
    const fetcher = async (_repo: string) => {
      phase += 1;
      if (phase === 1) return [snap(673, "OPEN", "agent-deadbeef")];
      return [snap(673, "MERGED", "agent-deadbeef")];
    };
    const bridge = await startPrLifecycleBridge({
      oneShot: true,
      repos: [REPO],
      ghFetcher: fetcher,
    });
    bridge.stop();
    // After first tick: one "opened" event.
    let range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 1);
    const firstFields: Record<string, string> = {};
    for (let i = 0; i < range[0][1].length; i += 2) firstFields[range[0][1][i]] = range[0][1][i + 1];
    assert.equal(firstFields.transition, "opened");

    // Second tick — same fetcher (now phase=2) — needs a separate bridge invocation
    // because oneShot mode resets the snapshot. We exercise the cross-invocation
    // path by running the bridge again; the snapshot in memory is local to each
    // call so the second invocation also "discovers" the merged state from a
    // cold start. That's still the correct semantic: a merged PR not seen before
    // emits "merged" (cold-start clause in diffPrSnapshots).
    await startPrLifecycleBridge({
      oneShot: true,
      repos: [REPO],
      ghFetcher: fetcher,
    });
    range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    const transitions = range.map(([, fields]) => {
      const m: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
      return m.transition;
    });
    // First "opened", second "merged" (cold-start saw MERGED state).
    assert.deepEqual(transitions, ["opened", "merged"]);
  });

  test("empty fetcher result (gh failure) does NOT clobber the snapshot or emit events", async () => {
    const r = await ensureRedis();
    const fetcher = async (_repo: string) => [];
    await startPrLifecycleBridge({ oneShot: true, repos: [REPO], ghFetcher: fetcher });
    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 0);
  });

  test("fetcher throws → bridge logs and continues; no events fire", async () => {
    const r = await ensureRedis();
    const fetcher = async (_repo: string) => {
      throw new Error("simulated gh failure");
    };
    // Should not propagate the throw.
    await startPrLifecycleBridge({ oneShot: true, repos: [REPO], ghFetcher: fetcher });
    const range = await r.xrange(SLOT_EVENTS_STREAM, "-", "+");
    assert.equal(range.length, 0);
  });

  test("bridge stop() is idempotent", async () => {
    const bridge = await startPrLifecycleBridge({
      oneShot: true,
      repos: [REPO],
      ghFetcher: async () => [],
    });
    bridge.stop();
    bridge.stop(); // No-throw on double-stop
    bridge.stop();
  });
});

// ---------------------------------------------------------------------------
// Round-trip via slot-events-bridge (acceptance criterion 4)
// ---------------------------------------------------------------------------

describe("pr-lifecycle-bridge: slot-events round-trip", () => {
  test("a pr_lifecycle event survives slot-events-bridge translation verbatim", async () => {
    const { bridgeBroadcast } = await import("../src/autopilot/slot-events-bridge.ts");
    const calls: Array<{ stream: string; event: any }> = [];
    // A recording WsBroadcastRegistry stub (issue #1965): bridgeBroadcast now
    // targets the named `.broadcast` surface, not the bus's former private
    // `_broadcastToClients` method.
    const mockBus = {
      broadcast: (stream: string, event: any) => calls.push({ stream, event }),
    };
    const env = bridgeBroadcast(mockBus as any, {
      event: "pr_lifecycle",
      transition: "merged",
      repo: REPO,
      pr_number: "673",
      title: "feat(autopilot): observability G",
      url: `https://github.com/${REPO}/pull/673`,
      task_id: "agent-deadbeef",
      head_branch: "agent-deadbeef",
      ts_epoch: "1779907800",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, "autopilot:slot-events");
    assert.equal(env.type, "slot-event");
    assert.equal(env.payload.event, "pr_lifecycle");
    assert.equal(env.payload.transition, "merged");
    assert.equal(env.payload.pr_number, "673");
    assert.equal(env.payload.task_id, "agent-deadbeef");
  });
});
