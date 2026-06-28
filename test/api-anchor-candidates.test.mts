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
  type CandidateFeedDeps,
} from "../src/anchor-candidates.ts";
// Pure scoring policy now lives in its own sibling Module (issue #2040); import
// the scorer from its canonical home rather than the anchor-candidates facade.
import {
  scoreCandidate,
  PRIORITY_TIER_BASE_SCORE,
} from "../src/backlog/candidate-scoring.ts";
// Design-concept annotation policy now lives in its own sibling Module (issue
// #2499); import the `CandidateDesignConcept` type from its canonical home
// rather than the anchor-candidates facade (the back-compat re-export was
// retired per the #2077 precedent).
import {
  type CandidateDesignConcept,
} from "../src/backlog/candidate-design-concept.ts";

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
    loadMergedAnchorRefs: async () => new Set<string>(),
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

// ---------------------------------------------------------------------------
// Inline-buildability gate (issue #2075) — an inline-mode caller (no spawn
// tool, #1782) must NOT be served a `dispatch-spawn-capable` anchor that
// exceeds the >5-file complexity cap, so the work-queue stops re-serving a
// large atomic migration to a session that can only revert + requeue it.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — inline-buildability gate (#2075)", () => {
  test("inlineMode suppresses a kanban anchor flagged dispatch-spawn-capable", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [
          { id: 1, title: "13-file rename remainder", movedAt: isoAgo(0), meta: { dispatchSpawnCapable: true } },
          { id: 2, title: "Bounded one-file fix", movedAt: isoAgo(0) },
        ],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, inlineMode: true }, deps);
    const titles = feed.candidates.map((c) => c.title);
    assert.ok(!titles.includes("13-file rename remainder"), "spawn-capable anchor hidden from inline caller");
    assert.ok(titles.includes("Bounded one-file fix"), "inline-buildable anchor still surfaces");
    assert.equal(feed.spawn_suppressed, 1);
  });

  test("default (non-inline) caller still sees a dispatch-spawn-capable anchor", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 1, title: "13-file rename remainder", movedAt: isoAgo(0), meta: { dispatchSpawnCapable: true } }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("13-file rename remainder"));
    assert.equal(feed.spawn_suppressed, 0);
  });

  test("inlineMode suppresses a work-queue entry flagged dispatch-spawn-capable (top-level flag)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "openAiCredentialReadiness rename remainder", queuedAt: isoAgo(0), source: "hydra-retro", dispatchSpawnCapable: true }),
        JSON.stringify({ reference: "small standard task", queuedAt: isoAgo(0), source: "operator" }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW, inlineMode: true }, deps);
    const refs = feed.candidates.map((c) => c.anchorRef);
    assert.ok(!refs.some((r) => r.includes("openAiCredentialReadiness")), "spawn-capable work-queue entry hidden from inline caller");
    assert.ok(refs.some((r) => r.includes("small standard task")), "standard work-queue entry still surfaces");
    assert.equal(feed.spawn_suppressed, 1);
  });

  test("inlineMode honours the dispatch-spawn-capable label form on a work-queue entry", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "labelled complex anchor", queuedAt: isoAgo(0), labels: ["dispatch-spawn-capable"] }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW, inlineMode: true }, deps);
    assert.equal(feed.candidates.length, 0);
    assert.equal(feed.spawn_suppressed, 1);
  });
});

