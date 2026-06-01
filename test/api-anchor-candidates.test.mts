/**
 * Regression tests for the Candidate Feed (issue #424 / ADR-0016).
 *
 * The deep module `src/anchor-candidates.ts` (`getCandidateFeed`) owns
 * enumeration + scoring + eligibility behind one interface, and its injectable
 * `deps` are the test surface. These tests drive the feed end-to-end with
 * stubbed deps (no Redis fixture needed) and pin:
 *   - enumeration of the two live lanes (kanban ∪ work-queue)
 *   - the scoring formula (tier base + freshness + reflection + blocker bonus)
 *   - eligibility (in-flight-PR suppression, blocker-just-cleared, limit/slice)
 *   - research_recommended threshold
 *   - the byte-compatible HTTP payload decide.py reads
 *
 * A thin route smoke test confirms `api/anchor.ts` wires the module + adds
 * `generated_at`. The metrics/health regressions pin the ADR-0016 field drops.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getCandidateFeed,
  scoreCandidate,
  PRIORITY_TIER_BASE_SCORE,
  type CandidateFeedDeps,
  type CandidateDesignConcept,
} from "../src/anchor-candidates.ts";

const ABSENT_DC: CandidateDesignConcept = {
  present: false,
  isFresh: false,
  status: null,
  gateOk: false,
};

/**
 * Build a deps bundle with no candidates by default; override any field per
 * test. Reflection + design-concept default to "nothing".
 */
function makeDeps(over: Partial<CandidateFeedDeps> = {}): CandidateFeedDeps {
  return {
    loadBacklog: async () => ({ inProgress: [], queued: [], backlog: [] }),
    getWorkQueueItems: async () => [],
    loadLastReflectionAt: async () => null,
    loadDesignConcept: async () => ABSENT_DC,
    ...over,
  };
}

const NOW = Date.UTC(2026, 4, 31, 12, 0, 0);
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

// ---------------------------------------------------------------------------
// Pure scorer — pins the formula (abandonment penalty dropped per ADR-0016).
// ---------------------------------------------------------------------------

describe("scoreCandidate — pure scoring helper (ADR-0016)", () => {
  test("only the two live tiers exist in the base-score table", () => {
    assert.deepEqual(
      Object.keys(PRIORITY_TIER_BASE_SCORE).sort(),
      ["kanban-queued", "work-queue"],
    );
  });

  test("fresh kanban candidate scores at base 0.85", () => {
    const r = scoreCandidate({ priorityTier: "kanban-queued", lastUpdated: isoAgo(0), now: NOW });
    assert.equal(r.score, 0.85);
    assert.ok(r.reasons.some((x) => x.includes("tier:kanban-queued")));
    assert.ok(r.reasons.includes("fresh"));
  });

  test("work-queue base score is 0.70", () => {
    const r = scoreCandidate({ priorityTier: "work-queue", lastUpdated: isoAgo(0), now: NOW });
    assert.equal(r.score, 0.70);
  });

  test("stale candidate (>14d) loses 0.15 freshness penalty", () => {
    const r = scoreCandidate({
      priorityTier: "kanban-queued",
      lastUpdated: isoAgo(15 * 24 * 60 * 60 * 1000),
      now: NOW,
    });
    assert.equal(Math.round(r.score * 100) / 100, 0.70);
    assert.ok(r.reasons.some((x) => x.startsWith("stale:")));
  });

  test("recent reflection (<24h) downscores by 0.20", () => {
    const r = scoreCandidate({
      priorityTier: "kanban-queued",
      lastUpdated: isoAgo(0),
      lastReflectionAt: isoAgo(6 * 60 * 60 * 1000),
      now: NOW,
    });
    assert.equal(Math.round(r.score * 100) / 100, 0.65);
    assert.ok(r.reasons.some((x) => x.includes("recent-failure")));
  });

  test("old reflection (>24h) does NOT downscore", () => {
    const r = scoreCandidate({
      priorityTier: "kanban-queued",
      lastUpdated: isoAgo(0),
      lastReflectionAt: isoAgo(48 * 60 * 60 * 1000),
      now: NOW,
    });
    assert.equal(r.score, 0.85);
  });

  test("blocker-just-cleared upscores by 0.15 (clamped to 1)", () => {
    const r = scoreCandidate({
      priorityTier: "kanban-queued",
      lastUpdated: isoAgo(0),
      blockerJustCleared: true,
      now: NOW,
    });
    assert.equal(r.score, 1.0); // 0.85 + 0.15
    assert.ok(r.reasons.some((x) => x.includes("blocker-cleared")));
  });

  test("score clamped to [0,1]", () => {
    // work-queue (0.70) - stale (0.15) - reflection (0.20) = 0.35
    const r = scoreCandidate({
      priorityTier: "work-queue",
      lastUpdated: isoAgo(30 * 24 * 60 * 60 * 1000),
      lastReflectionAt: isoAgo(60 * 60 * 1000),
      now: NOW,
    });
    assert.equal(Math.round(r.score * 100) / 100, 0.35);
  });

  test("unknown tier returns 0 score and 'unknown-tier' reason (graceful)", () => {
    const r = scoreCandidate({ priorityTier: "nonexistent" as any, now: NOW });
    assert.equal(r.score, 0);
    assert.ok(r.reasons.includes("unknown-tier"));
  });
});

