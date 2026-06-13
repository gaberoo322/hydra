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
  isMergedWork,
  candidateMergedTokens,
  mergedTokensFromPr,
  mergedTokensFromGhJson,
  normalizeIdentity,
  makeMergedAnchorRefsLoader,
  harvestOrchIssueRefs,
  reconcileWorkQueue,
  type CandidateFeedDeps,
  type CandidateDesignConcept,
} from "../src/anchor-candidates.ts";
import { __resetForTests as __resetTargetConfig } from "../src/target-config.ts";

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
    // Issue #1690: stub the work-queue reap so suppression tests never touch
    // a real Redis. Individual tests override to assert on the calls.
    removeWorkQueueItem: async () => 0,
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
// Merged-by-cycle suppression (issue #882) — the core fix: shipped work whose
// PR already MERGED (no lingering OPEN PR) must NOT resurface in the feed.
// ---------------------------------------------------------------------------

describe("merged-by-cycle pure helpers (#882)", () => {
  test("normalizeIdentity lowercases, collapses whitespace, trims", () => {
    assert.equal(normalizeIdentity("  Foo   BAR  "), "foo bar");
    assert.equal(normalizeIdentity(undefined as any), "");
  });

  test("mergedTokensFromPr harvests #NNN, item-NNN, and the normalized title", () => {
    const toks = mergedTokensFromPr(
      "feat: Polymarket CLOB V2 maker order (#910)",
      "Closes #322\n\nImplements item-322 maker stack.",
    );
    assert.ok(toks.includes("910"));
    assert.ok(toks.includes("322"));
    assert.ok(toks.includes("item-322"));
    assert.ok(toks.includes("feat: polymarket clob v2 maker order (#910)"));
  });

  test("candidateMergedTokens emits the bare issue number for a kanban anchor", () => {
    const toks = candidateMergedTokens({ issue: 882, title: "Some anchor", anchorRef: "Some anchor" });
    assert.ok(toks.includes("882"));
    assert.ok(toks.includes("some anchor"));
  });

  test("candidateMergedTokens extracts item-NNN from a target work-queue ref", () => {
    const toks = candidateMergedTokens({
      issue: "item-322",
      title: "item-322 Polymarket CLOB V2 maker order placement",
      anchorRef: "item-322 Polymarket CLOB V2 maker order placement",
    });
    assert.ok(toks.includes("item-322"));
  });

  test("isMergedWork: empty merged-set never suppresses", () => {
    assert.equal(
      isMergedWork({ issue: 1, title: "x", anchorRef: "x" }, new Set()),
      false,
    );
  });

  test("isMergedWork: item-NNN candidate matches a merged item-NNN token", () => {
    const merged = new Set(["item-322"]);
    assert.equal(
      isMergedWork(
        { issue: "item-322", title: "item-322 maker order", anchorRef: "item-322 maker order" },
        merged,
      ),
      true,
    );
  });

  test("isMergedWork: kanban issue number matches a merged #NNN token", () => {
    const merged = new Set(["882"]);
    assert.equal(isMergedWork({ issue: 882, title: "Anchor", anchorRef: "Anchor" }, merged), true);
  });

  test("item-NNN matching is whole-word: item-302 must NOT match merged item-3020 (boundary)", () => {
    // QA-flagged boundary (#882): the `\bitem-(\d+)\b` regex must not treat
    // item-302 and item-3020 as the same identity. A merged item-3020 should
    // suppress ONLY item-3020 — item-302 stays live (and vice-versa).
    const mergedLong = new Set(["item-3020"]);
    assert.equal(
      isMergedWork({ issue: "item-302", title: "item-302 short id", anchorRef: "item-302 short id" }, mergedLong),
      false,
      "item-302 must not be suppressed by a merged item-3020",
    );
    assert.equal(
      isMergedWork({ issue: "item-3020", title: "item-3020 long id", anchorRef: "item-3020 long id" }, mergedLong),
      true,
      "item-3020 IS suppressed by the merged item-3020 token",
    );

    const mergedShort = new Set(["item-302"]);
    assert.equal(
      isMergedWork({ issue: "item-3020", title: "item-3020 long id", anchorRef: "item-3020 long id" }, mergedShort),
      false,
      "item-3020 must not be suppressed by a merged item-302 (prefix is not a match)",
    );

    // Token harvesting itself must normalize to the exact id, not a prefix.
    // (Filter to the canonical `item-<digits>` token shape — the normalized
    // title `item-3020 maker order` is also harvested but is not an id token.)
    const idTok = /^item-\d+$/;
    assert.deepEqual(candidateMergedTokens({ issue: "item-302", title: "item-302", anchorRef: "item-302" }).filter((t) => idTok.test(t)), ["item-302"]);
    assert.deepEqual(mergedTokensFromPr("item-3020 maker order", "").filter((t) => idTok.test(t)), ["item-3020"]);
  });

  test("mergedTokensFromGhJson parses a gh pr list payload; bad input → []", () => {
    const json = JSON.stringify([
      { title: "fix: thing (#5)", body: "Closes #321" },
      { title: "item-481 shipped", body: "" },
    ]);
    const toks = mergedTokensFromGhJson(json);
    assert.ok(toks.includes("5"));
    assert.ok(toks.includes("321"));
    assert.ok(toks.includes("item-481"));
    assert.deepEqual(mergedTokensFromGhJson("not json"), []);
    assert.deepEqual(mergedTokensFromGhJson(""), []);
    assert.deepEqual(mergedTokensFromGhJson("{}"), []);
  });
});

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
// Production merged-refs reader (#882 QA remediation): swap-seam + TTL cache.
// ---------------------------------------------------------------------------

