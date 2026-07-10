/**
 * Regression tests for the autopilot board-state endpoint (issue #934).
 *
 * Two layers:
 *   1. `deriveBoardState` — the pure bucketing math (no I/O, no live `gh`):
 *      label counts + the two stale-window number lists, with an injected
 *      `nowMs` so staleness is deterministic.
 *   2. The GET /autopilot/board-state route handler — that the counts ride the
 *      response, validate against the schema, degrade to an all-zero
 *      `degraded:true` body when the GitHub-Read seam fails (never a 500), and
 *      return 400 on a malformed query.
 *
 * Follows the test/autopilot-idle.test.mts pattern — wires the router with a
 * stubbed `readOpenIssues` reader and calls the handler directly. No live
 * Express server, no real `gh`, no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createAutopilotBoardRouter,
  deriveBoardState,
  ORCH_BOARD_LABELS,
  STALE_IN_PROGRESS_SECONDS,
  STALE_BLOCKED_SECONDS,
  type AutopilotBoardRouterDeps,
} from "../src/api/autopilot-board.ts";
import { AutopilotBoardStateResponseSchema } from "../src/schemas/autopilot-board.ts";
import type { IssueRow, IssueReadResult } from "../src/github/issues.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

/** ISO timestamp `seconds` before NOW_MS. */
function isoSecondsAgo(seconds: number): string {
  return new Date(NOW_MS - seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// deriveBoardState — pure bucketing
// ---------------------------------------------------------------------------

describe("deriveBoardState — counts + stale lists (issue #934)", () => {
  test("counts each label independently; an issue with two labels counts in both", () => {
    const out = deriveBoardState(
      [
        row({ number: 1, labels: [ORCH_BOARD_LABELS.needs_qa] }),
        row({ number: 2, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
        row({ number: 3, labels: [ORCH_BOARD_LABELS.needs_triage] }),
        row({ number: 4, labels: [ORCH_BOARD_LABELS.needs_research] }),
        row({
          number: 5,
          labels: [ORCH_BOARD_LABELS.in_progress, ORCH_BOARD_LABELS.blocked],
        }),
      ],
      NOW_MS,
    );
    assert.equal(out.needs_qa, 1);
    assert.equal(out.ready_for_agent, 1);
    assert.equal(out.needs_triage, 1);
    assert.equal(out.needs_research, 1);
    assert.equal(out.in_progress, 1);
    assert.equal(out.blocked, 1);
  });

  test("target-backlog + ready-for-agent is NOT counted as orch ready_for_agent (issue #2704)", () => {
    const out = deriveBoardState(
      [
        // pure orch ready-for-agent → counted
        row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
        // Target-scope: carries BOTH labels → excluded from the orch count
        row({
          number: 2701,
          labels: [
            ORCH_BOARD_LABELS.ready_for_agent,
            ORCH_BOARD_LABELS.target_backlog,
          ],
        }),
        // target-backlog alone (no ready-for-agent) → not counted anyway
        row({ number: 3, labels: [ORCH_BOARD_LABELS.target_backlog] }),
      ],
      NOW_MS,
    );
    // Only the pure orch issue counts; the dual-labeled Target issue is excluded.
    assert.equal(out.ready_for_agent, 1);
  });

  test("empty board → all zero, empty stale lists", () => {
    const out = deriveBoardState([], NOW_MS);
    assert.equal(out.needs_qa, 0);
    assert.equal(out.ready_for_agent, 0);
    assert.deepEqual(out.stale_in_progress, []);
    assert.deepEqual(out.stale_blocked, []);
  });

  test("stale_in_progress lists only in-progress issues older than the 90-min window", () => {
    const out = deriveBoardState(
      [
        // fresh in-progress (just under window) → NOT stale
        row({
          number: 10,
          labels: [ORCH_BOARD_LABELS.in_progress],
          updatedAt: isoSecondsAgo(STALE_IN_PROGRESS_SECONDS - 60),
        }),
        // stale in-progress (just over window) → stale
        row({
          number: 11,
          labels: [ORCH_BOARD_LABELS.in_progress],
          updatedAt: isoSecondsAgo(STALE_IN_PROGRESS_SECONDS + 60),
        }),
        // stale by age but not in-progress → not listed
        row({
          number: 12,
          labels: [ORCH_BOARD_LABELS.needs_qa],
          updatedAt: isoSecondsAgo(STALE_IN_PROGRESS_SECONDS + 999),
        }),
      ],
      NOW_MS,
    );
    assert.equal(out.in_progress, 2);
    assert.deepEqual(out.stale_in_progress, [11]);
  });

  test("stale_blocked uses the longer 12-h window, independent of in-progress", () => {
    const out = deriveBoardState(
      [
        // blocked but fresh (older than in-progress window, younger than blocked window) → NOT stale
        row({
          number: 20,
          labels: [ORCH_BOARD_LABELS.blocked],
          updatedAt: isoSecondsAgo(STALE_IN_PROGRESS_SECONDS + 60),
        }),
        // blocked and stale → listed
        row({
          number: 21,
          labels: [ORCH_BOARD_LABELS.blocked],
          updatedAt: isoSecondsAgo(STALE_BLOCKED_SECONDS + 60),
        }),
      ],
      NOW_MS,
    );
    assert.equal(out.blocked, 2);
    assert.deepEqual(out.stale_blocked, [21]);
  });

  test("an absent/unparseable updatedAt is conservatively NOT stale", () => {
    const out = deriveBoardState(
      [
        row({ number: 30, labels: [ORCH_BOARD_LABELS.in_progress], updatedAt: "" }),
        row({
          number: 31,
          labels: [ORCH_BOARD_LABELS.blocked],
          updatedAt: "not-a-date",
        }),
      ],
      NOW_MS,
    );
    assert.deepEqual(out.stale_in_progress, []);
    assert.deepEqual(out.stale_blocked, []);
  });
});

// ---------------------------------------------------------------------------
// deriveBoardState — dependency-aware ready_for_agent filter (issue #3059)
// ---------------------------------------------------------------------------

describe("deriveBoardState — dependency-aware ready_for_agent (issue #3059)", () => {
  test("golden: a ready-for-agent issue with an OPEN strict blocker is NOT counted", () => {
    const out = deriveBoardState(
      [
        // #1 declares `Blocked by #100`, and #100 is resolved OPEN → excluded.
        row({
          number: 1,
          labels: [ORCH_BOARD_LABELS.ready_for_agent],
          body: "Blocked by #100",
        }),
        // #2 is a clean ready-for-agent issue → counted.
        row({ number: 2, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
      ],
      NOW_MS,
      new Set([100]), // #100 open
    );
    // Only the unblocked issue counts.
    assert.equal(out.ready_for_agent, 1);
  });

  test("golden: when the blocker flips CLOSED, the issue re-enters the pool", () => {
    const rows = [
      row({
        number: 1,
        labels: [ORCH_BOARD_LABELS.ready_for_agent],
        body: "Blocked by #100",
      }),
    ];
    // Blocker #100 still open → excluded.
    assert.equal(deriveBoardState(rows, NOW_MS, new Set([100])).ready_for_agent, 0);
    // Blocker #100 now closed (empty open-set) → included, no `blocked` label toggle.
    assert.equal(deriveBoardState(rows, NOW_MS, new Set()).ready_for_agent, 1);
  });

  test("`depends on #N` gates dispatch the same as `blocked by #N`", () => {
    const out = deriveBoardState(
      [
        row({
          number: 1,
          labels: [ORCH_BOARD_LABELS.ready_for_agent],
          body: "This depends on #200 landing first.",
        }),
      ],
      NOW_MS,
      new Set([200]),
    );
    assert.equal(out.ready_for_agent, 0);
  });

  test("a bare `#N` mention does NOT exclude (strict parser, no false starve)", () => {
    const out = deriveBoardState(
      [
        row({
          number: 1,
          labels: [ORCH_BOARD_LABELS.ready_for_agent],
          body: "Related work: see #300 (not a blocker).",
        }),
      ],
      NOW_MS,
      new Set([300]), // #300 is open, but only referenced as a bare mention
    );
    assert.equal(out.ready_for_agent, 1);
  });

  test("filter is ADDITIVE to the manual `blocked` label — counts are independent", () => {
    const out = deriveBoardState(
      [
        // ready-for-agent + open strict blocker → excluded from ready_for_agent,
        // but NOT auto-added to the `blocked` count (no label toggle).
        row({
          number: 1,
          labels: [ORCH_BOARD_LABELS.ready_for_agent],
          body: "Blocked by #100",
        }),
      ],
      NOW_MS,
      new Set([100]),
    );
    assert.equal(out.ready_for_agent, 0);
    assert.equal(out.blocked, 0); // never auto-toggles the manual label
  });

  test("default (no openBlockers arg) preserves pre-#3059 behavior — no filtering", () => {
    const out = deriveBoardState(
      [
        row({
          number: 1,
          labels: [ORCH_BOARD_LABELS.ready_for_agent],
          body: "Blocked by #100",
        }),
      ],
      NOW_MS,
      // no third arg → empty set → strict-blocker filter is a no-op
    );
    assert.equal(out.ready_for_agent, 1);
  });
});

// ---------------------------------------------------------------------------
// Route harness (mirrors test/autopilot-idle.test.mts)
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
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

const ROUTE = "/autopilot/board-state";

async function callRoute(
  deps: AutopilotBoardRouterDeps = {},
  query: Record<string, unknown> = {},
) {
  const router = createAutopilotBoardRouter({ now: () => NOW_MS, ...deps });
  const handler = findHandler(router, "GET", ROUTE);
  assert.ok(handler, "route handler must exist");
  const res = mockRes();
  await handler!(mockReq(query), res);
  return res;
}

function okResult(rows: IssueRow[]): IssueReadResult<IssueRow> {
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Route — happy path, degrade, validation
// ---------------------------------------------------------------------------

describe("GET /autopilot/board-state — route (issue #934)", () => {
  test("serves counts from the seam; degraded=false; validates against schema", async () => {
    const res = await callRoute({
      readOpenIssues: async () =>
        okResult([
          row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
          row({ number: 2, labels: [ORCH_BOARD_LABELS.needs_qa] }),
          row({
            number: 3,
            labels: [ORCH_BOARD_LABELS.blocked],
            updatedAt: isoSecondsAgo(STALE_BLOCKED_SECONDS + 60),
          }),
        ]),
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.ready_for_agent, 1);
    assert.equal(res._body.needs_qa, 1);
    assert.equal(res._body.blocked, 1);
    assert.deepEqual(res._body.stale_blocked, [3]);
    assert.equal(res._body.degraded, false);
    assert.equal(typeof res._body.generatedAt, "string");
    // Response must satisfy the published schema contract.
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("seam failure → all-zero counts, degraded=true, still 200 (never-throw)", async () => {
    const res = await callRoute({
      readOpenIssues: async () => ({ ok: false, code: "gh-failed" } as IssueReadResult<IssueRow>),
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.ready_for_agent, 0);
    assert.equal(res._body.needs_qa, 0);
    assert.deepEqual(res._body.stale_in_progress, []);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("a thrown reader degrades rather than 500ing (never-throw belt-and-braces)", async () => {
    const res = await callRoute({
      readOpenIssues: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.blocked, 0);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("endpoint pre-resolves open blockers and excludes a blocked issue (issue #3059)", async () => {
    const res = await callRoute({
      readOpenIssues: async () =>
        okResult([
          row({
            number: 1,
            labels: [ORCH_BOARD_LABELS.ready_for_agent],
            body: "Blocked by #100",
          }),
          row({ number: 2, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
        ]),
      // #100 resolves OPEN → issue #1 excluded from the dispatchable pool.
      resolveOpenBlockers: async () => new Set([100]),
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.ready_for_agent, 1);
    assert.equal(res._body.degraded, false);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("a rejecting blocker resolver degrades the board, never 500s (issue #3059)", async () => {
    const res = await callRoute({
      readOpenIssues: async () =>
        okResult([row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] })]),
      resolveOpenBlockers: async () => {
        throw new Error("gh blew up");
      },
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.ready_for_agent, 0);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("malformed query (unexpected key) → 400 schema-validation-failed", async () => {
    const res = await callRoute(
      { readOpenIssues: async () => okResult([]) },
      { forse: "1" },
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});