// ---------------------------------------------------------------------------
// PR-deliverability gate (issue #2282) — an anchor that is host-systemd-only /
// operator-gated / live-data is deliverable by NO code-writing dispatch, so the
// feed hides it from EVERY caller by default (not just inline ones, unlike
// #2075). The release-and-rescan the sessions did by hand is now declarative.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — PR-deliverability gate (#2282)", () => {
  test("suppresses a kanban anchor flagged nonPrDeliverable for every caller (default)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [
          { id: 559, title: "Install hydra-betting-ingest.service systemd unit", movedAt: isoAgo(0), meta: { nonPrDeliverable: true } },
          { id: 560, title: "Repo-buildable scanner fix", movedAt: isoAgo(0) },
        ],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const titles = feed.candidates.map((c) => c.title);
    assert.ok(!titles.includes("Install hydra-betting-ingest.service systemd unit"), "host-systemd anchor hidden");
    assert.ok(titles.includes("Repo-buildable scanner fix"), "buildable anchor still surfaces");
    assert.equal(feed.non_pr_deliverable_suppressed, 1);
  });

  test("suppresses a work-queue entry by canonical class label (host-systemd)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-559 scan-after-ingest ExecStartPost", queuedAt: isoAgo(0), labels: ["host-systemd"] }),
        JSON.stringify({ reference: "item-529 code-buildable", queuedAt: isoAgo(0) }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const refs = feed.candidates.map((c) => c.anchorRef);
    assert.ok(!refs.some((r) => r.includes("item-559")), "host-systemd work-queue entry hidden");
    assert.ok(refs.some((r) => r.includes("item-529")), "buildable work-queue entry still surfaces");
    assert.equal(feed.non_pr_deliverable_suppressed, 1);
  });

  test("operator-gated and live-data work-queue entries are both suppressed", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-555 arbitrage timer (BALLDONTLIE_API_KEY)", queuedAt: isoAgo(0), labels: ["operator-gated"] }),
        JSON.stringify({ reference: "item-523 scanner-live-pairs (prod-DB assertions)", queuedAt: isoAgo(0), nonPrDeliverable: true }),
        JSON.stringify({ reference: "item-529 buildable", queuedAt: isoAgo(0) }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const refs = feed.candidates.map((c) => c.anchorRef);
    assert.equal(feed.non_pr_deliverable_suppressed, 2);
    assert.deepEqual(refs, ["item-529 buildable"]);
  });

  test("excludeNonPrDeliverable=false surfaces the anchor (raw operator view)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 559, title: "Host systemd install", movedAt: isoAgo(0), meta: { nonPrDeliverable: true } }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW, excludeNonPrDeliverable: false }, deps);
    assert.ok(feed.candidates.map((c) => c.title).includes("Host systemd install"));
    assert.equal(feed.non_pr_deliverable_suppressed, 0);
  });

  test("gate fires regardless of inlineMode (buildable by no dispatch, unlike #2075)", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 559, title: "Host systemd install", movedAt: isoAgo(0), labels: ["host-systemd"] }],
        backlog: [],
      }),
    });
    // Even a spawn-capable (non-inline) caller must not be served it.
    const feed = await getCandidateFeed({ now: NOW, inlineMode: false }, deps);
    assert.equal(feed.candidates.length, 0);
    assert.equal(feed.non_pr_deliverable_suppressed, 1);
    assert.equal(feed.spawn_suppressed, 0);
  });

  test("an un-flagged anchor is never hidden by this gate", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 1, title: "Ordinary repo work", movedAt: isoAgo(0), labels: ["ready-for-agent", "enhancement"] }],
        backlog: [],
      }),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates.length, 1);
    assert.equal(feed.non_pr_deliverable_suppressed, 0);
  });
});

// ---------------------------------------------------------------------------
// Merged-by-cycle suppression (issue #882) — the core fix: shipped work whose
// PR already MERGED (no lingering OPEN PR) must NOT resurface in the feed.
// ---------------------------------------------------------------------------

// The MergedAnchorRefs pure-helper unit tests (normalizeIdentity,
// mergedTokensFromPr, candidateMergedTokens, isMergedWork, mergedTokensFromGhJson)
// moved to `test/backlog-merged-refs.test.mts` with the Seam itself (issue
// #1880). The feed's USE of merged suppression stays below.

