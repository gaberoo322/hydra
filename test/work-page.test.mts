/**
 * Regression tests for the /work dashboard page (issue #4010 — dashboard v3
 * slice epsilon, ADR-0034 §2: "what is queued, what is next, and why that").
 *
 * The dashboard ships no JSX test runner and the worktree resolves no
 * `react`, so — exactly like test/health-page.test.mts and
 * test/runs-page.test.mts — the slice is pinned at the boundaries that ARE
 * mechanically checkable:
 *
 *   1. The PURE derivations the page's behaviour keys off, imported from the
 *      react-free server module src/api/autopilot-board.ts: lane resolution,
 *      queue projection + ordering, the promote-refusal decision table
 *      (INV-5), and the relabel transition plan.
 *   2. The HTTP boundary of the three server surfaces this slice adds or
 *      extends: GET /autopilot/work-queue, the four POST board actions
 *      (INV-6 verify-spine), and GET /autopilot/board-state's additive
 *      sourcesOk (INV-3) — all with injected deps, no live gh/Redis.
 *   3. Structural source pins for the JSX half that cannot be imported:
 *      route wiring, the usePageItems/derivePageStatus trust delegation
 *      (INV-2), the confirm-first promote control (INV-5), zero run-history
 *      fetches (INV-1), the gh issue family + issues.ts left untouched
 *      (INV-7/INV-8), and anchor-distribution's boundary-stamped trust
 *      fields (INV-4).
 *
 * Lifecycle: top-level describes with their OWN before/after (per the
 * CLAUDE.md shared-Redis-teardown authoring rule — nothing here nests under
 * a sibling suite's after(), and no Redis is opened at all: every HTTP test
 * injects its readers/writers).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createAutopilotBoardRouter,
  deriveWorkLane,
  toWorkQueueRow,
  compareWorkQueueRows,
  evaluatePromoteEligibility,
  computeRelabelTransitions,
} from "../src/api/autopilot-board.ts";
import {
  hasScopeSection,
  extractScopeFromBody,
} from "../src/scope-section.ts";
import { extractScopeFromBody as extractScopeFromBodyViaCi } from "../scripts/ci/scope-check.ts";
import { projectAnchorDistribution } from "../src/metrics/stats-projection.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query: {}, params: {}, body: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
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

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/** One IssueRow fixture — the fields listOpenIssues/viewIssue normalise. */
function issue(overrides: any = {}): any {
  return {
    number: 1,
    title: "Example issue",
    url: "https://github.com/gaberoo322/hydra/issues/1",
    createdAt: "2026-08-01T00:00:00Z",
    labels: [] as string[],
    body: "## Files in scope\n\n- `src/a.ts`\n- `test/a.test.mts`",
    state: "OPEN",
    updatedAt: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

/** A view() seam over a scripted row sequence; the string "FAIL" fails. */
function seqView(rows: any[]) {
  const q = [...rows];
  // Return-typed `any`: the scripted literals widen `ok` to boolean, which
  // no longer matches IssueViewResult's literal arms under strict:false.
  const view: any = async (_n: number) => {
    const next: any = q.shift();
    if (next === "FAIL") return { ok: false, code: "gh-failed" };
    return { ok: true, row: next };
  };
  return view;
}

/** A write seam that records every call and returns the scripted result. */
function recorder(result: any = { ok: true }) {
  const calls: any[][] = [];
  const fn = async (...args: any[]) => {
    calls.push(args);
    return result;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// deriveWorkLane
// ---------------------------------------------------------------------------

describe("deriveWorkLane — first WORK_QUEUE_LANES match wins", () => {
  test("ready-for-agent outranks a stray needs-triage (dispatch signal is the stronger claim)", () => {
    assert.equal(deriveWorkLane(["needs-triage", "ready-for-agent"]), "ready-for-agent");
  });

  test("resolves each operator lane", () => {
    assert.equal(deriveWorkLane(["needs-info"]), "needs-info");
    assert.equal(deriveWorkLane(["needs-triage"]), "needs-triage");
    assert.equal(deriveWorkLane(["blocked"]), "blocked");
    assert.equal(deriveWorkLane(["ready-for-human"]), "ready-for-human");
    assert.equal(deriveWorkLane(["ready-for-agent"]), "ready-for-agent");
  });

  test("agent-owned / unknown labels → null, never a guess", () => {
    assert.equal(deriveWorkLane(["in-progress"]), null);
    assert.equal(deriveWorkLane(["needs-qa"]), null);
    assert.equal(deriveWorkLane([]), null);
    assert.equal(deriveWorkLane(["glm-eligible", "target-backlog"]), null);
  });
});

// ---------------------------------------------------------------------------
// toWorkQueueRow
// ---------------------------------------------------------------------------

describe("toWorkQueueRow — queue projection", () => {
  test("projects lane, url, updatedAt, glm eligibility", () => {
    const row = toWorkQueueRow(
      issue({ number: 7, labels: ["ready-for-agent", "glm-eligible"] }),
      new Set(),
    );
    assert.ok(row);
    assert.equal(row!.number, 7);
    assert.equal(row!.lane, "ready-for-agent");
    assert.equal(row!.glmEligible, true);
    assert.equal(row!.updatedAt, "2026-08-10T00:00:00Z");
    assert.deepEqual(row!.openBlockers, []);
  });

  test("ready row: openBlockers = strict refs ∩ open set, self-refs and closed refs dropped", () => {
    const row = toWorkQueueRow(
      issue({
        number: 5,
        labels: ["ready-for-agent"],
        body: "## Files in scope\n\n- `src/a.ts`\n\nBlocked by #9\nblocks #5\ndepends on #12",
      }),
      new Set([9, 11]),
    );
    assert.ok(row);
    assert.deepEqual(row!.openBlockers, [9]); // #5 self-ref dropped, #12 not open
  });

  test("non-ready lanes never surface blockers (only the ready population is resolved)", () => {
    const row = toWorkQueueRow(
      issue({ number: 5, labels: ["needs-triage"], body: "Blocked by #9" }),
      new Set([9]),
    );
    assert.ok(row);
    assert.deepEqual(row!.openBlockers, []);
  });

  test("no operator lane → null (not in the queue)", () => {
    assert.equal(toWorkQueueRow(issue({ labels: ["in-progress"] }), new Set()), null);
  });
});

// ---------------------------------------------------------------------------
// compareWorkQueueRows
// ---------------------------------------------------------------------------

describe("compareWorkQueueRows — lane order, then oldest first", () => {
  test("ready-for-agent sorts ahead of every other lane", () => {
    const ready = { lane: "ready-for-agent", updatedAt: "2026-08-10T00:00:00Z" } as any;
    const triage = { lane: "needs-triage", updatedAt: "2026-01-01T00:00:00Z" } as any;
    assert.ok(compareWorkQueueRows(ready, triage) < 0);
    assert.ok(compareWorkQueueRows(triage, ready) > 0);
  });

  test("within a lane, oldest updatedAt first", () => {
    const older = { lane: "needs-info", updatedAt: "2026-08-01T00:00:00Z" } as any;
    const newer = { lane: "needs-info", updatedAt: "2026-08-09T00:00:00Z" } as any;
    assert.ok(compareWorkQueueRows(older, newer) < 0);
  });

  test("unparseable updatedAt sorts LAST, never ahead of a dated row", () => {
    const undated = { lane: "blocked", updatedAt: "" } as any;
    const dated = { lane: "blocked", updatedAt: "2026-08-01T00:00:00Z" } as any;
    assert.ok(compareWorkQueueRows(undated, dated) > 0);
    assert.ok(compareWorkQueueRows(dated, undated) < 0);
  });
});

// ---------------------------------------------------------------------------
// evaluatePromoteEligibility — INV-5's refusal decision table
// ---------------------------------------------------------------------------

describe("evaluatePromoteEligibility — promote refusal table (INV-5)", () => {
  test("clean open issue with a Files-in-scope section is eligible", () => {
    assert.deepEqual(
      evaluatePromoteEligibility(issue({ labels: [] }), new Set()),
      { eligible: true },
    );
  });

  test("closed → refused as closed", () => {
    const e = evaluatePromoteEligibility(issue({ state: "CLOSED" }), new Set());
    assert.equal(e.eligible, false);
    assert.equal((e as any).reason, "closed");
  });

  test("already carries ready-for-agent → refused as already-ready", () => {
    const e = evaluatePromoteEligibility(
      issue({ labels: ["ready-for-agent"] }),
      new Set(),
    );
    assert.equal(e.eligible, false);
    assert.equal((e as any).reason, "already-ready");
  });

  test("body lacks a ## Files in scope section → refused as missing-scope-section", () => {
    const e = evaluatePromoteEligibility(
      issue({ body: "Just a description, no scope section." }),
      new Set(),
    );
    assert.equal(e.eligible, false);
    assert.equal((e as any).reason, "missing-scope-section");
    // The detail names the invariant this mirrors (#396) so the operator UI
    // explains the refusal.
    assert.match((e as any).detail, /Files in scope/);
  });

  test("cites an OPEN strict blocker → refused as blocked (with the blocker number)", () => {
    const e = evaluatePromoteEligibility(
      issue({ body: "## Files in scope\n\n- `src/a.ts`\n\nBlocked by #4211" }),
      new Set([4211]),
    );
    assert.equal(e.eligible, false);
    assert.equal((e as any).reason, "blocked");
    assert.match((e as any).detail, /#4211/);
  });

  test("a CLOSED or absent blocker does not refuse — only open ones gate", () => {
    const e = evaluatePromoteEligibility(
      issue({ body: "## Files in scope\n\n- `src/a.ts`\n\nBlocked by #4211" }),
      new Set(),
    );
    assert.deepEqual(e, { eligible: true });
  });

  test("self-reference never blocks the issue itself", () => {
    const e = evaluatePromoteEligibility(
      issue({ number: 3, body: "## Files in scope\n\n- `src/a.ts`\n\nblocked by: #3" }),
      new Set([3]),
    );
    assert.deepEqual(e, { eligible: true });
  });

  test("precedence: closed is checked before already-ready", () => {
    const e = evaluatePromoteEligibility(
      issue({ state: "CLOSED", labels: ["ready-for-agent"] }),
      new Set(),
    );
    assert.equal((e as any).reason, "closed");
  });
});

// ---------------------------------------------------------------------------
// computeRelabelTransitions
// ---------------------------------------------------------------------------

describe("computeRelabelTransitions — the lane-move plan", () => {
  test("moving lanes drops the other relabel lanes and adds the target", () => {
    assert.deepEqual(
      computeRelabelTransitions(["needs-triage", "bug"], "needs-info"),
      { remove: ["needs-triage"], add: true },
    );
  });

  test("already on target → no-op (nothing removed, nothing added)", () => {
    assert.deepEqual(
      computeRelabelTransitions(["blocked"], "blocked"),
      { remove: [], add: false },
    );
  });

  test("drops EVERY other relabel lane in one move", () => {
    assert.deepEqual(
      computeRelabelTransitions(["needs-triage", "needs-info", "blocked"], "ready-for-human"),
      { remove: ["needs-triage", "needs-info", "blocked"], add: true },
    );
  });

  test("non-lane labels (agent-owned, provenance) are never touched", () => {
    assert.deepEqual(
      computeRelabelTransitions(["in-progress", "needs-qa"], "needs-triage"),
      { remove: [], add: true },
    );
  });
});

// ---------------------------------------------------------------------------
// hasScopeSection — the ONE parser, shared with the CI scope gate
// ---------------------------------------------------------------------------

describe("hasScopeSection — promote gate reuses the CI scope parser (INV-5)", () => {
  test("a real Files-in-scope section is present", () => {
    assert.equal(hasScopeSection("## Files in scope\n\n- `src/a.ts`"), true);
    assert.equal(hasScopeSection("Some prose.\n\n**Files in scope**\n\n- src/a.ts"), true);
  });

  test("no section → absent (never a fabricated scope)", () => {
    assert.equal(hasScopeSection(""), false);
    assert.equal(hasScopeSection("## Files out of scope\n\n- `src/api.ts`"), false);
    assert.equal(hasScopeSection("## Implementation\n\nDo the thing."), false);
  });

  test("agree with extractScopeFromBody on a corpus — no second parser drifted", () => {
    const corpus = [
      "",
      "## Files in scope\n\n- `src/a.ts`",
      "no scope",
      "## Files in scope\n\n- dashboard/src/pages/Work.jsx",
      "## Files out of scope\n\n- `src/api.ts`",
      "prose\n\nFiles in scope\n- src/a.ts\n- test/a.test.mts\n",
    ];
    for (const body of corpus) {
      assert.equal(
        hasScopeSection(body),
        extractScopeFromBody(body).length > 0,
        `disagreement on ${JSON.stringify(body)}`,
      );
    }
  });

  test("the CI gate's re-export IS the src leaf's implementation (one parser)", () => {
    assert.equal(extractScopeFromBodyViaCi, extractScopeFromBody);
  });
});

// ---------------------------------------------------------------------------
// GET /autopilot/board-state + /autopilot/work-queue — the read boundary
// ---------------------------------------------------------------------------

describe("GET /autopilot/board-state — additive sourcesOk (INV-3)", () => {
  function routerWith(read: any, overrides: any = {}) {
    return createAutopilotBoardRouter({
      readOpenIssues: read,
      resolveOpenBlockers: async () => new Set(),
      glmDrainerLiveness: async () => false,
      ...overrides,
    });
  }

  test("clean read → sourcesOk:true alongside untouched legacy fields", async () => {
    const router = routerWith(async () => ({
      ok: true,
      rows: [issue({ number: 1, labels: ["ready-for-agent"] })],
    }));
    const handler = findHandler(router, "GET", "/autopilot/board-state");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, false);
    assert.equal(res._body.sourcesOk, true); // the additive field
    assert.equal(res._body.ready_for_agent, 1); // legacy count survives
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
  });

  test("failed read → degraded:true AND sourcesOk:false (never a confident all-zero board)", async () => {
    const router = routerWith(async () => ({ ok: false, code: "gh-failed" }));
    const handler = findHandler(router, "GET", "/autopilot/board-state");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.equal(res._body.sourcesOk, false);
    assert.equal(res._body.ready_for_agent, 0);
  });
});

describe("GET /autopilot/work-queue — the queue read", () => {
  function routerWith(read: any, overrides: any = {}) {
    return createAutopilotBoardRouter({
      readOpenIssues: read,
      resolveOpenBlockers: async () => new Set(),
      glmDrainerLiveness: async () => false,
      ...overrides,
    });
  }

  test("projects open issues into sorted lane rows with trust fields", async () => {
    const router = routerWith(async () => ({
      ok: true,
      rows: [
        issue({ number: 2, labels: ["needs-triage"], updatedAt: "2026-08-01T00:00:00Z" }),
        issue({ number: 1, labels: ["ready-for-agent"], updatedAt: "2026-08-05T00:00:00Z" }),
        issue({ number: 3, labels: ["in-progress"] }), // agent-owned: not queued
      ],
    }));
    const handler = findHandler(router, "GET", "/autopilot/work-queue");
    assert.ok(handler, "GET /autopilot/work-queue route not found");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.scanned, 3);
    assert.equal(res._body.sourcesOk, true);
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
    assert.deepEqual(
      res._body.items.map((r: any) => r.number),
      [1, 2], // ready lane first; agent-owned row dropped
    );
    assert.equal(res._body.items[0].lane, "ready-for-agent");
    assert.equal(res._body.items[1].lane, "needs-triage");
  });

  test("degraded read → sourcesOk:false with an EMPTY queue (UNKNOWN, not a confident zero)", async () => {
    const router = routerWith(async () => ({ ok: false, code: "gh-failed" }));
    const handler = findHandler(router, "GET", "/autopilot/work-queue");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, false);
    assert.equal(res._body.scanned, 0);
    assert.deepEqual(res._body.items, []);
  });

  test("clean empty board → sourcesOk:true (an ASSERTED empty the page renders as empty)", async () => {
    const router = routerWith(async () => ({ ok: true, rows: [] }));
    const handler = findHandler(router, "GET", "/autopilot/work-queue");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.sourcesOk, true);
    assert.deepEqual(res._body.items, []);
  });
});

// ---------------------------------------------------------------------------
// POST /autopilot/board/* — the action verify-spine (INV-6)
// ---------------------------------------------------------------------------

describe("POST /autopilot/board/promote — confirm-gated, refusal reasons surface (INV-5)", () => {
  function routerWith(overrides: any) {
    return createAutopilotBoardRouter({
      resolveOpenBlockers: async () => new Set(),
      ...overrides,
    });
  }

  test("no confirm:true → 400 schema-validation-failed BEFORE any write", async () => {
    const add = recorder();
    const router = routerWith({ view: seqView([]), addLabel: add.fn });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42 } }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.equal(add.calls.length, 0);
  });

  test("missing Files-in-scope section → 200 refusal, reason missing-scope-section, NO write", async () => {
    const add = recorder();
    const router = routerWith({
      view: seqView([issue({ number: 42, body: "no scope section here" })]),
      addLabel: add.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42, confirm: true } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "missing-scope-section");
    assert.match(res._body.detail, /Files in scope/);
    assert.equal(add.calls.length, 0);
  });

  test("open strict blocker → 200 refusal, reason blocked, NO write", async () => {
    const add = recorder();
    const router = routerWith({
      view: seqView([
        issue({ number: 42, body: "## Files in scope\n\n- `src/a.ts`\n\nBlocked by #7" }),
      ]),
      addLabel: add.fn,
      resolveOpenBlockers: async () => new Set([7]),
    });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42, confirm: true } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "blocked");
    assert.match(res._body.detail, /#7/);
    assert.equal(add.calls.length, 0);
  });

  test("happy path → addLabel rides the one proven surface; verified carries the OBSERVED post state", async () => {
    const add = recorder();
    const router = routerWith({
      view: seqView([
        issue({ number: 42, labels: [] }),
        issue({ number: 42, labels: ["ready-for-agent"] }),
      ]),
      addLabel: add.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42, confirm: true } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.verified.state, "OPEN");
    assert.deepEqual(res._body.verified.labels, ["ready-for-agent"]);
    assert.deepEqual(add.calls, [[42, "ready-for-agent"]]);
  });

  test("write accepted but post state lacks the label → write-unverified, never success", async () => {
    const add = recorder();
    const router = routerWith({
      view: seqView([
        issue({ number: 42, labels: [] }),
        issue({ number: 42, labels: [] }), // post-read: label never landed
      ]),
      addLabel: add.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42, confirm: true } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "write-unverified");
    assert.equal(add.calls.length, 1); // the write DID fire; the VERIFY caught it
  });

  test("gh write failure → write-failed with the code, no success", async () => {
    const router = routerWith({
      view: seqView([issue({ number: 42, labels: [] })]),
      addLabel: recorder({ ok: false, code: "gh-failed", stderr: "label quota" }).fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42, confirm: true } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "write-failed");
    assert.match(res._body.detail, /gh-failed/);
  });

  test("pre-write re-read fails → read-failed, no write attempted", async () => {
    const add = recorder();
    const router = routerWith({ view: seqView(["FAIL"]), addLabel: add.fn });
    const handler = findHandler(router, "POST", "/autopilot/board/promote");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 42, confirm: true } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "read-failed");
    assert.equal(add.calls.length, 0);
  });
});

