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

import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import Redis from "ioredis";

import {
  createAutopilotBoardRouter,
  type AutopilotBoardRouterDeps,
} from "../src/api/autopilot-board.ts";
// `deriveBoardState` moved to its domain leaf (issue #3505) — the pure
// bucketing unit test imports it directly, without Express in scope.
import { deriveBoardState } from "../src/autopilot/board-state.ts";
import {
  getGlmDrainerLiveness,
  setGlmDrainerHeartbeat,
  GLM_DRAINER_ACTIVE_KEY,
  GLM_DRAINER_HEARTBEAT_STALE_MS,
  GLM_DRAINER_HEARTBEAT_TTL_SECONDS,
  getGlmAbAssignment,
  recordGlmAbAssignment,
  glmAbAssignmentKey,
  type GlmAbAssignmentRecord,
} from "../src/redis/autopilot.ts";
import {
  ORCH_BOARD_LABELS,
  STALE_IN_PROGRESS_SECONDS,
  STALE_BLOCKED_SECONDS,
} from "../src/board-labels.ts";
import {
  AutopilotBoardStateResponseSchema,
  AutopilotBoardStateQuerySchema,
  BOARD_STATE_SCOPES,
} from "../src/schemas/autopilot-board.ts";
import {
  TARGET_BOARD_LABELS,
  TARGET_SPECIFIC_LABELS,
} from "../src/target-board-labels.ts";
import type { IssueRow, IssueReadResult } from "../src/github/issues.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-03T12:00:00.000Z");

// Redis DB for the GLM-drainer accessor round-trips (issue #3754). Mirrors the
// workless-hint / autopilot-pause pattern: the test launcher (or an explicit
// override) sets REDIS_URL; we re-assert it so the accessor's shared singleton
// connects to the same DB the suite's own client writes to.
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

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

  test("glm-eligible is excluded from ready_for_agent only while the drainer is live (#3687, #3754)", () => {
    // ADR-0032 + #3754: a glm-eligible issue is authored by the GLM dev-drainer
    // on z.ai's independent quota, so while the drainer is LIVE it is excluded
    // from the Opus `dev_orch` authoring pool. When the drainer is stale /
    // absent the exclusion LIFTS (fail-open toward work) so Opus sees it again.
    const board = [
      // pure orch ready-for-agent → always counted
      row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
      // drainer-owned: carries BOTH labels → excluded ONLY while partition live
      row({
        number: 3687,
        labels: [
          ORCH_BOARD_LABELS.ready_for_agent,
          ORCH_BOARD_LABELS.glm_eligible,
        ],
      }),
      // glm-eligible alone (no ready-for-agent) → never counted anyway
      row({ number: 3, labels: [ORCH_BOARD_LABELS.glm_eligible] }),
    ];
    // Default (no liveness resolved) = partition INACTIVE = fail-open: counted.
    assert.equal(deriveBoardState(board, NOW_MS).ready_for_agent, 2);
    // Partition ACTIVE (drainer live): the glm-eligible issue is excluded.
    assert.equal(
      deriveBoardState(board, NOW_MS, new Set(), true).ready_for_agent,
      1,
    );
  });

  test("glm-eligible does not disturb the other board counts (#3687)", () => {
    // The exclusion is scoped to the dev_orch authoring count ONLY. A
    // glm-eligible issue that is also needs-qa / in-progress must still be
    // counted there — and design_concept_orch (which reads no board count
    // gated on glm-eligible) stays active on it per ADR-0032 Decision 1.
    const out = deriveBoardState(
      [
        row({
          number: 42,
          labels: [
            ORCH_BOARD_LABELS.glm_eligible,
            ORCH_BOARD_LABELS.needs_qa,
            ORCH_BOARD_LABELS.in_progress,
          ],
        }),
      ],
      NOW_MS,
    );
    assert.equal(out.ready_for_agent, 0);
    assert.equal(out.needs_qa, 1);
    assert.equal(out.in_progress, 1);
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
  // Default the GLM liveness reader to partition-INACTIVE so the existing
  // route cases stay Redis-free and deterministic; cases that exercise the
  // partition pass their own `glmDrainerLiveness` (issue #3754).
  const router = createAutopilotBoardRouter({
    now: () => NOW_MS,
    glmDrainerLiveness: async () => false,
    ...deps,
  });
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

// ---------------------------------------------------------------------------
// Scope-parameterized board-state read + Target board-label leaf (issue #3434)
// ---------------------------------------------------------------------------

describe("board-state query scope param (issue #3434)", () => {
  test("scope defaults to 'orch' when omitted — every existing caller unchanged", () => {
    const parsed = AutopilotBoardStateQuerySchema.safeParse({});
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.scope, "orch");
  });

  test("scope=target is accepted", () => {
    const parsed = AutopilotBoardStateQuerySchema.safeParse({ scope: "target" });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.scope, "target");
  });

  test("an unknown scope value is rejected (enum-guarded)", () => {
    const parsed = AutopilotBoardStateQuerySchema.safeParse({ scope: "betting" });
    assert.equal(parsed.success, false);
  });

  test("the only scopes are orch + target", () => {
    assert.deepEqual([...BOARD_STATE_SCOPES], ["orch", "target"]);
  });
});