describe("getCandidateFeed — merged-by-cycle suppression (#882)", () => {
  test("a target item whose work merged (no open PR) is suppressed", async () => {
    // The #882 reproduction: item-322's maker stack shipped, no open PR,
    // claimedBy never set — yet it kept surfacing at 0.85. With the merged set
    // carrying item-322, the work-queue candidate must drop out of the feed.
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-322 Polymarket CLOB V2 maker order placement", queuedAt: isoAgo(0), source: "hydra-target-research" }),
        JSON.stringify({ reference: "item-999 genuinely unbuilt feature", queuedAt: isoAgo(0), source: "hydra-target-research" }),
      ],
      loadMergedAnchorRefs: async () => new Set(["item-322"]),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const refs = feed.candidates.map((c) => c.anchorRef);
    assert.ok(!refs.some((r) => r.includes("item-322")), "merged item-322 must not appear");
    assert.ok(refs.some((r) => r.includes("item-999")), "unbuilt item-999 still surfaces");
    assert.equal(feed.merged_suppressed, 1);
  });

  test("a kanban anchor whose issue merged is suppressed", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [
          { id: 882, title: "Merged anchor", movedAt: isoAgo(0) },
          { id: 883, title: "Still open anchor", movedAt: isoAgo(0) },
        ],
        backlog: [],
      }),
      loadMergedAnchorRefs: async () => new Set(["882"]),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const issues = feed.candidates.map((c) => c.issue);
    assert.ok(!issues.includes(882), "merged issue 882 must be suppressed");
    assert.ok(issues.includes(883), "open issue 883 still surfaces");
    assert.equal(feed.merged_suppressed, 1);
  });

  test("excludeMerged=false surfaces merged candidates (escape hatch)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) }),
      ],
      loadMergedAnchorRefs: async () => new Set(["item-322"]),
    });
    const feed = await getCandidateFeed({ now: NOW, excludeMerged: false }, deps);
    assert.equal(feed.candidates.length, 1);
    assert.equal(feed.merged_suppressed, 0);
  });

  test("a failing merged-refs reader degrades to suppress-nothing (never throws)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) }),
      ],
      loadMergedAnchorRefs: async () => { throw new Error("gh unreachable"); },
    });
    await assert.doesNotReject(async () => {
      const feed = await getCandidateFeed({ now: NOW }, deps);
      // Reader failure → empty merged-set → candidate survives.
      assert.equal(feed.candidates.length, 1);
      assert.equal(feed.merged_suppressed, 0);
    });
  });

  test("merged_suppressed counts both lanes; in_flight and merged are independent", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [{ id: 1, title: "Open PR", claimedBy: "pr-7", claimedAt: isoAgo(5 * 60 * 1000) }],
        queued: [{ id: 882, title: "Merged kanban", movedAt: isoAgo(0) }],
        backlog: [],
      }),
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) }),
        JSON.stringify({ reference: "item-999 unbuilt", queuedAt: isoAgo(0) }),
      ],
      loadMergedAnchorRefs: async () => new Set(["882", "item-322"]),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.in_flight_suppressed, 1);
    assert.equal(feed.merged_suppressed, 2);
    assert.deepEqual(feed.candidates.map((c) => String(c.issue)), ["item-999 unbuilt"]);
  });
});

