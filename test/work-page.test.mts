/**
 * Regression tests for the /work page's server surfaces (issue #4010, ADR-0034
 * §2 + §7): the board-state trust + queue extension, the anchor-distribution
 * boundary stamps, and the four issue-lifecycle action routes.
 *
 * Why server-side only: the dashboard components are React/JSX the node:test
 * suite cannot import (no JSX runner, no `react` resolution in the worktree).
 * The client's trust-status derivation keys mechanically off the fields these
 * tests pin at the HTTP boundary (`sourcesOk`, `generatedAt`), so the boundary
 * assertion IS the regression lock for the client half — the same discipline
 * as test/today-page.test.mts (#4006).
 *
 * Design-concept invariants locked here (`hydra:design-concept:issue-4010`):
 *   INV-2/3 — board-state carries sourcesOk + a parseable generatedAt.
 *   INV-4   — anchor-distribution stamps generatedAt/sourcesOk at the HTTP
 *             boundary; projectAnchorDistribution itself stays pure (its own
 *             on-wire shape stays unchanged — pinned by
 *             test/metrics-aggregators.test.mts).
 *   INV-5   — promote requires confirm; refuses blocked issues (label or open
 *             strict blocker) and issues with no '## Files in scope' section.
 *   INV-6   — every action's success carries the POST-WRITE re-read state;
 *             a disagreeing read-back is a verification-mismatch, never ok.
 *   INV-7/8 — writes ride the gh issue family via src/github/issue-actions.ts;
 *             issues.ts's addIssueLabel is reused untouched.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AutopilotBoardStateResponseSchema,
  PromoteActionBodySchema,
  RelabelActionBodySchema,
  IssueStateActionBodySchema,
  BoardActionResponseSchema,
} from "../src/schemas/autopilot-board.ts";
import { createAutopilotBoardRouter } from "../src/api/autopilot-board.ts";
import {
  removeIssueLabel,
  closeIssue,
  reopenIssue,
  viewIssueState,
  isIssueStateFailure,
  type IssueStateSnapshot,
  type IssueActionWriteResult,
  type IssueStateResult,
} from "../src/github/issue-actions.ts";
import type { GhResult } from "../src/github/exec.ts";
import type { IssueRow } from "../src/github/issues.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z").getTime();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function issueRow(over: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: over.number,
    title: over.title ?? `Issue #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/issues/${over.number}`,
    createdAt: over.createdAt ?? "2026-08-01T00:00:00.000Z",
    labels: over.labels ?? [],
    body: over.body ?? "",
    state: over.state ?? "OPEN",
  };
}

function snapshot(over: Partial<IssueStateSnapshot> & { number: number }): IssueStateSnapshot {
  return {
    number: over.number,
    title: over.title ?? `Issue #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/issues/${over.number}`,
    labels: over.labels ?? [],
    state: over.state ?? "OPEN",
    body: over.body ?? "",
  };
}

/** A mutable issue store the fake action seams read/write — models gh. */
function fakeBoard(initial: IssueStateSnapshot[]) {
  const store = new Map<number, IssueStateSnapshot>(
    initial.map((s) => [s.number, { ...s }]),
  );
  const addedLabels: Array<{ issue: number; label: string }> = [];
  const removedLabels: Array<{ issue: number; label: string }> = [];
  const stateWrites: Array<{ issue: number; state: string }> = [];
  const viewCalls: number[] = [];
  return {
    addedLabels,
    removedLabels,
    stateWrites,
    viewCalls,
    seams: {
      addLabel: async (issue: number, label: string) => {
        addedLabels.push({ issue, label });
        const cur = store.get(issue);
        if (cur) cur.labels = Array.from(new Set([...cur.labels, label]));
        return { ok: true } as const;
      },
      removeLabel: async (issue: number, label: string) => {
        removedLabels.push({ issue, label });
        const cur = store.get(issue);
        if (cur) cur.labels = cur.labels.filter((l) => l !== label);
        return { ok: true } as const;
      },
      close: async (issue: number) => {
        stateWrites.push({ issue, state: "CLOSED" });
        const cur = store.get(issue);
        if (cur) cur.state = "CLOSED";
        return { ok: true } as const;
      },
      reopen: async (issue: number) => {
        stateWrites.push({ issue, state: "OPEN" });
        const cur = store.get(issue);
        if (cur) cur.state = "OPEN";
        return { ok: true } as const;
      },
      view: async (issue: number): Promise<IssueStateResult> => {
        viewCalls.push(issue);
        const cur = store.get(issue);
        if (!cur) {
          return { ok: false, code: "gh-failed", stderr: "no such issue" };
        }
        return { ok: true, data: { ...cur } };
      },
    },
  };
}