// ---------------------------------------------------------------------------
// getCandidateFeed — enumeration + scoring + eligibility through stubbed deps.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — enumeration (ADR-0016)", () => {
  test("empty board → research_recommended=true, no candidates", async () => {
    const feed = await getCandidateFeed({ now: NOW }, makeDeps());
    assert.equal(feed.research_recommended, true);
    assert.deepEqual(feed.candidates, []);
    assert.equal(feed.total_evaluated, 0);
    assert.equal(feed.in_flight_suppressed, 0);
  });

  test("enumerates kanban lanes (inProgress ∪ queued ∪ backlog)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "In progress task", movedAt: isoAgo(0) }],
        queued: [{ id: 2, title: "Queued task", movedAt: isoAgo(0) }],
        backlog: [{ id: 3, title: "Backlog task", movedAt: isoAgo(0) }],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.total_evaluated, 3);
    assert.equal(feed.candidates.every((c) => c.priority_tier === "kanban-queued"), true);
    assert.equal(feed.research_recommended, false);
  });

  test("enumerates work-queue items (reference or description)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "Build feature X", queuedAt: isoAgo(0), source: "operator" }),
        JSON.stringify({ description: "Research thing Y", queuedAt: isoAgo(0), source: "research" }),
        "not-json",                         // skipped
        JSON.stringify({ source: "operator" }), // no ref → skipped
      ],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.total_evaluated, 2);
    assert.equal(feed.candidates.every((c) => c.priority_tier === "work-queue"), true);
  });

  test("kanban outscores work-queue and sorts first", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Kanban", movedAt: isoAgo(0) }], backlog: [] }),
      getWorkQueueItems: async () => [JSON.stringify({ reference: "WorkQueue", queuedAt: isoAgo(0) })],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates.length, 2);
    assert.equal(feed.candidates[0].title, "Kanban");
    assert.equal(feed.candidates[0].score, 0.85);
    assert.equal(feed.candidates[1].title, "WorkQueue");
    assert.equal(feed.candidates[1].score, 0.70);
  });

  test("a failing lane is logged and contributes nothing (never throws)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => { throw new Error("redis down"); },
      getWorkQueueItems: async () => [JSON.stringify({ reference: "Survivor", queuedAt: isoAgo(0) })],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.total_evaluated, 1);
    assert.equal(feed.candidates[0].title, "Survivor");
  });
});