// ---------------------------------------------------------------------------
// Terminal-state marker suppression (issue #1853 / #2187).
//
// The Candidate Feed SUPPRESSES terminal markers on every poll (skips them as
// candidates) but performs ZERO Redis writes — the reap of the stale entry
// moved to the hourly Work-Queue Hygiene reconciler (#2187, cause
// "terminal-marker"), covered by test/backlog-work-queue-hygiene.test.mts.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — terminal-marker suppression (#1853 / #2187)", () => {
  test("a COMPLETED:-prefixed work-queue entry is skipped (never surfaces)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "COMPLETED: issue-1700 shipped", queuedAt: isoAgo(0) }),
        JSON.stringify({ reference: "Real work", queuedAt: isoAgo(0) }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    const refs = feed.candidates.map((c) => c.anchorRef);
    assert.ok(!refs.some((r) => r.startsWith("COMPLETED:")), "COMPLETED marker must not surface as a candidate");
    assert.ok(refs.includes("Real work"), "real work still surfaces");
  });

  test("a CLOSED:-prefixed entry is skipped too (case-insensitive)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "closed: item-99 done", queuedAt: isoAgo(0) }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.candidates.length, 0, "CLOSED marker is not a candidate");
  });

  test("terminal-marker skip is independent of excludeMerged", async () => {
    // Even with excludeMerged=false (the raw view), a terminal marker is never
    // actionable work and must still be dropped.
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "COMPLETED: issue-1 shipped", queuedAt: isoAgo(0) }),
      ],
    });
    const feed = await getCandidateFeed({ now: NOW, excludeMerged: false }, deps);
    assert.equal(feed.candidates.length, 0);
  });
});

// NOTE: the MergedAnchorRefs Seam — the pure token helpers + the swap-seam/
// TTL-cache loader factory (`makeMergedAnchorRefsLoader`) — moved to
// `src/backlog/merged-refs.ts` (issue #1880) and is tested in isolation by
// `test/backlog-merged-refs.test.mts`. This file keeps the Candidate Feed's USE
// of merged-refs (suppression only — the reap moved to Work-Queue Hygiene in
// #2187) below.

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

    // excludeMerged=false avoids spawning a real `gh pr list` subprocess in
    // the route smoke test (the merged-scan reader, #882). The merged-suppression
    // behaviour is exercised via injected deps in the getCandidateFeed tests.
    const req: any = { query: { excludeMerged: "false" } };
    const res = mockRes();
    await handler(req, res);

    assert.ok(res._body, "response body present");
    assert.ok("candidates" in res._body);
    assert.ok("research_recommended" in res._body);
    assert.ok("total_evaluated" in res._body);
    assert.ok("in_flight_suppressed" in res._body);
    assert.ok("merged_suppressed" in res._body);
    assert.ok("non_pr_deliverable_suppressed" in res._body);
    assert.equal(typeof res._body.generated_at, "string");
  });
});

// ---------------------------------------------------------------------------
// Merged-work suppression is a pure READ (issue #2187): the feed hides a
// merged-suppressed work-queue entry but performs ZERO Redis writes — the reap
// of the stale entry moved to the hourly Work-Queue Hygiene reconciler
// (cause "merged-work"), covered by test/backlog-work-queue-hygiene.test.mts.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — merged work-queue entries are suppressed (#882 / #2187)", () => {
  test("a merged-suppressed work-queue entry is hidden; live work still surfaces", async () => {
    const staleRaw = JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) });
    const liveRaw = JSON.stringify({ reference: "item-999 unbuilt", queuedAt: isoAgo(0) });
    const deps = makeDeps({
      getWorkQueueItems: async () => [staleRaw, liveRaw],
      loadMergedAnchorRefs: async () => new Set(["item-322"]),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.merged_suppressed, 1);
    assert.ok(!feed.candidates.some((c) => c.anchorRef.includes("item-322")), "merged entry is suppressed");
    assert.ok(feed.candidates.some((c) => c.anchorRef.includes("item-999")), "live entry still surfaces");
  });

  test("kanban merged suppression counts but never touches the work queue", async () => {
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 882, title: "Merged anchor", movedAt: isoAgo(0) }],
        backlog: [],
      }),
      loadMergedAnchorRefs: async () => new Set(["882"]),
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.merged_suppressed, 1);
    assert.equal(feed.candidates.length, 0);
  });
});

// Work-Queue Hygiene tests (harvestOrchIssueRefs / reconcileWorkQueue), including
// the merged-work + terminal-marker reap moved here in issue #2187, live in
// test/backlog-work-queue-hygiene.test.mts alongside the module (issue #1844).