describe("makeMergedAnchorRefsLoader — swap seam + TTL cache (#882, #1834)", () => {
  // A fake `gh` exec that records the repos it was asked to scan and returns a
  // canned merged-PR payload. Shaped like promisify(execFile)'s resolution.
  function fakeExec(payloadByRepo: Record<string, string>) {
    const calls: string[] = [];
    const exec = (async (_cmd: string, args: string[]) => {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
      calls.push(repo);
      return { stdout: payloadByRepo[repo] ?? "[]", stderr: "" };
    }) as any;
    return { exec, calls };
  }

  // Each test constructs a FRESH loader so the closure-local TTL cache starts
  // cold — #1834 replaced the module-level cache + `__resetMergedScanCacheForTests`
  // with this per-loader isolation.
  test("scans the orchestrator repo AND the swap-seam target repo (ADR-0013)", async () => {
    __resetTargetConfig();
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    try {
      const { exec, calls } = fakeExec({
        "gaberoo322/hydra": JSON.stringify([{ title: "fix (#100)", body: "" }]),
        "acme/widgets": JSON.stringify([{ title: "item-322 maker", body: "" }]),
      });
      const loadMergedAnchorRefs = makeMergedAnchorRefsLoader(exec);
      const refs = await loadMergedAnchorRefs(1_000_000);
      // Both the literal orchestrator repo and the CONFIGURED target repo were
      // scanned — NOT the hardcoded gaberoo322/hydra-betting.
      assert.deepEqual(calls.sort(), ["acme/widgets", "gaberoo322/hydra"]);
      assert.ok(refs.has("100"));
      assert.ok(refs.has("item-322"));
    } finally {
      delete process.env.HYDRA_TARGET_GITHUB_REPO;
      __resetTargetConfig();
    }
  });

  test("a fresh cache entry (<TTL) short-circuits the gh shell-out", async () => {
    __resetTargetConfig();
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    try {
      const { exec, calls } = fakeExec({
        "gaberoo322/hydra": JSON.stringify([{ title: "fix (#7)", body: "" }]),
        "acme/widgets": "[]",
      });
      const loadMergedAnchorRefs = makeMergedAnchorRefsLoader(exec);
      const t0 = 5_000_000;
      const first = await loadMergedAnchorRefs(t0);
      assert.ok(first.has("7"));
      const callsAfterFirst = calls.length; // 2 (one per repo)

      // Second call 30s later — within the 60s TTL — must reuse the cache.
      const second = await loadMergedAnchorRefs(t0 + 30_000);
      assert.equal(calls.length, callsAfterFirst, "no new gh calls within TTL");
      assert.equal(second, first, "same cached Set instance returned");

      // After the TTL expires, the reader scans again.
      const third = await loadMergedAnchorRefs(t0 + 61_000);
      assert.ok(calls.length > callsAfterFirst, "gh re-scanned after TTL expiry");
      assert.ok(third.has("7"));
    } finally {
      delete process.env.HYDRA_TARGET_GITHUB_REPO;
      __resetTargetConfig();
    }
  });

  test("a gh failure degrades to an empty set and is cached (never throws)", async () => {
    __resetTargetConfig();
    try {
      const exec = (async () => { throw new Error("gh: command not found"); }) as any;
      const loadMergedAnchorRefs = makeMergedAnchorRefsLoader(exec);
      const refs = await loadMergedAnchorRefs(9_000_000);
      assert.equal(refs.size, 0, "total failure → empty set (suppress nothing)");
    } finally {
      __resetTargetConfig();
    }
  });

  test("each loader instance owns an isolated cache (no module-level leak)", async () => {
    __resetTargetConfig();
    process.env.HYDRA_TARGET_GITHUB_REPO = "acme/widgets";
    try {
      const a = fakeExec({ "gaberoo322/hydra": JSON.stringify([{ title: "fix (#1)", body: "" }]), "acme/widgets": "[]" });
      const b = fakeExec({ "gaberoo322/hydra": JSON.stringify([{ title: "fix (#2)", body: "" }]), "acme/widgets": "[]" });
      const loaderA = makeMergedAnchorRefsLoader(a.exec);
      const loaderB = makeMergedAnchorRefsLoader(b.exec);
      const t0 = 8_000_000;
      const refsA = await loaderA(t0);
      const refsB = await loaderB(t0);
      // Loader B does its OWN scan rather than reading A's cache.
      assert.ok(refsA.has("1") && !refsA.has("2"));
      assert.ok(refsB.has("2") && !refsB.has("1"));
      assert.ok(b.calls.length > 0, "loader B scanned despite loader A warming first");
    } finally {
      delete process.env.HYDRA_TARGET_GITHUB_REPO;
      __resetTargetConfig();
    }
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
    assert.equal(typeof res._body.generated_at, "string");
  });
});