function mockReq(body: any = {}, query: any = {}): any {
  return {
    method: "POST",
    url: "/autopilot/board-state",
    headers: {},
    query,
    params: {},
    body,
  };
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
    setHeader() {
      return res;
    },
    end() {
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

// ---------------------------------------------------------------------------
// Schemas — the trust + action contracts are part of the HTTP surface
// ---------------------------------------------------------------------------

describe("AutopilotBoardStateResponseSchema — trust + queue fields (#4010)", () => {
  const validBody = {
    needs_qa: 0,
    ready_for_agent: 0,
    needs_triage: 0,
    needs_research: 0,
    in_progress: 0,
    blocked: 0,
    stale_in_progress: [],
    stale_blocked: [],
    degraded: false,
    sourcesOk: true,
    ready_for_agent_queue: [],
    generatedAt: "2026-08-15T12:00:00.000Z",
  };

  test("accepts a valid response with sourcesOk + ready_for_agent_queue", () => {
    assert.equal(AutopilotBoardStateResponseSchema.safeParse(validBody).success, true);
  });

  test("rejects a response missing sourcesOk (unasserted)", () => {
    const { sourcesOk: _drop, ...body } = validBody;
    assert.equal(AutopilotBoardStateResponseSchema.safeParse(body).success, false);
  });

  test("rejects a response missing ready_for_agent_queue", () => {
    const { ready_for_agent_queue: _drop, ...body } = validBody;
    assert.equal(AutopilotBoardStateResponseSchema.safeParse(body).success, false);
  });

  test("rejects unknown extra fields (strict)", () => {
    assert.equal(
      AutopilotBoardStateResponseSchema.safeParse({ ...validBody, surprise: 1 }).success,
      false,
    );
  });
});

describe("action request/response schemas", () => {
  test("promote body requires issue + confirm", () => {
    assert.equal(PromoteActionBodySchema.safeParse({ issue: 7, confirm: false }).success, true);
    assert.equal(PromoteActionBodySchema.safeParse({ issue: 7 }).success, false);
    assert.equal(PromoteActionBodySchema.safeParse({ issue: -1, confirm: true }).success, false);
    assert.equal(PromoteActionBodySchema.safeParse({ issue: 7, confirm: true, x: 1 }).success, false);
  });

  test("relabel body validates the label against the closed vocabulary", () => {
    assert.equal(
      RelabelActionBodySchema.safeParse({ issue: 7, addLabel: "needs-research" }).success,
      true,
    );
    // arbitrary strings must not reach the gh argv
    assert.equal(
      RelabelActionBodySchema.safeParse({ issue: 7, addLabel: "subscriber-only" }).success,
      false,
    );
  });

  test("state-action body requires issue", () => {
    assert.equal(IssueStateActionBodySchema.safeParse({ issue: 7 }).success, true);
    assert.equal(IssueStateActionBodySchema.safeParse({}).success, false);
  });

  test("BoardActionResponseSchema accepts both arms and rejects garbage ok", () => {
    const ok = {
      ok: true,
      action: "promote",
      issue: { number: 7, title: "t", url: "u", labels: ["ready-for-agent"], state: "OPEN" },
      generatedAt: "2026-08-15T12:00:00.000Z",
    };
    const refused = {
      ok: false,
      action: "promote",
      code: "promote-blocked-issue",
      reason: "blocked by #4006",
      blockers: [4006],
      generatedAt: "2026-08-15T12:00:00.000Z",
    };
    assert.equal(BoardActionResponseSchema.safeParse(ok).success, true);
    assert.equal(BoardActionResponseSchema.safeParse(refused).success, true);
    assert.equal(BoardActionResponseSchema.safeParse({ ...ok, ok: "yes" }).success, false);
  });
});

// ---------------------------------------------------------------------------
// issue-actions leaf — argv shapes + never-throw mapping (INV-7)
// ---------------------------------------------------------------------------

describe("src/github/issue-actions.ts — write primitives", () => {
  function recordingTransport(result: IssueActionWriteResult) {
    const calls: string[][] = [];
    // Narrow BEFORE the closure — strict:false keeps boolean discrimination
    // out of closures (see isIssueLabelWriteFailure's rationale in issues.ts).
    const failure =
      result.ok === false ? { ok: false as const, code: result.code, stderr: result.stderr } : null;
    const transport = async (args: string[], _opts: any): Promise<GhResult<{ stdout: string; stderr: string }>> => {
      calls.push(args);
      if (failure) return failure;
      return { ok: true, data: { stdout: "", stderr: "" } };
    };
    return { calls, transport };
  }

  test("removeIssueLabel rides gh issue edit --remove-label", async () => {
    const rec = recordingTransport({ ok: true });
    const res = await removeIssueLabel(4100, "blocked", { transport: rec.transport });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(rec.calls, [
      ["issue", "edit", "4100", "--repo", "gaberoo322/hydra", "--remove-label", "blocked"],
    ]);
  });

  test("closeIssue rides gh issue close; reopen rides gh issue reopen", async () => {
    const recClose = recordingTransport({ ok: true });
    await closeIssue(4100, { transport: recClose.transport });
    assert.deepEqual(recClose.calls, [["issue", "close", "4100", "--repo", "gaberoo322/hydra"]]);

    const recReopen = recordingTransport({ ok: true });
    await reopenIssue(4100, { transport: recReopen.transport });
    assert.deepEqual(recReopen.calls, [["issue", "reopen", "4100", "--repo", "gaberoo322/hydra"]]);
  });

  test("never throws: a failed write maps to the gh-* code", async () => {
    const rec = recordingTransport({ ok: false, code: "gh-timeout", stderr: "timed out" });
    const res = await closeIssue(4100, { transport: rec.transport });
    assert.equal(res.ok, false);
    if (res.ok === false) {
      assert.equal(res.code, "gh-timeout");
      assert.equal(res.stderr, "timed out");
    }
  });

  test("never routes through gh pr edit or a gh api call", async () => {
    const rec = recordingTransport({ ok: true });
    await removeIssueLabel(1, "x", { transport: rec.transport });
    await closeIssue(1, { transport: rec.transport });
    await reopenIssue(1, { transport: rec.transport });
    for (const args of rec.calls) {
      assert.equal(args.includes("pr"), false, `gh pr used: ${args.join(" ")}`);
      assert.equal(args.includes("api"), false, `gh api used: ${args.join(" ")}`);
    }
  });

  test("viewIssueState reads gh issue view and normalises label objects", async () => {
    const calls: string[][] = [];
    const reader = async (args: string[], _opts: any): Promise<GhResult<unknown>> => {
      calls.push(args);
      return {
        ok: true,
        data: {
          number: 4100,
          labels: [{ name: "needs-triage" }, "enhancement"],
          state: "open",
        },
      };
    };
    const res = await viewIssueState(4100, { reader });
    assert.equal(isIssueStateFailure(res), false);
    if (res.ok) {
      assert.deepEqual(res.data.labels, ["needs-triage", "enhancement"]);
      assert.equal(res.data.state, "OPEN"); // normalised uppercase
      assert.equal(res.data.body, ""); // absent body degrades, never throws
    }
    assert.deepEqual(calls[0].slice(0, 3), ["issue", "view", "4100"]);
  });

  test("viewIssueState failure arm carries the gh code", async () => {
    const reader = async (): Promise<GhResult<unknown>> => ({
      ok: false,
      code: "gh-failed",
      stderr: "not found",
    });
    const res = await viewIssueState(4100, { reader });
    assert.equal(isIssueStateFailure(res), true);
  });
});

// ---------------------------------------------------------------------------
// GET /autopilot/board-state — sourcesOk + the queue (INV-2/3)
// ---------------------------------------------------------------------------

describe("GET /autopilot/board-state — trust fields + ready queue", () => {
  function makeRouter(rows: IssueRow[], openBlockers = new Set<number>()) {
    return createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: true, rows }),
      resolveOpenBlockers: async () => openBlockers,
      glmDrainerLiveness: async () => false,
    });
  }

  async function get(router: any) {
    const handler = findHandler(router, "GET", "/autopilot/board-state");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq({}, {}), res);
    return res;
  }

  test("clean read: sourcesOk true, queue mirrors the counted rows", async () => {
    const router = makeRouter([
      issueRow({ number: 1, labels: ["ready-for-agent"], updatedAt: undefined }),
      issueRow({ number: 2, labels: ["ready-for-agent", "target-backlog"] }),
      issueRow({ number: 3, labels: ["needs-qa"] }),
    ]);
    const res = await get(router);
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, false);
    assert.equal(res._body.sourcesOk, true);
    // The queue carries exactly the rows that count toward ready_for_agent:
    // #1 yes, #2 excluded (target-backlog), #3 not ready at all.
    assert.equal(res._body.ready_for_agent, 1);
    assert.deepEqual(
      res._body.ready_for_agent_queue.map((r: any) => r.number),
      [1],
    );
    assert.equal(res._body.ready_for_agent_queue[0].title, "Issue #1");
    // Round-trips the (now stricter) schema.
    assert.ok(AutopilotBoardStateResponseSchema.safeParse(res._body).success);
  });

  test("open strict blocker excludes a row from BOTH count and queue", async () => {
    const router = makeRouter(
      [
        issueRow({ number: 5, labels: ["ready-for-agent"], body: "Blocked by #4006" }),
        issueRow({ number: 6, labels: ["ready-for-agent"] }),
      ],
      new Set([4006]),
    );
    const res = await get(router);
    assert.equal(res._body.ready_for_agent, 1);
    assert.deepEqual(
      res._body.ready_for_agent_queue.map((r: any) => r.number),
      [6],
    );
  });

  test("degraded read: sourcesOk false + empty queue — never a confident zero", async () => {
    const router = createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: false, code: "gh-timeout" as any }),
      glmDrainerLiveness: async () => false,
    });
    const res = await get(router);
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.sourcesOk, false);
    assert.deepEqual(res._body.ready_for_agent_queue, []);
    assert.ok(AutopilotBoardStateResponseSchema.safeParse(res._body).success);
  });
});