describe("POST /autopilot/board/relabel — immediate-tier lane move", () => {
  test("closed issue → refused as closed, no writes", async () => {
    const remove = recorder();
    const add = recorder();
    const router = createAutopilotBoardRouter({
      view: seqView([issue({ number: 9, state: "CLOSED", labels: ["needs-triage"] })]),
      removeLabel: remove.fn,
      addLabel: add.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/relabel");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 9, label: "blocked" } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "closed");
    assert.equal(remove.calls.length + add.calls.length, 0);
  });

  test("happy path: remove the old lane, add the target, verify the OBSERVED labels", async () => {
    const remove = recorder();
    const add = recorder();
    const router = createAutopilotBoardRouter({
      view: seqView([
        issue({ number: 9, labels: ["needs-triage"] }),
        issue({ number: 9, labels: ["blocked"] }),
      ]),
      removeLabel: remove.fn,
      addLabel: add.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/relabel");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 9, label: "blocked" } }), res);
    assert.equal(res._body.ok, true);
    assert.deepEqual(remove.calls, [[9, "needs-triage"]]);
    assert.deepEqual(add.calls, [[9, "blocked"]]);
    assert.deepEqual(res._body.verified.labels, ["blocked"]);
  });

  test("already on target → zero-write move, still verified by the re-read", async () => {
    const remove = recorder();
    const add = recorder();
    const router = createAutopilotBoardRouter({
      view: seqView([
        issue({ number: 9, labels: ["blocked"] }),
        issue({ number: 9, labels: ["blocked"] }),
      ]),
      removeLabel: remove.fn,
      addLabel: add.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/relabel");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 9, label: "blocked" } }), res);
    assert.equal(res._body.ok, true);
    assert.equal(remove.calls.length + add.calls.length, 0);
  });

  test("a non-target lane survives the write → write-unverified", async () => {
    const router = createAutopilotBoardRouter({
      view: seqView([
        issue({ number: 9, labels: ["needs-triage"] }),
        issue({ number: 9, labels: ["needs-triage", "blocked"] }), // remove never landed
      ]),
      removeLabel: recorder().fn,
      addLabel: recorder().fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/relabel");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 9, label: "blocked" } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "write-unverified");
  });

  test("unknown target label → 400 schema-validation-failed", async () => {
    const router = createAutopilotBoardRouter({ view: seqView([]) });
    const handler = findHandler(router, "POST", "/autopilot/board/relabel");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 9, label: "needs-qa" } }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

describe("POST /autopilot/board/close + /reopen — immediate-tier state writes", () => {
  test("close: verified only against the OBSERVED post state", async () => {
    const close = recorder();
    const router = createAutopilotBoardRouter({
      view: seqView([
        issue({ number: 5, state: "OPEN" }),
        issue({ number: 5, state: "CLOSED" }),
      ]),
      close: close.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/close");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 5 } }), res);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.verified.state, "CLOSED");
    assert.deepEqual(close.calls, [[5]]);
  });

  test("close whose post state stays OPEN → write-unverified", async () => {
    const router = createAutopilotBoardRouter({
      view: seqView([
        issue({ number: 5, state: "OPEN" }),
        issue({ number: 5, state: "OPEN" }),
      ]),
      close: recorder().fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/close");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 5 } }), res);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.reason, "write-unverified");
  });

  test("reopen: verified against the observed OPEN state", async () => {
    const reopen = recorder();
    const router = createAutopilotBoardRouter({
      view: seqView([
        issue({ number: 5, state: "CLOSED" }),
        issue({ number: 5, state: "OPEN" }),
      ]),
      reopen: reopen.fn,
    });
    const handler = findHandler(router, "POST", "/autopilot/board/reopen");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: { issue: 5 } }), res);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.verified.state, "OPEN");
    assert.deepEqual(reopen.calls, [[5]]);
  });

  test("malformed body (no issue) → 400 before any write", async () => {
    const router = createAutopilotBoardRouter({ view: seqView([]) });
    const handler = findHandler(router, "POST", "/autopilot/board/close");
    const res = mockRes();
    await handler!(mockReq({ method: "POST", body: {} }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

// ---------------------------------------------------------------------------
// projectAnchorDistribution — the pure projection stays boundary-free (INV-4)
// ---------------------------------------------------------------------------

describe("projectAnchorDistribution — pure projection, no trust fields inside (INV-4)", () => {
  test("buckets a synthetic trend without generatedAt/sourcesOk", () => {
    const dist = projectAnchorDistribution([
      { anchorType: "kanban" },
      { anchorType: "kanban" },
      { anchorType: "failing-test" },
      {},
    ]);
    assert.equal(dist.windowCycles, 4);
    const kanban = dist.distribution.find((d: any) => d.priority === "kanban");
    assert.equal(kanban!.served, 2);
    // The trust fields are stamped at the HTTP boundary (src/api/metrics.ts),
    // never here — a wall-clock read would make the projection impure.
    assert.equal("generatedAt" in dist, false);
    assert.equal("sourcesOk" in dist, false);
  });
});

// ---------------------------------------------------------------------------
// Structural source pins — the JSX half + the gh write family
// ---------------------------------------------------------------------------

describe("structural pins — /work page wiring", () => {
  test("App.jsx mounts the /work route", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.match(src, /path="\/work"/);
    assert.match(src, /import Work from "\.\/pages\/Work\.jsx"/);
  });

  test("Work.jsx is the two-panel shell — board + rationale, nothing else (INV-1)", async () => {
    const src = await readSource("../dashboard/src/pages/Work.jsx");
    assert.match(src, /BoardState/);
    assert.match(src, /AnchorRationale/);
    // INV-1: no run history or failure detail on this page.
    assert.equal(src.includes("/autopilot/runs"), false);
    assert.equal(src.includes("/runs/"), false);
  });

  test("BoardState.jsx rides the trust seam + the confirm-first promote (INV-2, INV-5)", async () => {
    const src = await readSource("../dashboard/src/components/pages/work/BoardState.jsx");
    // INV-2: the shared trust seam, not a re-spelled status ternary.
    assert.match(src, /usePageItems\(/);
    assert.match(src, /derivePageStatus/);
    // INV-5: promote arms first, fires only on the explicit confirm click.
    assert.match(src, /data-testid="work-promote-arm"/);
    assert.match(src, /data-testid="work-promote-confirm-yes"/);
    assert.match(src, /data-testid="work-promote-confirm-no"/);
    // The immediate-tier controls exist.
    assert.match(src, /data-testid="work-relabel-select"/);
    assert.match(src, /data-testid="work-close"/);
    assert.match(src, /data-testid="work-reopen-button"/);
    // INV-6: refusal reasons surface verbatim, success shows the verified state.
    assert.match(src, /actionResult\.reason/);
    assert.match(src, /actionResult\.verified/);
    // Server-confirmed: the POST is followed by the follow-up reads.
    assert.match(src, /board\.refresh\(\)/);
    assert.match(src, /queue\.refresh\(\)/);
    // INV-1: no run history or failure detail.
    assert.equal(src.includes("/autopilot/runs"), false);
  });

  test("AnchorRationale.jsx reads the anchor distribution through usePageItems (INV-2)", async () => {
    const src = await readSource(
      "../dashboard/src/components/pages/work/AnchorRationale.jsx",
    );
    assert.match(src, /\/metrics\/anchor-distribution/);
    assert.match(src, /itemsKey: "distribution"/);
    assert.equal(src.includes("/autopilot/runs"), false);
  });

  test("metrics.ts stamps generatedAt + sourcesOk at the anchor-distribution boundary (INV-4)", async () => {
    const src = await readSource("../src/api/metrics.ts");
    assert.match(src, /\/metrics\/anchor-distribution/);
    assert.match(src, /sourcesOk,\s*\n\s*generatedAt: new Date\(\)\.toISOString\(\)/);
  });

  test("issue-actions.ts writes ride the gh issue family — never gh pr edit, never gh api (INV-7)", async () => {
    const src = await readSource("../src/github/issue-actions.ts");
    // Every command array starts with the "issue" verb.
    const issueCommands = src.match(/\[\s*"issue",/g) ?? [];
    assert.ok(issueCommands.length >= 4, `expected 4 issue commands, found ${issueCommands.length}`);
    assert.equal(src.includes(`["pr",`), false);
    assert.equal(src.includes(`["api",`), false);
  });

  test("issues.ts stays at its documented minimal surface — no --remove-label added (INV-8)", async () => {
    const src = await readSource("../src/github/issues.ts");
    assert.match(src, /export async function addIssueLabel/);
    assert.equal(src.includes("--remove-label"), false);
    assert.equal(src.includes(`"close"`), false);
    assert.equal(src.includes(`"reopen"`), false);
  });
});