describe("deriveBoardState reused BYTE-FOR-BYTE for the Target board (issue #3434)", () => {
  // ADR-0031 Decision 3: no parallel Target board module — the SAME pure
  // bucketing function projects the Target's board. These fixtures pin that the
  // orch six-count + two-stale-list projection is correct over Target-label
  // rows (which is exactly the orch board-state set — the Target-specific
  // labels are write-side vocabulary, NOT read count fields).
  test("Target-scope rows bucket through the unchanged deriveBoardState", () => {
    const out = deriveBoardState(
      [
        row({ number: 1, labels: [TARGET_BOARD_LABELS.ready_for_agent] }),
        row({ number: 2, labels: [TARGET_BOARD_LABELS.needs_qa] }),
        row({ number: 3, labels: [TARGET_BOARD_LABELS.needs_triage] }),
        row({ number: 4, labels: [TARGET_BOARD_LABELS.needs_research] }),
        row({
          number: 5,
          labels: [TARGET_BOARD_LABELS.in_progress],
          updatedAt: isoSecondsAgo(STALE_IN_PROGRESS_SECONDS + 60),
        }),
        row({
          number: 6,
          labels: [TARGET_BOARD_LABELS.blocked],
          updatedAt: isoSecondsAgo(STALE_BLOCKED_SECONDS + 60),
        }),
      ],
      NOW_MS,
    );
    assert.equal(out.ready_for_agent, 1);
    assert.equal(out.needs_qa, 1);
    assert.equal(out.needs_triage, 1);
    assert.equal(out.needs_research, 1);
    assert.equal(out.in_progress, 1);
    assert.equal(out.blocked, 1);
    assert.deepEqual(out.stale_in_progress, [5]);
    assert.deepEqual(out.stale_blocked, [6]);
  });

  test("Target-specific labels are NOT surfaced as read count fields (deferred)", () => {
    // A row carrying only Target-specific qualifier labels contributes to no
    // board-state count — those labels are write-side vocabulary, not buckets.
    const out = deriveBoardState(
      [
        row({
          number: 1,
          labels: [
            TARGET_SPECIFIC_LABELS.money_critical,
            TARGET_SPECIFIC_LABELS.reframe,
            TARGET_SPECIFIC_LABELS.wire_or_retire,
          ],
        }),
      ],
      NOW_MS,
    );
    assert.equal(out.needs_qa, 0);
    assert.equal(out.ready_for_agent, 0);
    assert.equal(out.needs_triage, 0);
    assert.equal(out.needs_research, 0);
    assert.equal(out.in_progress, 0);
    assert.equal(out.blocked, 0);
    // The response Omit shape has no money_critical / reframe / wire_or_retire keys.
    assert.equal("money_critical" in out, false);
    assert.equal("reframe" in out, false);
    assert.equal("wire_or_retire" in out, false);
  });
});

