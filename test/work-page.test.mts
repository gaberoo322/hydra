/**
 * Regression tests for the /work page's server surfaces (issue #4010,
 * ADR-0034 §3/§5/§7 — "what is queued, what is next, and why that").
 *
 * Layers:
 *   1. Schemas — ready-queue rows, action bodies/results, the relabel-target
 *      vocabulary (ready-for-agent must NOT be a relabel target).
 *   2. `deriveReadyQueue` — the pure why-annotation projection, plus the
 *      DRIFT GUARD against `deriveBoardState`'s `ready_for_agent` count
 *      (the queue's `excluded === null` rows must equal the count exactly).
 *   3. GET /autopilot/board-state trust fields (INV-2/INV-3) — additive
 *      `sourcesOk` + `ready_queue` on success; empty queue + `sourcesOk:false`
 *      on a degraded read (never a confident zero).
 *   4. GET /metrics/anchor-distribution boundary stamps (INV-4) —
 *      `generatedAt` + `sourcesOk` stamped at the HTTP boundary, NOT inside
 *      the pure `projectAnchorDistribution` projection.
 *   5. The four issue-lifecycle action routes (INV-5/INV-6/INV-7) — promote's
 *      confirm step + the two refusal guards; relabel/close/reopen immediate
 *      + verified; write/verify failure folding.
 *   6. The `src/github/issue-actions.ts` leaf — `gh issue` argv pinning via
 *      injected transports (never a real `gh`, INV-7).
 *   7. `src/scope-section.ts` — the relocated "Files in scope" parser still
 *      behaves (full matrix stays pinned by test/ci-scope-check.test.mts,
 *      which now exercises the same code through the re-export).
 *
 * Follows the test/autopilot-board.test.mts router-harness pattern: handlers
 * called directly with mockReq/mockRes, every I/O dep injected. No live
 * Express server, no real `gh`, no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createAutopilotBoardRouter,
  deriveReadyQueue,
  type AutopilotBoardRouterDeps,
} from "../src/api/autopilot-board.ts";
import { createMetricsRouter } from "../src/api/metrics.ts";
import { projectAnchorDistribution } from "../src/metrics/stats-projection.ts";
import {
  removeIssueLabel,
  closeIssue,
  reopenIssue,
  viewIssueRow,
  type IssueActionTransport,
  type IssueViewTransport,
} from "../src/github/issue-actions.ts";
import { deriveBoardState } from "../src/autopilot/board-state.ts";
import {
  AutopilotBoardStateResponseSchema,
  ReadyQueueRowSchema,
  RelabelActionBodySchema,
  PromoteActionBodySchema,
  BoardActionResultSchema,
  RELABEL_TARGET_LABELS,
} from "../src/schemas/autopilot-board.ts";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";
import { extractScopeFromBody, extractOutOfScopeFromBody } from "../src/scope-section.ts";
import type { IssueRow, IssueReadResult } from "../src/github/issues.ts";

// ---------------------------------------------------------------------------
// Fixtures + harness (mirrors test/autopilot-board.test.mts)
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-03T12:00:00.000Z");

/** Build an IssueRow with sane defaults; override what the case cares about. */
function row(partial: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: partial.number,
    title: partial.title ?? `Issue #${partial.number}`,
    url: partial.url ?? `https://github.com/x/y/issues/${partial.number}`,
    createdAt: partial.createdAt ?? "",
    labels: partial.labels ?? [],
    body: partial.body ?? "",
    state: partial.state ?? "OPEN",
    updatedAt: partial.updatedAt ?? "",
  };
}

function okResult(rows: IssueRow[]): IssueReadResult<IssueRow> {
  return { ok: true, rows };
}

function mockReq(req: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query: {}, params: {}, body: {}, ...req };
}
function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}
function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