describe("getCandidateFeed — scoring signals through the feed", () => {
  test("stale kanban item is downscored", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [], backlog: [{ id: 1, title: "Old", movedAt: isoAgo(30 * 24 * 60 * 60 * 1000) }] }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(Math.round(feed.candidates[0].score * 100) / 100, 0.70);
    assert.ok(feed.candidates[0].reasons.some((r) => r.startsWith("stale:")));
  });

  test("recent reflection on the matching anchor downscores", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Has failure", movedAt: isoAgo(0) }], backlog: [] }),
      loadLastReflectionAt: async (ref) => (ref === "Has failure" ? isoAgo(2 * 60 * 60 * 1000) : null),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(Math.round(feed.candidates[0].score * 100) / 100, 0.65);
    assert.ok(feed.candidates[0].reasons.some((r) => r.includes("recent-failure")));
  });

  test("blocker-just-cleared kanban item is upscored", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{
          id: 1,
          title: "Unblocked",
          lane: "queued",
          movedAt: isoAgo(60 * 60 * 1000),
          meta: { blockedReason: "Blocked by #99 (now merged)" },
        }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates[0].score, 1.0);
    assert.ok(feed.candidates[0].reasons.some((r) => r.includes("blocker-cleared")));
  });
});

describe("getCandidateFeed — eligibility", () => {
  test("in-flight PR claim (fresh) suppresses the candidate by default (#640)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "Shipped — PR open", claimedBy: "pr-27", claimedAt: isoAgo(5 * 60 * 1000) }],
        queued: [{ id: 2, title: "Free anchor", movedAt: isoAgo(0) }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const titles = feed.candidates.map((c) => c.title);
    assert.ok(!titles.includes("Shipped — PR open"));
    assert.ok(titles.includes("Free anchor"));
    assert.equal(feed.in_flight_suppressed, 1);
  });

  test("excludeInFlight=false surfaces in-flight PR candidates (#640 escape hatch)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "Shipped B", claimedBy: "pr-99", claimedAt: isoAgo(5 * 60 * 1000) }],
        queued: [], backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, excludeInFlight: false }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("Shipped B"));
    assert.equal(feed.in_flight_suppressed, 0);
  });

  test("stale PR claim (>30m) is NOT suppressed (#640 freshness window)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "Stale PR", claimedBy: "pr-1", claimedAt: isoAgo(2 * 60 * 60 * 1000) }],
        queued: [], backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("Stale PR"));
    assert.equal(feed.in_flight_suppressed, 0);
  });

  test("non-PR claimedBy ('claude') does not trigger suppression", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "Legacy claim", claimedBy: "claude", claimedAt: isoAgo(5 * 60 * 1000) }],
        queued: [], backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("Legacy claim"));
    assert.equal(feed.in_flight_suppressed, 0);
  });

  test("limit caps the returned slice but total_evaluated counts all", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [], queued: [], backlog: Array.from({ length: 5 }, (_, i) => ({ id: i, title: `Task ${i}`, movedAt: isoAgo(0) })),
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, limit: 2 }, deps);
    assert.equal(feed.candidates.length, 2);
    assert.equal(feed.total_evaluated, 5);
  });
});

describe("getCandidateFeed — design-concept annotation (#628)", () => {
  test("every candidate carries a designConcept block; absent → present:false", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Some task", movedAt: isoAgo(0) }], backlog: [] }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const c = feed.candidates[0];
    assert.deepEqual(c.designConcept, ABSENT_DC);
    assert.ok(c.anchorRef);
  });

  test("design-concept reader receives the anchorRef and its projection is surfaced", async () => {
    const present: CandidateDesignConcept = { present: true, isFresh: true, status: "approved", gateOk: true };
    let sawRef: string | null = null;
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Approved task", movedAt: isoAgo(0) }], backlog: [] }),
      loadDesignConcept: async (ref) => { sawRef = ref; return present; },
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(sawRef, "Approved task");
    assert.deepEqual(feed.candidates[0].designConcept, present);
  });

  test("a failing design-concept read degrades the field, never drops the candidate", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Task", movedAt: isoAgo(0) }], backlog: [] }),
      loadDesignConcept: async () => { throw new Error("dc read failed"); },
    });
    // getCandidateFeed must not propagate the throw; the candidate stays.
    await assert.doesNotReject(async () => {
      const feed = await getCandidateFeed({ now: NOW }, deps);
      assert.equal(feed.candidates.length, 1);
    });
  });
});