// ---------------------------------------------------------------------------
// Work-queue hygiene (issue #1690): self-healing reap + reconcile engine.
// ---------------------------------------------------------------------------

describe("getCandidateFeed — merged work-queue entries are reaped, not just hidden (#1690)", () => {
  test("a merged-suppressed work-queue entry is LREM'd via the injected reap", async () => {
    const reaped: string[] = [];
    const staleRaw = JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) });
    const liveRaw = JSON.stringify({ reference: "item-999 unbuilt", queuedAt: isoAgo(0) });
    const deps = makeDeps({
      getWorkQueueItems: async () => [staleRaw, liveRaw],
      loadMergedAnchorRefs: async () => new Set(["item-322"]),
      removeWorkQueueItem: async (raw) => { reaped.push(raw); return 1; },
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.merged_suppressed, 1);
    assert.deepEqual(reaped, [staleRaw], "exactly the stale raw entry is removed");
    assert.ok(feed.candidates.some((c) => c.anchorRef.includes("item-999")));
  });

  test("kanban merged suppression does NOT trigger the work-queue reap", async () => {
    const reaped: string[] = [];
    const deps = makeDeps({
      loadBacklog: async () => ({
        inProgress: [],
        queued: [{ id: 882, title: "Merged anchor", movedAt: isoAgo(0) }],
        backlog: [],
      }),
      loadMergedAnchorRefs: async () => new Set(["882"]),
      removeWorkQueueItem: async (raw) => { reaped.push(raw); return 1; },
    });
    const feed = await getCandidateFeed({ now: NOW }, deps);
    assert.equal(feed.merged_suppressed, 1);
    assert.deepEqual(reaped, [], "kanban lane never touches the work queue");
  });

  test("a failing reap degrades to suppress-only (never throws, still suppressed)", async () => {
    const deps = makeDeps({
      getWorkQueueItems: async () => [
        JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) }),
      ],
      loadMergedAnchorRefs: async () => new Set(["item-322"]),
      removeWorkQueueItem: async () => { throw new Error("redis down"); },
    });
    await assert.doesNotReject(async () => {
      const feed = await getCandidateFeed({ now: NOW }, deps);
      assert.equal(feed.merged_suppressed, 1);
      assert.equal(feed.candidates.length, 0);
    });
  });
});

describe("harvestOrchIssueRefs — pure ref harvesting (#1690)", () => {
  test("harvests #NNN and issue-NNN from reference + reason; dedupes", () => {
    const refs = harvestOrchIssueRefs({
      reference: "fix the feed (#1683) per issue-1683",
      reason: "filed from retro, see #1690",
    });
    assert.deepEqual(refs.sort(), ["1683", "1690"]);
  });

  test("context is excluded; bare numbers and item-NNN never match", () => {
    assert.deepEqual(
      harvestOrchIssueRefs({
        reference: "betting-prod-api-status-500-db-migration-drift item-322",
        reason: "no refs here either",
      }),
      [],
      "status-500 / item-322 / bare numbers are not orch issue refs",
    );
    // `context` is not part of the harvest surface at all.
    assert.deepEqual(
      harvestOrchIssueRefs({ reference: "slug-anchor", reason: "r" } as any),
      [],
    );
  });

  test("non-string fields degrade to no refs", () => {
    assert.deepEqual(harvestOrchIssueRefs({ reference: 42 as any, reason: null as any }), []);
  });
});