async function callGet(deps: AutopilotBoardRouterDeps = {}, query: Record<string, unknown> = {}) {
  const router = createAutopilotBoardRouter({
    now: () => NOW_MS,
    glmDrainerLiveness: async () => false,
    readOpenIssues: async () => okResult([]),
    ...deps,
  });
  const handler = findHandler(router, "GET", "/autopilot/board-state");
  assert.ok(handler, "GET handler must exist");
  const res = mockRes();
  await handler!(mockReq({ query }), res);
  return res;
}

async function callAction(
  path: string,
  deps: AutopilotBoardRouterDeps,
  body: unknown,
): Promise<any> {
  const router = createAutopilotBoardRouter({
    now: () => NOW_MS,
    glmDrainerLiveness: async () => false,
    readOpenIssues: async () => okResult([]),
    ...deps,
  });
  const handler = findHandler(router, "POST", path);
  assert.ok(handler, `POST ${path} handler must exist`);
  const res = mockRes();
  await handler!(mockReq({ method: "POST", body }), res);
  return res;
}

const BODY_WITH_SCOPE = "## Files in scope\n\n- `src/foo.ts`\n- `test/foo.test.mts`\n";

// ---------------------------------------------------------------------------
// 1. Schemas
// ---------------------------------------------------------------------------