describe("getCandidateFeed — research_recommended threshold", () => {
  test("a top score below 0.5 flips research_recommended=true", async () => {
    // work-queue (0.70) - stale (0.15) - reflection (0.20) = 0.35 < 0.5
    const deps = makeDeps({
      getWorkQueueItems: async () => [JSON.stringify({ reference: "Weak", queuedAt: isoAgo(30 * 24 * 60 * 60 * 1000) })],
      loadLastReflectionAt: async () => isoAgo(60 * 60 * 1000),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.ok(feed.candidates[0].score < 0.5);
    assert.equal(feed.research_recommended, true);
  });

  test("a strong kanban candidate keeps research_recommended=false", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 1, title: "Strong", movedAt: isoAgo(0) }], backlog: [] }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.research_recommended, false);
  });
});

// ---------------------------------------------------------------------------
// HTTP contract — decide.py read-set must stay byte-compatible.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — decide.py read-set contract", () => {
  test("per-candidate shape exposes exactly the fields decide.py reads", async () => {
    const present: CandidateDesignConcept = { present: true, isFresh: true, status: "approved", gateOk: true };
    const deps = makeDeps({
      loadBacklog: async () => ({ inProgress: [], queued: [{ id: 42, title: "Anchor", movedAt: isoAgo(0) }], backlog: [] }),
      loadDesignConcept: async () => present,
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const c = feed.candidates[0];
    // decide.py reads: score, reasons, designConcept{present,isFresh,status,gateOk}, anchorRef, issue
    assert.equal(typeof c.score, "number");
    assert.ok(Array.isArray(c.reasons));
    assert.deepEqual(Object.keys(c.designConcept).sort(), ["gateOk", "isFresh", "present", "status"]);
    assert.equal(typeof c.anchorRef, "string");
    assert.ok(c.issue === 42);
    // ADR-0016: the abandonments + priority_tier scoring fields are NOT
    // required by decide.py; the abandonments field is dropped entirely.
    assert.equal((c as any).abandonments, undefined);
  });

  test("top-level research_recommended is a boolean", async () => {
    const feed = await getCandidateFeed({ now: NOW }, makeDeps());
    assert.equal(typeof feed.research_recommended, "boolean");
  });
});

// ---------------------------------------------------------------------------
// Thin route — api/anchor.ts wires the module + adds generated_at.
// ---------------------------------------------------------------------------

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const stack = layer.route.stack;
      if (layer.route.methods[method.toLowerCase()]) return stack[stack.length - 1].handle;
    }
  }
  return null;
}

describe("GET /anchor/candidates — thin route", () => {
  test("route delegates to getCandidateFeed and stamps generated_at", async () => {
    const { createAnchorRouter } = await import("../src/api/anchor.ts");
    const router = createAnchorRouter();
    const handler = findHandler(router, "GET", "/anchor/candidates");
    assert.ok(handler, "route handler must be registered");

    const req: any = { query: {} };
    const res = mockRes();
    await handler(req, res);

    assert.ok(res._body, "response body present");
    assert.ok("candidates" in res._body);
    assert.ok("research_recommended" in res._body);
    assert.ok("total_evaluated" in res._body);
    assert.ok("in_flight_suppressed" in res._body);
    assert.equal(typeof res._body.generated_at, "string");
  });
});