describe("reconcileWorkQueue — resolved-state reaper (#1690)", () => {
  const closedRaw = JSON.stringify({
    reference: "betting-prod-api-status-500-db-migration-drift (#1683)",
    queuedAt: isoAgo(0),
  });
  const openRaw = JSON.stringify({ reference: "live anchor (#1700)", queuedAt: isoAgo(0) });
  const mergedRaw = JSON.stringify({ reference: "item-322 maker order", queuedAt: isoAgo(0) });
  const noRefRaw = JSON.stringify({ reference: "slug-with-no-refs", queuedAt: isoAgo(0) });

  function makeReconcileDeps(over: any = {}) {
    const removed: string[] = [];
    const deps = {
      getWorkQueueItems: async () => [closedRaw, openRaw, mergedRaw, noRefRaw],
      removeWorkQueueItem: async (raw: string) => { removed.push(raw); return 1; },
      loadMergedAnchorRefs: async () => new Set<string>(["item-322"]),
      getIssueState: async (n: string) => (n === "1683" ? "closed" as const : "open" as const),
      ...over,
    };
    return { deps, removed };
  }

  test("removes closed-issue and merged entries; keeps open and ref-less entries", async () => {
    const { deps, removed } = makeReconcileDeps();
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.scanned, 4);
    assert.equal(result.removed, 2);
    assert.deepEqual(removed.sort(), [closedRaw, mergedRaw].sort());
    assert.deepEqual(
      result.details.map((d) => d.cause).sort(),
      ["closed-issue", "merged-work"],
    );
  });

  test("an undeterminable issue state keeps the entry (fail open)", async () => {
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => [closedRaw],
      getIssueState: async () => null,
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 0);
    assert.deepEqual(removed, []);
  });

  test("an entry referencing one closed and one open issue is kept", async () => {
    const mixedRaw = JSON.stringify({ reference: "epic slice (#1683, #1700)", queuedAt: isoAgo(0) });
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => [mixedRaw],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 0);
    assert.deepEqual(removed, []);
  });

  test("duplicate raws are reaped once and counted by LREM total", async () => {
    let lremCalls = 0;
    const { deps } = makeReconcileDeps({
      getWorkQueueItems: async () => [closedRaw, closedRaw],
      removeWorkQueueItem: async () => { lremCalls++; return lremCalls === 1 ? 2 : 0; },
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 2, "LREM count 0 removed both duplicates in one call");
    assert.equal(result.details.length, 1, "second encounter LREMs 0 and is not re-reported");
  });

  test("issue-state lookups are cached per run (one gh call per distinct issue)", async () => {
    const lookups: string[] = [];
    const a = JSON.stringify({ reference: "slice A (#1683)", queuedAt: isoAgo(0) });
    const b = JSON.stringify({ reference: "slice B (#1683)", queuedAt: isoAgo(0) });
    const { deps } = makeReconcileDeps({
      getWorkQueueItems: async () => [a, b],
      getIssueState: async (n: string) => { lookups.push(n); return "closed" as const; },
    });
    const result = await reconcileWorkQueue(deps);
    assert.deepEqual(lookups, ["1683"], "second entry reuses the cached state");
    assert.equal(result.removed, 2);
  });

  test("a failing queue read degrades to a no-op result (never throws)", async () => {
    const { deps } = makeReconcileDeps({
      getWorkQueueItems: async () => { throw new Error("redis down"); },
    });
    await assert.doesNotReject(async () => {
      const result = await reconcileWorkQueue(deps);
      assert.deepEqual(result, { scanned: 0, removed: 0, details: [] });
    });
  });

  test("a failing merged-refs reader still allows the closed-issue path", async () => {
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => [closedRaw],
      loadMergedAnchorRefs: async () => { throw new Error("gh unreachable"); },
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, [closedRaw]);
  });

  test("corrupt JSON entries are kept (cleanWorkQueue's concern)", async () => {
    const { deps, removed } = makeReconcileDeps({
      getWorkQueueItems: async () => ["not-json{{{", closedRaw],
    });
    const result = await reconcileWorkQueue(deps);
    assert.equal(result.scanned, 2);
    assert.deepEqual(removed, [closedRaw]);
  });
});