describe("work page — schemas (issue #4010)", () => {
  test("RELABEL_TARGET_LABELS covers the five orch lanes but NOT ready-for-agent", () => {
    assert.deepEqual([...RELABEL_TARGET_LABELS].sort(), [
      ORCH_BOARD_LABELS.blocked,
      ORCH_BOARD_LABELS.in_progress,
      ORCH_BOARD_LABELS.needs_qa,
      ORCH_BOARD_LABELS.needs_research,
      ORCH_BOARD_LABELS.needs_triage,
    ]);
    // `as any`: includes() types its arg as the tuple's member union; the
    // assertion is exactly that ready-for-agent is NOT a member.
    assert.ok(!RELABEL_TARGET_LABELS.includes(ORCH_BOARD_LABELS.ready_for_agent as any));
  });

  test("RelabelActionBodySchema refuses ready-for-agent (promote is the only route onto it)", () => {
    assert.equal(
      // `as any`: the literal is DELIBERATELY off-enum — zod v4 types
      // safeParse's input as the schema input, and the whole point here is
      // that the runtime parse refuses it.
      RelabelActionBodySchema.safeParse({ issue: 5, label: "ready-for-agent" as any }).success,
      false,
    );
    assert.equal(
      RelabelActionBodySchema.safeParse({ issue: 5, label: "blocked" }).success,
      true,
    );
  });

  test("PromoteActionBodySchema is strict — extra keys and a missing confirm both fail", () => {
    assert.equal(PromoteActionBodySchema.safeParse({ issue: 5, confirm: true }).success, true);
    assert.equal(
      PromoteActionBodySchema.safeParse({ issue: 5, confirm: true, force: true }).success,
      false,
    );
    assert.equal(PromoteActionBodySchema.safeParse({ issue: 5 }).success, false);
  });

  test("ReadyQueueRowSchema accepts a dispatchable and an excluded row; rejects extras", () => {
    const dispatchable = {
      number: 2,
      title: "t",
      url: "https://x",
      updatedAt: "",
      excluded: null,
      blockedBy: [],
    };
    const excluded = {
      number: 3,
      title: "t",
      url: "https://x",
      updatedAt: "2026-06-03T00:00:00.000Z",
      excluded: "blocked-by-open-issue",
      blockedBy: [99],
    };
    assert.equal(ReadyQueueRowSchema.safeParse(dispatchable).success, true);
    assert.equal(ReadyQueueRowSchema.safeParse(excluded).success, true);
    assert.equal(
      ReadyQueueRowSchema.safeParse({ ...excluded, why: "because" }).success,
      false,
    );
    assert.equal(
      ReadyQueueRowSchema.safeParse({ ...excluded, excluded: "some-new-reason" }).success,
      false,
    );
  });

  test("BoardActionResultSchema accepts the ok + refusal envelopes; rejects unknown actions", () => {
    assert.equal(
      BoardActionResultSchema.safeParse({
        ok: true,
        action: "promote",
        issue: 5,
        verified: { number: 5, state: "OPEN", labels: ["ready-for-agent"], url: "https://x" },
      }).success,
      true,
    );
    assert.equal(
      BoardActionResultSchema.safeParse({
        ok: false,
        action: "promote",
        issue: 5,
        reason: "blocked-by-open-issue",
        detail: "open strict blocker(s): #100",
      }).success,
      true,
    );
    assert.equal(
      BoardActionResultSchema.safeParse({ ok: false, action: "delete", issue: 5 }).success,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. deriveReadyQueue — pure projection + drift guard
// ---------------------------------------------------------------------------

describe("work page — deriveReadyQueue (issue #4010, INV-1)", () => {
  const mixedRows: IssueRow[] = [
    row({ number: 5, labels: [ORCH_BOARD_LABELS.ready_for_agent], body: "Depends on #99" }),
    row({ number: 2, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
    row({
      number: 3,
      labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.target_backlog],
    }),
    row({
      number: 4,
      labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.glm_eligible],
    }),
    row({ number: 6, labels: [ORCH_BOARD_LABELS.needs_qa] }),
  ];

  test("annotates every ready row with its exclusion reason; skips non-ready rows", () => {
    const queue = deriveReadyQueue(mixedRows, new Set([99]), true);
    assert.deepEqual(
      queue.map((r) => r.number),
      [2, 3, 4, 5],
    );
    assert.deepEqual(
      queue.map((r) => r.excluded),
      [null, "target-backlog", "glm-eligible-drainer-live", "blocked-by-open-issue"],
    );
    assert.deepEqual(queue[3].blockedBy, [99]);
    // blockedBy is populated ONLY on the blocked row — never on other excludes.
    assert.deepEqual(queue[1].blockedBy, []);
    assert.deepEqual(queue[2].blockedBy, []);
  });

  test("DRIFT GUARD — dispatchable rows equal deriveBoardState's ready_for_agent count", () => {
    for (const glmActive of [false, true]) {
      for (const blockers of [new Set<number>(), new Set([99])]) {
        const queue = deriveReadyQueue(mixedRows, blockers, glmActive);
        const counts = deriveBoardState(mixedRows, NOW_MS, blockers, glmActive);
        assert.equal(
          queue.filter((r) => r.excluded === null).length,
          counts.ready_for_agent,
          `glm=${glmActive} blockers=${blockers.size}`,
        );
      }
    }
  });

  test("drainer-down (partition inactive) lifts the glm-eligible exclusion", () => {
    const queue = deriveReadyQueue(mixedRows, new Set([99]), false);
    const r4 = queue.find((r) => r.number === 4);
    assert.equal(r4?.excluded, null);
  });

  test("missing updatedAt renders as \"\" (age unknown), never a fabricated timestamp", () => {
    const queue = deriveReadyQueue(
      [row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] })],
      new Set(),
      false,
    );
    assert.equal(queue[0].updatedAt, "");
  });
});

// ---------------------------------------------------------------------------
// 3. GET /autopilot/board-state — trust fields (INV-2/INV-3)
// ---------------------------------------------------------------------------

describe("work page — GET /autopilot/board-state trust fields (issue #4010)", () => {
  test("emits sourcesOk:true + ready_queue with why-annotations; validates against the schema", async () => {
    const res = await callGet({
      glmDrainerLiveness: async () => true,
      readOpenIssues: async () =>
        okResult([
          row({ number: 2, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
          row({
            number: 3,
            labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.target_backlog],
          }),
          row({
            number: 4,
            labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.glm_eligible],
          }),
          row({
            number: 5,
            labels: [ORCH_BOARD_LABELS.ready_for_agent],
            body: "Blocked by #99",
          }),
          row({ number: 6, labels: [ORCH_BOARD_LABELS.needs_qa] }),
        ]),
      resolveOpenBlockers: async () => new Set([99]),
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, false);
    assert.equal(res._body.sourcesOk, true);
    // The count and the queue agree (drift guard, at the route boundary).
    assert.equal(res._body.ready_for_agent, 1);
    assert.equal(res._body.ready_queue.filter((r: any) => r.excluded === null).length, 1);
    assert.equal(res._body.ready_queue.length, 4);
    const byNumber = (n: number) =>
      res._body.ready_queue.find((r: any) => r.number === n);
    assert.equal(byNumber(3).excluded, "target-backlog");
    assert.equal(byNumber(4).excluded, "glm-eligible-drainer-live");
    assert.equal(byNumber(5).excluded, "blocked-by-open-issue");
    assert.deepEqual(byNumber(5).blockedBy, [99]);
    assert.equal(byNumber(6), undefined, "non-ready rows never appear in the queue");
    AutopilotBoardStateResponseSchema.parse(res._body);
    for (const r of res._body.ready_queue) ReadyQueueRowSchema.parse(r);
  });

  test("degraded read → sourcesOk:false + EMPTY queue (never a confident zero)", async () => {
    const res = await callGet({
      readOpenIssues: async () => ({ ok: false, code: "gh-failed" } as IssueReadResult<IssueRow>),
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.sourcesOk, false);
    assert.deepEqual(res._body.ready_queue, []);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });
});

// ---------------------------------------------------------------------------
// 4. GET /metrics/anchor-distribution — boundary stamps (INV-4)
// ---------------------------------------------------------------------------

describe("work page — GET /metrics/anchor-distribution stamps (issue #4010, INV-4)", () => {
  const trend = [{ anchorType: "kanban" }, { anchorType: "kanban" }, { anchorType: "health" }];

  async function callAnchorDist(deps: Parameters<typeof createMetricsRouter>[0]) {
    const router = createMetricsRouter(deps);
    const handler = findHandler(router, "GET", "/metrics/anchor-distribution");
    assert.ok(handler, "anchor-distribution handler must exist");
    const res = mockRes();
    await handler!(mockReq({ query: {} }), res);
    return res;
  }

  test("stamps generatedAt from the injected clock + sourcesOk:true on a clean read", async () => {
    const res = await callAnchorDist({
      readMetricsTrend: async () => trend,
      now: () => NOW_MS,
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, true);
    assert.equal(res._body.generatedAt, new Date(NOW_MS).toISOString());
    assert.equal(res._body.windowCycles, 3);
    assert.equal(Array.isArray(res._body.distribution), true);
  });

  test("a failed trend read degrades to sourcesOk:false — still 200, still stamped", async () => {
    const res = await callAnchorDist({
      readMetricsTrend: async () => {
        throw new Error("redis down");
      },
      now: () => NOW_MS,
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, false);
    assert.equal(res._body.generatedAt, new Date(NOW_MS).toISOString());
    // The zeroed distribution is still present — the trust contract (the
    // dashboard's UNKNOWN rendering) rides sourcesOk, not a missing body.
    assert.equal(res._body.windowCycles, 0);
  });

  test("the PURE projection carries no stamp — generatedAt lives only at the boundary", () => {
    const projection = projectAnchorDistribution(trend);
    assert.ok(!("generatedAt" in projection));
    assert.ok(!("sourcesOk" in projection));
  });
});

// ---------------------------------------------------------------------------
// 5. Action routes (INV-5/INV-6/INV-7)
// ---------------------------------------------------------------------------

/** Recording write primitives for the action-route cases. */
function recordingWrites(
  overrides: {
    add?: (n: number, label: string) => Promise<{ ok: true } | { ok: false; code: string; stderr: string }>;
    remove?: (n: number, label: string) => Promise<{ ok: true } | { ok: false; code: string; stderr: string }>;
    close?: (n: number) => Promise<{ ok: true } | { ok: false; code: string; stderr: string }>;
    reopen?: (n: number) => Promise<{ ok: true } | { ok: false; code: string; stderr: string }>;
  } = {},
) {
  const calls: {
    add: [number, string][];
    remove: [number, string][];
    close: number[];
    reopen: number[];
  } = { add: [], remove: [], close: [], reopen: [] };
  const ok = async () => ({ ok: true } as const);
  const deps = {
    addLabel:
      overrides.add ??
      (async (n: number, label: string) => {
        calls.add.push([n, label]);
        return ok();
      }),
    removeLabel:
      overrides.remove ??
      (async (n: number, label: string) => {
        calls.remove.push([n, label]);
        return ok();
      }),
    closeIssue:
      overrides.close ??
      (async (n: number) => {
        calls.close.push(n);
        return ok();
      }),
    reopenIssue:
      overrides.reopen ??
      (async (n: number) => {
        calls.reopen.push(n);
        return ok();
      }),
  };
  return { calls, deps: deps as AutopilotBoardRouterDeps };
}

describe("work page — POST /autopilot/board-state/promote (issue #4010, INV-5)", () => {
  test("confirm absent → confirm-required; no read, no write happens", async () => {
    const w = recordingWrites();
    let reads = 0;
    const res = await callAction(
      "/autopilot/board-state/promote",
      {
        ...w.deps,
        viewIssue: async () => {
          reads++;
          return null;
        },
      },
      { issue: 7, confirm: false },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "confirm-required");
    assert.equal(reads, 0);
    assert.equal(w.calls.add.length + w.calls.remove.length, 0);
    BoardActionResultSchema.parse(res._body);
  });

  test("open strict blocker → blocked-by-open-issue naming the blocker numbers", async () => {
    let resolverRows: readonly IssueRow[] | null = null;
    const res = await callAction(
      "/autopilot/board-state/promote",
      {
        viewIssue: async () =>
          row({ number: 7, labels: [ORCH_BOARD_LABELS.needs_triage], body: "Blocked by #100" }),
        resolveOpenBlockers: async (rows) => {
          resolverRows = rows;
          return new Set([100]);
        },
        ...(recordingWrites().deps),
      },
      { issue: 7, confirm: true },
    );
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "blocked-by-open-issue");
    assert.match(res._body.detail, /#100/);
    // The resolver saw the row with ready-for-agent SYNTHESIZED on — the
    // count path's own resolver answers for the would-be-promoted row.
    assert.ok(
      resolverRows![0].labels.includes(ORCH_BOARD_LABELS.ready_for_agent),
      "resolver row carries the synthesized ready-for-agent label",
    );
  });

  test("closed blocker does not refuse; missing '## Files in scope' does", async () => {
    const missingScope = await callAction(
      "/autopilot/board-state/promote",
      {
        viewIssue: async () =>
          row({
            number: 7,
            labels: [ORCH_BOARD_LABELS.needs_triage],
            body: "Blocked by #100\n\n## Risk\nnone", // blocker CLOSED + no scope section
          }),
        resolveOpenBlockers: async () => new Set(),
        ...(recordingWrites().deps),
      },
      { issue: 7, confirm: true },
    );
    assert.equal(missingScope._body.reason, "missing-files-in-scope");
    assert.match(missingScope._body.detail, /Files in scope/);
  });

  test("happy path — clears promote-source lanes, then verifies off the RE-READ state", async () => {
    const w = recordingWrites();
    const pre = row({
      number: 7,
      labels: [ORCH_BOARD_LABELS.needs_triage],
      body: BODY_WITH_SCOPE,
    });
    const post = row({ number: 7, labels: [ORCH_BOARD_LABELS.ready_for_agent] });
    const reads: number[] = [];
    const res = await callAction(
      "/autopilot/board-state/promote",
      {
        ...w.deps,
        viewIssue: async (n: number) => {
          reads.push(n);
          return reads.length === 1 ? pre : post;
        },
        resolveOpenBlockers: async () => new Set(),
      },
      { issue: 7, confirm: true },
    );
    assert.equal(res._body.ok, true);
    assert.deepEqual(w.calls.add, [[7, ORCH_BOARD_LABELS.ready_for_agent]]);
    assert.deepEqual(w.calls.remove, [[7, ORCH_BOARD_LABELS.needs_triage]]);
    // INV-6: success renders from the verified post-write re-read, which
    // happened (two reads: guard pre-read + verification re-read).
    assert.equal(reads.length, 2);
    assert.equal(res._body.verified.number, 7);
    assert.deepEqual(res._body.verified.labels, [ORCH_BOARD_LABELS.ready_for_agent]);
    BoardActionResultSchema.parse(res._body);
  });

  test("unreachable issue → issue-read-failed (absent vs gh-down indistinguishable at the seam)", async () => {
    const res = await callAction(
      "/autopilot/board-state/promote",
      { viewIssue: async () => null, ...(recordingWrites().deps) },
      { issue: 424242, confirm: true },
    );
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "issue-read-failed");
    assert.match(res._body.detail, /#424242/);
  });

  test("write failure folds to write-failed with the seam code (still 200, never 500)", async () => {
    const w = recordingWrites({
      add: async () => ({ ok: false, code: "gh-failed", stderr: "boom" }),
    });
    const res = await callAction(
      "/autopilot/board-state/promote",
      {
        ...w.deps,
        viewIssue: async () =>
          row({ number: 7, labels: [ORCH_BOARD_LABELS.needs_triage], body: BODY_WITH_SCOPE }),
        resolveOpenBlockers: async () => new Set(),
      },
      { issue: 7, confirm: true },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "write-failed");
    assert.match(res._body.detail, /gh-failed/);
  });

  test("post-write state disagrees → verify-failed (no unverified success)", async () => {
    const stuck = row({
      number: 7,
      labels: [ORCH_BOARD_LABELS.needs_triage],
      body: BODY_WITH_SCOPE,
    });
    const res = await callAction(
      "/autopilot/board-state/promote",
      {
        ...(recordingWrites().deps),
        viewIssue: async () => stuck,
        resolveOpenBlockers: async () => new Set(),
      },
      { issue: 7, confirm: true },
    );
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "verify-failed");
  });

  test("malformed body → 400 schema-validation-failed", async () => {
    const res = await callAction(
      "/autopilot/board-state/promote",
      recordingWrites().deps,
      { issue: -1, confirm: true },
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

describe("work page — POST /autopilot/board-state/relabel (issue #4010, INV-6)", () => {
  test("lane move clears every other orch lane, adds the target, verifies", async () => {
    const w = recordingWrites();
    const pre = row({
      number: 8,
      labels: [ORCH_BOARD_LABELS.in_progress, ORCH_BOARD_LABELS.needs_qa],
    });
    const post = row({ number: 8, labels: [ORCH_BOARD_LABELS.blocked] });
    let reads = 0;
    const res = await callAction(
      "/autopilot/board-state/relabel",
      {
        ...w.deps,
        viewIssue: async () => {
          reads++;
          return reads === 1 ? pre : post;
        },
      },
      { issue: 8, label: ORCH_BOARD_LABELS.blocked },
    );
    assert.equal(res._body.ok, true);
    assert.deepEqual([...w.calls.remove].sort(), [
      [8, ORCH_BOARD_LABELS.in_progress],
      [8, ORCH_BOARD_LABELS.needs_qa],
    ]);
    assert.deepEqual(w.calls.add, [[8, ORCH_BOARD_LABELS.blocked]]);
    assert.deepEqual(res._body.verified.labels, [ORCH_BOARD_LABELS.blocked]);
    BoardActionResultSchema.parse(res._body);
  });

  test("already on the target lane → zero writes, still verified", async () => {
    const w = recordingWrites();
    const same = row({ number: 8, labels: [ORCH_BOARD_LABELS.blocked] });
    const res = await callAction(
      "/autopilot/board-state/relabel",
      { ...w.deps, viewIssue: async () => same },
      { issue: 8, label: ORCH_BOARD_LABELS.blocked },
    );
    assert.equal(res._body.ok, true);
    assert.equal(w.calls.add.length + w.calls.remove.length, 0);
  });

  test("ready-for-agent as the target is a 400 — promote is the only route onto it", async () => {
    const res = await callAction(
      "/autopilot/board-state/relabel",
      recordingWrites().deps,
      { issue: 8, label: ORCH_BOARD_LABELS.ready_for_agent },
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

describe("work page — POST close / reopen (issue #4010, INV-6/INV-7)", () => {
  test("close verifies state CLOSED off the re-read", async () => {
    const w = recordingWrites();
    // close does no guard pre-read — the FIRST viewIssue call is the
    // post-write verification read, so it already serves the closed state.
    const reads: number[] = [];
    const res = await callAction(
      "/autopilot/board-state/close",
      {
        ...w.deps,
        viewIssue: async (n: number) => {
          reads.push(n);
          return row({ number: n, state: "CLOSED", labels: [] });
        },
      },
      { issue: 9 },
    );
    assert.equal(res._body.ok, true);
    assert.deepEqual(w.calls.close, [9]);
    assert.deepEqual(reads, [9]);
    assert.equal(res._body.verified.state, "CLOSED");
  });

  test("reopen verifies state OPEN", async () => {
    const w = recordingWrites();
    const res = await callAction(
      "/autopilot/board-state/reopen",
      {
        ...w.deps,
        viewIssue: async (n: number) =>
          row({ number: n, state: "OPEN", labels: [ORCH_BOARD_LABELS.needs_triage] }),
      },
      { issue: 9 },
    );
    assert.equal(res._body.ok, true);
    assert.deepEqual(w.calls.reopen, [9]);
    assert.equal(res._body.verified.state, "OPEN");
    assert.deepEqual(res._body.verified.labels, [ORCH_BOARD_LABELS.needs_triage]);
  });

  test("write failure → write-failed; verify mismatch → verify-failed (both 200)", async () => {
    const fail = await callAction(
      "/autopilot/board-state/close",
      recordingWrites({ close: async () => ({ ok: false, code: "gh-failed", stderr: "x" }) }).deps,
      { issue: 9 },
    );
    assert.equal(fail._body.reason, "write-failed");

    // Write "succeeded" but the re-read still says OPEN.
    const mismatch = await callAction(
      "/autopilot/board-state/close",
      { ...(recordingWrites().deps), viewIssue: async () => row({ number: 9, state: "OPEN" }) },
      { issue: 9 },
    );
    assert.equal(mismatch._body.reason, "verify-failed");
  });
});

// ---------------------------------------------------------------------------
// 6. src/github/issue-actions.ts — argv pinning (INV-7)
// ---------------------------------------------------------------------------

describe("work page — issue-actions leaf argv (issue #4010, INV-7)", () => {
  const REPO = "gaberoo322/hydra";

  function captureTransport(
    result:
      | { ok: true; data: { stdout: string; stderr: string } }
      | { ok: false; code: string; stderr: string },
  ) {
    const calls: { args: string[]; opts: any }[] = [];
    const transport: IssueActionTransport = async (args, opts) => {
      calls.push({ args, opts });
      return result as any;
    };
    return { calls, transport };
  }

  test("removeIssueLabel rides `gh issue edit --remove-label` — never `gh pr edit`", async () => {
    const { calls, transport } = captureTransport({ ok: true, data: { stdout: "", stderr: "" } });
    const res = await removeIssueLabel(7, "needs-triage", { repo: REPO, transport });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(calls[0].args, [
      "issue",
      "edit",
      "7",
      "--repo",
      REPO,
      "--remove-label",
      "needs-triage",
    ]);
    assert.ok(!calls[0].args.includes("pr"), "never a gh pr subcommand");
  });

  test("closeIssue / reopenIssue ride the canonical state subcommands", async () => {
    const closeCap = captureTransport({ ok: true, data: { stdout: "", stderr: "" } });
    await closeIssue(9, { repo: REPO, transport: closeCap.transport });
    assert.deepEqual(closeCap.calls[0].args, ["issue", "close", "9", "--repo", REPO]);

    const reopenCap = captureTransport({ ok: true, data: { stdout: "", stderr: "" } });
    await reopenIssue(9, { repo: REPO, transport: reopenCap.transport });
    assert.deepEqual(reopenCap.calls[0].args, ["issue", "reopen", "9", "--repo", REPO]);
  });

  test("a gh failure returns the discriminated result — NEVER throws", async () => {
    const { transport } = captureTransport({ ok: false, code: "gh-failed", stderr: "boom" });
    const res = await removeIssueLabel(7, "needs-triage", { repo: REPO, transport });
    assert.deepEqual(res, { ok: false, code: "gh-failed", stderr: "boom" });
  });

  test("an empty repo resolution skips the write entirely (skip-guard, mirrors addIssueLabel)", async () => {
    const { calls, transport } = captureTransport({ ok: true, data: { stdout: "", stderr: "" } });
    const res = await removeIssueLabel(7, "needs-triage", { repo: "", transport });
    assert.deepEqual(res, { ok: true });
    assert.equal(calls.length, 0);
  });

  test("viewIssueRow reads `gh issue view --json`, parses through the seam, flattens {name} labels", async () => {
    const calls: { args: string[] }[] = [];
    const read: IssueViewTransport = async (args) => {
      calls.push({ args });
      return {
        ok: true,
        data: {
          number: 7,
          title: "t",
          url: "https://x/7",
          createdAt: "2026-01-01T00:00:00Z",
          labels: [{ name: "needs-triage" }],
          body: "b",
          state: "OPEN",
          updatedAt: "2026-06-01T00:00:00Z",
        },
      } as any;
    };
    const out = await viewIssueRow(7, { repo: REPO, readTransport: read });
    assert.ok(out);
    assert.equal(out.number, 7);
    assert.deepEqual(out.labels, ["needs-triage"]);
    assert.deepEqual(calls[0].args, [
      "issue",
      "view",
      "7",
      "--repo",
      REPO,
      "--json",
      "number,title,url,createdAt,labels,body,state,updatedAt",
    ]);
  });

  test("viewIssueRow returns null on ANY failure — never an asserted empty state", async () => {
    const failing: IssueViewTransport = async () =>
      ({ ok: false, code: "gh-failed", stderr: "no such issue" }) as any;
    assert.equal(await viewIssueRow(7, { repo: REPO, readTransport: failing }), null);

    // Malformed payload (not a single parseable row) → null too.
    const garbage: IssueViewTransport = async () => ({ ok: true, data: 42 }) as any;
    assert.equal(await viewIssueRow(7, { repo: REPO, readTransport: garbage }), null);
  });
});

// ---------------------------------------------------------------------------
// 7. src/scope-section.ts — the relocated parser (INV-5)
// ---------------------------------------------------------------------------

describe("work page — scope-section relocation (issue #4010, INV-5)", () => {
  test("extractScopeFromBody reads code-spans AND plain bullets; absent section → []", () => {
    const body = [
      "## Files in scope",
      "",
      "- `src/a.ts`",
      "- test/b.test.mts",
      "",
      "## Files out of scope",
      "",
      "- `src/b.ts`",
    ].join("\n");
    assert.deepEqual(extractScopeFromBody(body), ["src/a.ts", "test/b.test.mts"]);
    assert.deepEqual(extractOutOfScopeFromBody(body), ["src/b.ts"]);
    assert.deepEqual(extractScopeFromBody("no sections here"), []);
  });

  test("the promote-refusal signal is exactly 'section present with path entries'", () => {
    // A section heading with no path-like entries still yields [] — the
    // refusal keys on entries, not on the heading text.
    assert.equal(extractScopeFromBody("## Files in scope\n\n- none yet").length > 0, false);
    assert.equal(extractScopeFromBody(BODY_WITH_SCOPE).length > 0, true);
  });
});