// ---------------------------------------------------------------------------
// POST /autopilot/board-state/promote — confirm step + guard refusals (INV-5)
// ---------------------------------------------------------------------------

describe("POST promote — confirm tier + guard refusals", () => {
  const SCOPED_BODY = "## What\n\ndoes things\n\n## Files in scope\n\n- `src/foo.ts`\n";

  function makeRouter(board: ReturnType<typeof fakeBoard>, openBlockers = new Set<number>()) {
    return createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: true, rows: [] }),
      resolveOpenBlockers: async () => openBlockers,
      glmDrainerLiveness: async () => false,
      issueActions: board.seams,
    });
  }

  async function promote(router: any, body: any) {
    const handler = findHandler(router, "POST", "/autopilot/board-state/promote");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq(body), res);
    return res;
  }

  test("refuses without confirm — 400 promote-confirm-required, no write", async () => {
    const board = fakeBoard([snapshot({ number: 7, body: SCOPED_BODY })]);
    const res = await promote(makeRouter(board), { issue: 7, confirm: false });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "promote-confirm-required");
    assert.deepEqual(board.addedLabels, []);
  });

  test("refuses an issue carrying the blocked label, with the reason", async () => {
    const board = fakeBoard([
      snapshot({ number: 7, labels: ["blocked"], body: SCOPED_BODY }),
    ]);
    const res = await promote(makeRouter(board), { issue: 7, confirm: true });
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.code, "promote-blocked-issue");
    assert.match(res._body.reason, /blocked/);
    assert.deepEqual(board.addedLabels, []);
  });

  test("refuses an issue with an OPEN strict blocker, naming the blocker", async () => {
    const board = fakeBoard([
      snapshot({ number: 7, body: "## Files in scope\n\n- `src/a.ts`\n\nBlocked by #4006\n" }),
    ]);
    const res = await promote(makeRouter(board, new Set([4006])), { issue: 7, confirm: true });
    assert.equal(res._body.ok, false);
    assert.equal(res._body.code, "promote-blocked-issue");
    assert.deepEqual(res._body.blockers, [4006]);
    assert.match(res._body.reason, /4006/);
    assert.deepEqual(board.addedLabels, []);
  });

  test("an issue whose blockers are all CLOSED is not refused", async () => {
    const board = fakeBoard([
      snapshot({ number: 7, body: "## Files in scope\n\n- `src/a.ts`\n\nBlocked by #4006\n" }),
    ]);
    const res = await promote(makeRouter(board, new Set()), { issue: 7, confirm: true });
    assert.equal(res._body.ok, true);
  });

  test("refuses an issue with no '## Files in scope' section — the label would be reverted", async () => {
    const board = fakeBoard([snapshot({ number: 7, body: "## What\n\nno scope section\n" })]);
    const res = await promote(makeRouter(board), { issue: 7, confirm: true });
    assert.equal(res._body.ok, false);
    assert.equal(res._body.code, "promote-missing-scope");
    assert.match(res._body.reason, /Files in scope/);
    assert.deepEqual(board.addedLabels, []);
  });

  test("happy path: writes the label and reports the VERIFIED post-write state", async () => {
    const board = fakeBoard([snapshot({ number: 7, labels: ["needs-triage"], body: SCOPED_BODY })]);
    const res = await promote(makeRouter(board), { issue: 7, confirm: true });
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.action, "promote");
    // The write rode the existing addIssueLabel seam (INV-8 reuse).
    assert.deepEqual(board.addedLabels, [{ issue: 7, label: "ready-for-agent" }]);
    // INV-6: the response's snapshot is the post-write RE-READ...
    assert.ok(board.viewCalls.length >= 2, "expected a pre-write and a post-write read");
    assert.deepEqual(res._body.issue.labels, ["needs-triage", "ready-for-agent"]);
    assert.ok(BoardActionResponseSchema.safeParse(res._body).success);
  });

  test("a disagreeing read-back is a verification-mismatch, never ok", async () => {
    // The fake write succeeds but the post-write view loses the label —
    // model a write that did not stick.
    const base = fakeBoard([snapshot({ number: 7, body: SCOPED_BODY })]);
    const seams = {
      ...base.seams,
      addLabel: async () => ({ ok: true }) as const, // claims success, mutates nothing
    };
    const router = createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: true, rows: [] }),
      resolveOpenBlockers: async () => new Set(),
      glmDrainerLiveness: async () => false,
      issueActions: seams,
    });
    const res = await promote(router, { issue: 7, confirm: true });
    assert.equal(res._body.ok, false);
    assert.equal(res._body.code, "verification-mismatch");
  });

  test("a failed write is a 502, not a fabricated success", async () => {
    const base = fakeBoard([snapshot({ number: 7, body: SCOPED_BODY })]);
    const seams = {
      ...base.seams,
      addLabel: async () => ({ ok: false, code: "gh-timeout", stderr: "t/o" }) as any,
    };
    const router = createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: true, rows: [] }),
      resolveOpenBlockers: async () => new Set(),
      glmDrainerLiveness: async () => false,
      issueActions: seams,
    });
    const res = await promote(router, { issue: 7, confirm: true });
    assert.equal(res._status, 502);
    assert.equal(res._body.code, "github-write-failed");
  });
});