describe("GET /autopilot/board-state?scope=target — route (issue #3434)", () => {
  test("scope=target buckets Target-label rows and stays never-throw", async () => {
    const res = await callRoute(
      {
        readOpenIssues: async () =>
          okResult([
            row({ number: 1, labels: [TARGET_BOARD_LABELS.ready_for_agent] }),
            row({ number: 2, labels: [TARGET_BOARD_LABELS.needs_qa] }),
          ]),
      },
      { scope: "target" },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.ready_for_agent, 1);
    assert.equal(res._body.needs_qa, 1);
    assert.equal(res._body.degraded, false);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("scope=target degrades to the all-zero board on a seam failure (never 500)", async () => {
    const res = await callRoute(
      {
        readOpenIssues: async () =>
          ({ ok: false, code: "gh-failed" } as IssueReadResult<IssueRow>),
      },
      { scope: "target" },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.ready_for_agent, 0);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });
});

describe("Target board-label leaf — single definition (issue #3434)", () => {
  test("mirrors the orch board-state set (reused, not re-spelled)", () => {
    assert.equal(TARGET_BOARD_LABELS.needs_qa, ORCH_BOARD_LABELS.needs_qa);
    assert.equal(
      TARGET_BOARD_LABELS.ready_for_agent,
      ORCH_BOARD_LABELS.ready_for_agent,
    );
    assert.equal(TARGET_BOARD_LABELS.needs_triage, ORCH_BOARD_LABELS.needs_triage);
    assert.equal(
      TARGET_BOARD_LABELS.needs_research,
      ORCH_BOARD_LABELS.needs_research,
    );
    assert.equal(TARGET_BOARD_LABELS.in_progress, ORCH_BOARD_LABELS.in_progress);
    assert.equal(TARGET_BOARD_LABELS.blocked, ORCH_BOARD_LABELS.blocked);
  });

  test("adds the three surviving Target-specific labels", () => {
    assert.equal(TARGET_BOARD_LABELS.money_critical, "money-critical");
    assert.equal(TARGET_BOARD_LABELS.reframe, "reframe");
    assert.equal(TARGET_BOARD_LABELS.wire_or_retire, "wire-or-retire");
  });

  test("excludes the orch-only target-backlog routing label", () => {
    // target-backlog is an ORCH-side routing label (#2704); no Target-repo
    // issue carries it, so it is not part of the Target board vocabulary.
    assert.equal(
      (Object.values(TARGET_BOARD_LABELS) as string[]).includes(
        "target-backlog",
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh degraded-path parity — the GLM partition (ADR-0032, #3754)
// ---------------------------------------------------------------------------

/**
 * `scripts/autopilot/collect-state.sh` reads `ready_for_agent` from the
 * orchestrator's `/autopilot/board-state` endpoint (which runs
 * `deriveBoardState` above). When that endpoint is DOWN or reports
 * `degraded:true`, it falls back to an inline `gh issue list --jq` that
 * re-spells the same bucketing in bash.
 *
 * The degraded path is reached when the orchestrator HTTP service (and thus
 * its Redis-backed heartbeat read) is unreachable, so the GLM drainer
 * heartbeat CANNOT be read there — that is the STALE condition. `deriveBoardState`
 * with a stale / absent heartbeat does NOT subtract `glm-eligible` (issue #3754:
 * fail-open toward work), so the degraded bash jq must match that STALE arm
 * exactly: it deliberately does NOT exclude `glm-eligible`. The healthy
 * endpoint path applies the (liveness-conditional) subtraction; this fallback
 * is the always-stale mirror. These cases run the committed bash filter
 * through real `jq` so the two implementations cannot drift.
 */
describe("collect-state.sh degraded fallback — glm-eligible partition (#3687, #3754)", () => {
  const COLLECTOR = join(
    resolve(import.meta.dirname, ".."),
    "scripts",
    "autopilot",
    "collect-state.sh",
  );

  /** Pull the `ready_for_agent:` line out of the committed fallback `--jq`. */
  function extractReadyForAgentFilter(): string {
    const src = readFileSync(COLLECTOR, "utf-8");
    const match = src.match(/^\s*ready_for_agent: (\[.*\] \| length),$/m);
    assert.ok(match, "could not locate the fallback ready_for_agent jq filter");
    return match[1];
  }

  function countReadyForAgent(
    filter: string,
    issues: readonly { labels: string[] }[],
  ): string {
    const input = issues.map((i) => ({
      labels: i.labels.map((name) => ({ name })),
    }));
    const r = spawnSync("jq", [filter], {
      input: JSON.stringify(input),
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `jq failed: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  }

  const filter = extractReadyForAgentFilter();

  test("plain ready-for-agent issues are counted", () => {
    assert.equal(
      countReadyForAgent(filter, [
        { labels: ["ready-for-agent"] },
        { labels: ["ready-for-agent", "enhancement"] },
        { labels: ["needs-triage"] },
      ]),
      "2",
    );
  });

  test("glm-eligible + ready-for-agent is COUNTED in the degraded (always-stale) path (#3754)", () => {
    // The degraded path cannot read the heartbeat, so it treats the drainer as
    // stale → fail-open → glm-eligible is NOT subtracted. The bash jq therefore
    // counts a drainer-owned issue so a down orchestrator never starves Opus.
    assert.equal(
      countReadyForAgent(filter, [
        { labels: ["ready-for-agent"] },
        { labels: ["ready-for-agent", "glm-eligible"] },
        { labels: ["glm-eligible"] },
      ]),
      "2",
      "the degraded bash path must mirror deriveBoardState's stale-heartbeat arm (count glm-eligible)",
    );
  });

  test("the pre-existing target-backlog exclusion still holds", () => {
    assert.equal(
      countReadyForAgent(filter, [
        { labels: ["ready-for-agent"] },
        { labels: ["ready-for-agent", "target-backlog"] },
      ]),
      "1",
      "issue #2704's exclusion is unconditional on liveness and must survive the #3754 edit",
    );
  });

  test("bash fallback agrees with deriveBoardState's STALE arm on the same board (#3754)", () => {
    // The load-bearing invariant: the degraded bash path (always stale) must
    // match deriveBoardState with a stale/absent heartbeat (partition inactive)
    // — same input, same number, either path. glm-eligible rows are COUNTED.
    const board = [
      { labels: ["ready-for-agent"] },
      { labels: ["ready-for-agent", "glm-eligible"] },
      { labels: ["ready-for-agent", "target-backlog"] },
      { labels: ["ready-for-agent", "glm-eligible", "target-backlog"] },
      { labels: ["needs-qa"] },
    ];
    const bash = Number(countReadyForAgent(filter, board));
    // Default deriveBoardState (no liveness resolved) = partition inactive =
    // the stale-heartbeat arm the degraded path mirrors.
    const ts = deriveBoardState(
      board.map((b, i) => row({ number: i + 1, labels: b.labels })),
      NOW_MS,
    ).ready_for_agent;
    assert.equal(bash, ts, "degraded bash path must match the TS stale-arm exactly");
    assert.equal(ts, 2);
  });
});

// ---------------------------------------------------------------------------
// deriveBoardState — GLM liveness gates the glm-eligible partition (#3754)
// ---------------------------------------------------------------------------

describe("deriveBoardState — GLM liveness gates the glm-eligible partition (#3754)", () => {
  // row 1 = plain ready-for-agent (always counts); row 2 = drainer-owned
  // (counted only when the partition is inactive); row 3 = target-backlog
  // (never counts).
  const board = [
    row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
    row({
      number: 2,
      labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.glm_eligible],
    }),
    row({
      number: 3,
      labels: [
        ORCH_BOARD_LABELS.ready_for_agent,
        ORCH_BOARD_LABELS.target_backlog,
      ],
    }),
  ];

  test("partition ACTIVE (drainer live) → glm-eligible excluded", () => {
    assert.equal(
      deriveBoardState(board, NOW_MS, new Set(), true).ready_for_agent,
      1,
    );
  });

  test("partition INACTIVE (stale/absent) → glm-eligible counted (fail-open)", () => {
    assert.equal(
      deriveBoardState(board, NOW_MS, new Set(), false).ready_for_agent,
      2,
    );
  });

  test("default (no liveness arg) = inactive = fail-open toward work", () => {
    assert.equal(deriveBoardState(board, NOW_MS).ready_for_agent, 2);
  });

  test("target-backlog stays excluded regardless of partition liveness", () => {
    // row 3 never counts in either arm; only the glm-eligible row toggles.
    assert.equal(
      deriveBoardState(board, NOW_MS, new Set(), true).ready_for_agent,
      1,
    );
    assert.equal(
      deriveBoardState(board, NOW_MS, new Set(), false).ready_for_agent,
      2,
    );
  });

  test("the partition flag does not touch the other board counts", () => {
    const other = [
      row({
        number: 10,
        labels: [
          ORCH_BOARD_LABELS.glm_eligible,
          ORCH_BOARD_LABELS.needs_qa,
          ORCH_BOARD_LABELS.in_progress,
        ],
      }),
    ];
    const active = deriveBoardState(other, NOW_MS, new Set(), true);
    const inactive = deriveBoardState(other, NOW_MS, new Set(), false);
    assert.equal(active.needs_qa, 1);
    assert.equal(active.in_progress, 1);
    assert.equal(inactive.needs_qa, 1);
    assert.equal(inactive.in_progress, 1);
  });
});

// ---------------------------------------------------------------------------
// src/redis/autopilot.ts — GLM drainer heartbeat liveness accessor (#3754)
// ---------------------------------------------------------------------------

describe("src/redis/autopilot.ts — GLM drainer heartbeat liveness (#3754)", () => {
  // Self-contained Redis lifecycle: open one client for the suite, close it at
  // the end, and wipe the heartbeat key before each case so cases stay
  // isolated. The accessor under test uses the shared connection singleton
  // (same DB via REDIS_URL); this client only sets/clears the key.
  let redis: any;
  before(() => {
    redis = new Redis(REDIS_URL);
  });
  after(async () => {
    if (redis) {
      await redis.del(GLM_DRAINER_ACTIVE_KEY);
      redis.disconnect();
    }
  });
  beforeEach(async () => {
    await redis.del(GLM_DRAINER_ACTIVE_KEY);
  });

  test("absent key => not live, reason absent, no heartbeatMs", async () => {
    const l = await getGlmDrainerLiveness(Date.now());
    assert.equal(l.live, false);
    assert.equal(l.reason, "absent");
    assert.equal(l.heartbeatMs, null);
  });

  test("fresh heartbeat (within the 45min window) => live, reason fresh", async () => {
    const now = Date.now();
    const hb = now - 10 * 60 * 1000; // 10 min ago
    await redis.set(GLM_DRAINER_ACTIVE_KEY, String(hb));
    const l = await getGlmDrainerLiveness(now);
    assert.equal(l.live, true);
    assert.equal(l.reason, "fresh");
    assert.equal(l.heartbeatMs, hb);
  });

  test("stale heartbeat (older than 45min) => not live, reason stale", async () => {
    const now = Date.now();
    const hb = now - (GLM_DRAINER_HEARTBEAT_STALE_MS + 60_000); // just past window
    await redis.set(GLM_DRAINER_ACTIVE_KEY, String(hb));
    const l = await getGlmDrainerLiveness(now);
    assert.equal(l.live, false);
    assert.equal(l.reason, "stale");
    assert.equal(l.heartbeatMs, hb);
  });

  test("boundary: just-under the window is fresh, just-over is stale", async () => {
    const now = Date.now();
    await redis.set(
      GLM_DRAINER_ACTIVE_KEY,
      String(now - (GLM_DRAINER_HEARTBEAT_STALE_MS - 1000)),
    );
    assert.equal((await getGlmDrainerLiveness(now)).live, true);
    await redis.set(
      GLM_DRAINER_ACTIVE_KEY,
      String(now - (GLM_DRAINER_HEARTBEAT_STALE_MS + 1000)),
    );
    assert.equal((await getGlmDrainerLiveness(now)).live, false);
  });

  test("unreadable value => not live, reason unreadable, no heartbeatMs", async () => {
    await redis.set(GLM_DRAINER_ACTIVE_KEY, "not-a-number");
    const l = await getGlmDrainerLiveness(Date.now());
    assert.equal(l.live, false);
    assert.equal(l.reason, "unreadable");
    assert.equal(l.heartbeatMs, null);
  });

  test("the staleness threshold is 45 minutes (three 15-min ticks)", () => {
    assert.equal(GLM_DRAINER_HEARTBEAT_STALE_MS, 45 * 60 * 1000);
  });

  // -------------------------------------------------------------------------
  // setGlmDrainerHeartbeat — the write side (issue #3689). Reuses this
  // describe's before/after/beforeEach lifecycle rather than nesting a new
  // suite: both halves hit the same GLM_DRAINER_ACTIVE_KEY, so sharing the
  // teardown is the documented "reuse the suite that already owns it" option
  // (CLAUDE.md's shared-Redis-teardown pitfall), not a risky piggyback.
  // -------------------------------------------------------------------------

  test("setGlmDrainerHeartbeat writes a value getGlmDrainerLiveness reads back as fresh", async () => {
    const now = Date.now();
    const r = await setGlmDrainerHeartbeat(now);
    assert.equal(r.ok, true);
    const stored = await redis.get(GLM_DRAINER_ACTIVE_KEY);
    assert.equal(stored, String(now));
    const l = await getGlmDrainerLiveness(now);
    assert.equal(l.live, true);
    assert.equal(l.reason, "fresh");
    assert.equal(l.heartbeatMs, now);
  });

  test("setGlmDrainerHeartbeat defaults nowMs to Date.now() when omitted", async () => {
    const before = Date.now();
    const r = await setGlmDrainerHeartbeat();
    const after = Date.now();
    assert.equal(r.ok, true);
    const stored = Number(await redis.get(GLM_DRAINER_ACTIVE_KEY));
    assert.ok(stored >= before && stored <= after, `${stored} not within [${before}, ${after}]`);
  });

  test("setGlmDrainerHeartbeat sets a TTL (hygiene only — staleness itself is age-based)", async () => {
    await setGlmDrainerHeartbeat(Date.now());
    const ttl = await redis.ttl(GLM_DRAINER_ACTIVE_KEY);
    assert.ok(ttl > 0, `expected a positive TTL, got ${ttl}`);
    assert.ok(
      ttl <= GLM_DRAINER_HEARTBEAT_TTL_SECONDS,
      `TTL ${ttl} should not exceed the configured ${GLM_DRAINER_HEARTBEAT_TTL_SECONDS}`,
    );
  });

  test("the heartbeat TTL is 2x the staleness window (90 min)", () => {
    assert.equal(
      GLM_DRAINER_HEARTBEAT_TTL_SECONDS,
      Math.ceil((GLM_DRAINER_HEARTBEAT_STALE_MS * 2) / 1000),
    );
    assert.equal(GLM_DRAINER_HEARTBEAT_TTL_SECONDS, 90 * 60);
  });

  test("repeated writes overwrite the previous value (not accumulate)", async () => {
    await setGlmDrainerHeartbeat(1000);
    await setGlmDrainerHeartbeat(2000);
    const stored = await redis.get(GLM_DRAINER_ACTIVE_KEY);
    assert.equal(stored, "2000");
  });
});

// ---------------------------------------------------------------------------
// src/redis/autopilot.ts — GLM A/B assignment log (issue #4125)
// ---------------------------------------------------------------------------
//
// A NEW top-level describe with its OWN before/after/beforeEach lifecycle
// (CLAUDE.md's shared-Redis-teardown pitfall) rather than nesting inside the
// heartbeat suite above: that suite's `after()` disconnects its own `redis`
// client when IT finishes, which would tear down a connection this suite
// still needs if it ran as a nested child instead of a sibling top-level
// suite. `recordGlmAbAssignment` under test uses the shared connection
// singleton (same REDIS_URL/DB); this client only sets up/tears down the
// per-issue keys the accessor reads and writes.

describe("src/redis/autopilot.ts — GLM A/B assignment log (issue #4125)", () => {
  let redis: any;
  const testIssues = [90001, 90002, 90003];

  before(() => {
    redis = new Redis(REDIS_URL);
  });
  after(async () => {
    if (redis) {
      await redis.del(...testIssues.map((n) => glmAbAssignmentKey(n)));
      redis.disconnect();
    }
  });
  beforeEach(async () => {
    await redis.del(...testIssues.map((n) => glmAbAssignmentKey(n)));
  });

  function record(issue: number, arm: "treatment" | "control"): GlmAbAssignmentRecord {
    return { issue, arm, assignedAt: "2026-08-29T00:00:00.000Z", sweepRunId: "test-run" };
  }

  // -------------------------------------------------------------------------
  // recordGlmAbAssignment — the WRITE-path guard
  // -------------------------------------------------------------------------

  test("first assignment for an issue: plants the record and reports ok:true", async () => {
    const candidate = record(90001, "control");
    const res = await recordGlmAbAssignment(candidate);
    assert.equal(res.ok, true);
    const stored = await redis.get(glmAbAssignmentKey(90001));
    assert.deepEqual(JSON.parse(stored), candidate);
  });

  test("defense-in-depth race: a second write for an already-assigned issue reports ok:false and does NOT overwrite the first record", async () => {
    const first = record(90002, "treatment");
    const second = record(90002, "control"); // deliberately a different arm

    const res1 = await recordGlmAbAssignment(first);
    assert.equal(res1.ok, true);

    const res2 = await recordGlmAbAssignment(second);
    assert.equal(res2.ok, false, "SET NX finding an existing key is reported as a write failure, not silently accepted");

    // Only the FIRST write ever lands in Redis — the second call never overwrote it.
    const stored = await redis.get(glmAbAssignmentKey(90002));
    assert.deepEqual(JSON.parse(stored), first);
  });

  test("distinct issues get independent records", async () => {
    const a = record(90001, "control");
    const b = record(90003, "treatment");
    await recordGlmAbAssignment(a);
    await recordGlmAbAssignment(b);

    assert.deepEqual(JSON.parse(await redis.get(glmAbAssignmentKey(90001))), a);
    assert.deepEqual(JSON.parse(await redis.get(glmAbAssignmentKey(90003))), b);
  });

  // -------------------------------------------------------------------------
  // getGlmAbAssignment — the READ-path guard (issue #4125)
  // -------------------------------------------------------------------------

  test("getGlmAbAssignment: absent key -> ok:true, record:null (safe to coin-flip)", async () => {
    const res = await getGlmAbAssignment(90001);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.record, null);
    }
  });

  test("getGlmAbAssignment: a planted record is read back verbatim", async () => {
    const candidate = record(90001, "control");
    await recordGlmAbAssignment(candidate);
    const res = await getGlmAbAssignment(90001);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.record, candidate);
    }
  });

  test("getGlmAbAssignment: an unparseable stored value fails closed (ok:false)", async () => {
    await redis.set(glmAbAssignmentKey(90001), "not-json{{{");
    const res = await getGlmAbAssignment(90001);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "glm-ab-assignment-read-failed");
    }
  });

  test("glmAbAssignmentKey is per-issue and stable", () => {
    assert.equal(glmAbAssignmentKey(42), "hydra:glm:ab:assignment:42");
    assert.equal(glmAbAssignmentKey(42), glmAbAssignmentKey(42));
    assert.notEqual(glmAbAssignmentKey(42), glmAbAssignmentKey(43));
  });
});

// ---------------------------------------------------------------------------
// GET /autopilot/board-state — GLM liveness wires the partition (#3754)
// ---------------------------------------------------------------------------

describe("GET /autopilot/board-state — GLM liveness wires the partition (#3754)", () => {
  // row 1 always counts; row 2 (drainer-owned) counts only when inactive.
  const board = (): IssueRow[] => [
    row({ number: 1, labels: [ORCH_BOARD_LABELS.ready_for_agent] }),
    row({
      number: 2,
      labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.glm_eligible],
    }),
  ];

  test("a LIVE drainer excludes glm-eligible from ready_for_agent", async () => {
    const res = await callRoute({
      readOpenIssues: async () => okResult(board()),
      glmDrainerLiveness: async () => true,
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.ready_for_agent, 1);
    assert.equal(res._body.degraded, false);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("a STALE drainer counts glm-eligible (fail-open toward work)", async () => {
    const res = await callRoute({
      readOpenIssues: async () => okResult(board()),
      glmDrainerLiveness: async () => false,
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.ready_for_agent, 2);
    assert.equal(res._body.degraded, false);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });

  test("a liveness reader that THROWS fails open (work visible) and never 500s", async () => {
    const res = await callRoute({
      readOpenIssues: async () => okResult(board()),
      glmDrainerLiveness: async () => {
        throw new Error("redis down");
      },
    });
    assert.equal(res._status, 200);
    // The liveness read failure does NOT degrade the board — it only forces
    // the partition inactive, so glm-eligible stays visible to Opus.
    assert.equal(res._body.degraded, false);
    assert.equal(res._body.ready_for_agent, 2);
    AutopilotBoardStateResponseSchema.parse(res._body);
  });
});