// ---------------------------------------------------------------------------
// POST relabel / close / reopen — immediate tier, verified results (INV-6)
// ---------------------------------------------------------------------------

describe("POST relabel / close / reopen — immediate tier", () => {
  function makeRouter(board: ReturnType<typeof fakeBoard>) {
    return createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: true, rows: [] }),
      resolveOpenBlockers: async () => new Set(),
      glmDrainerLiveness: async () => false,
      issueActions: board.seams,
    });
  }

  async function call(router: any, path: string, body: any) {
    const handler = findHandler(router, "POST", path);
    assert.ok(handler, `no handler for ${path}`);
    const res = mockRes();
    await handler(mockReq(body), res);
    return res;
  }

  test("relabel removes the old lane, adds the new, reports verified state", async () => {
    const board = fakeBoard([
      snapshot({ number: 8, labels: ["ready-for-agent", "enhancement"] }),
    ]);
    const res = await call(makeRouter(board), "/autopilot/board-state/relabel", {
      issue: 8,
      addLabel: "needs-research",
      removeLabels: ["ready-for-agent"],
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.deepEqual(board.removedLabels, [{ issue: 8, label: "ready-for-agent" }]);
    assert.deepEqual(board.addedLabels, [{ issue: 8, label: "needs-research" }]);
    assert.deepEqual(res._body.issue.labels, ["enhancement", "needs-research"]);
    assert.ok(BoardActionResponseSchema.safeParse(res._body).success);
  });

  test("close reports the re-read CLOSED state", async () => {
    const board = fakeBoard([snapshot({ number: 9, labels: ["needs-triage"] })]);
    const res = await call(makeRouter(board), "/autopilot/board-state/close", { issue: 9 });
    assert.equal(res._body.ok, true);
    assert.equal(res._body.issue.state, "CLOSED");
  });

  test("reopen reports the re-read OPEN state", async () => {
    const board = fakeBoard([snapshot({ number: 10, state: "CLOSED" })]);
    const res = await call(makeRouter(board), "/autopilot/board-state/reopen", { issue: 10 });
    assert.equal(res._body.ok, true);
    assert.equal(res._body.issue.state, "OPEN");
  });

  test("a state write whose read-back disagrees is a verification-mismatch", async () => {
    const board = fakeBoard([snapshot({ number: 11, state: "OPEN" })]);
    const seams = {
      ...board.seams,
      close: async () => ({ ok: true }) as const, // claims success, mutates nothing
    };
    const router = createAutopilotBoardRouter({
      now: () => NOW,
      readOpenIssues: async () => ({ ok: true, rows: [] }),
      resolveOpenBlockers: async () => new Set(),
      glmDrainerLiveness: async () => false,
      issueActions: seams,
    });
    const res = await call(router, "/autopilot/board-state/close", { issue: 11 });
    assert.equal(res._body.ok, false);
    assert.equal(res._body.code, "verification-mismatch");
  });

  test("malformed bodies are 400 schema-validation-failed", async () => {
    const board = fakeBoard([]);
    const router = makeRouter(board);
    const res = await call(router, "/autopilot/board-state/reopen", { issue: "seven" });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});
