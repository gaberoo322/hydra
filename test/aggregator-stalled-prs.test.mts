/**
 * Stalled-PRs aggregator — rank-1 `prs-not-landing` (issue #4624,
 * ADR-0034 §8.1 rank 1).
 *
 * Pure: the PR-list and required-contexts readers are injected stubs, so no
 * case spawns `gh`. The composer cases stub every other feed source too.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyStalledPrs,
  classifyRollupEntry,
  collapseRollupByContext,
  getStalledPrs,
  STALLED_PR_FIELDS,
  type StalledPr,
  type StalledPrsResult,
} from "../src/aggregators/stalled-prs.ts";
import {
  DEFAULT_THRESHOLDS,
  selectPrsWithFailedCi,
  type StuckItems,
  type StuckItemsDeps,
} from "../src/aggregators/stuck-items.ts";
import { getAttentionFeed, type AttentionFeedDeps } from "../src/attention.ts";
import { PR_LIST_JSON_FIELDS, parsePrRows, type PrRow } from "../src/github/prs.ts";
import type { FrictionPatternsSnapshot } from "../src/aggregators/friction-patterns.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/index.ts";
import type { Action } from "../src/schemas/operator-actions.ts";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const REQUIRED = new Set(["test", "tier-gate"]);

function pr(over: Partial<PrRow> & { number: number }): PrRow {
  return {
    title: `PR #${over.number}`,
    url: `https://github.com/gaberoo322/hydra/pull/${over.number}`,
    state: "OPEN",
    headRefName: "",
    createdAt: "",
    mergedAt: "",
    updatedAt: "2026-09-29T10:00:00.000Z",
    mergeable: "MERGEABLE",
    isDraft: false,
    autoMergeArmed: false,
    statusCheckRollup: [],
    ...over,
  };
}

const allGreen = [
  { name: "test", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-09-29T09:00:00Z" },
  { name: "tier-gate", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-09-29T09:00:00Z" },
];

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

describe("classifyStalledPrs — admission lines", () => {
  test("a CONFLICTING PR with a failed required check is emitted once, as conflicted", () => {
    const out = classifyStalledPrs(
      [pr({ number: 1, mergeable: "CONFLICTING", statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] })],
      REQUIRED,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].line, "conflicted");
  });

  test("a failed required check outranks unshepherded (failed-required, not both)", () => {
    const out = classifyStalledPrs(
      [pr({ number: 2, statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }, allGreen[1]] })],
      REQUIRED,
    );
    assert.deepEqual(out.map((p) => [p.number, p.line, p.failedChecks]), [[2, "failed-required", ["test"]]]);
  });

  test("UNKNOWN mergeability is not admitted to any line", () => {
    const rows = [
      pr({ number: 3, mergeable: "UNKNOWN", statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] }),
      pr({ number: 4, mergeable: "", statusCheckRollup: allGreen }),
      pr({ number: 5, mergeable: undefined, statusCheckRollup: allGreen }),
      pr({ number: 6, mergeable: "garbage" }),
    ];
    assert.deepEqual(classifyStalledPrs(rows, REQUIRED), []);
    assert.deepEqual(classifyStalledPrs(rows, null), []);
  });

  test("a draft PR is never admitted", () => {
    const rows = [
      pr({ number: 7, isDraft: true, mergeable: "CONFLICTING" }),
      pr({ number: 8, isDraft: true, statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] }),
      pr({ number: 9, isDraft: true, statusCheckRollup: allGreen }),
    ];
    assert.deepEqual(classifyStalledPrs(rows, REQUIRED), []);
  });

  test("an advisory-only red PR is not admitted as failed-required", () => {
    const out = classifyStalledPrs(
      [
        pr({
          number: 10,
          autoMergeArmed: true,
          statusCheckRollup: [...allGreen, { name: "advisory-checks", conclusion: "FAILURE" }],
        }),
      ],
      REQUIRED,
    );
    assert.deepEqual(out, []);
  });

  test("an advisory red does not block the unshepherded all-green predicate", () => {
    const out = classifyStalledPrs(
      [pr({ number: 11, statusCheckRollup: [...allGreen, { name: "advisory-checks", conclusion: "FAILURE" }] })],
      REQUIRED,
    );
    assert.deepEqual(out.map((p) => p.line), ["unshepherded"]);
    assert.equal(out[0].requiredGreen, 2);
    assert.equal(out[0].requiredTotal, 2);
  });

  test("a null required set admits only conflicted rows", () => {
    const rows = [
      pr({ number: 12, mergeable: "CONFLICTING" }),
      pr({ number: 13, statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] }),
      pr({ number: 14, statusCheckRollup: allGreen }),
    ];
    assert.deepEqual(classifyStalledPrs(rows, null).map((p) => [p.number, p.line]), [[12, "conflicted"]]);
  });

  test("unshepherded requires auto-merge unset and every required context green", () => {
    const rows = [
      pr({ number: 15, autoMergeArmed: true, statusCheckRollup: allGreen }),
      // Auto-merge state unknown (field not requested) never admits.
      pr({ number: 16, autoMergeArmed: null, statusCheckRollup: allGreen }),
      // A required context missing from the rollup is NOT green.
      pr({ number: 17, statusCheckRollup: [allGreen[0]] }),
      // A pending required context is neither failed nor green.
      pr({ number: 18, statusCheckRollup: [allGreen[0], { name: "tier-gate", status: "IN_PROGRESS" }] }),
      pr({ number: 19, statusCheckRollup: allGreen }),
    ];
    assert.deepEqual(classifyStalledPrs(rows, REQUIRED).map((p) => [p.number, p.line]), [[19, "unshepherded"]]);
  });

  test("results sort oldest updatedAt first", () => {
    const out = classifyStalledPrs(
      [
        pr({ number: 20, mergeable: "CONFLICTING", updatedAt: "2026-09-29T11:00:00Z" }),
        pr({ number: 21, mergeable: "CONFLICTING", updatedAt: "2026-09-28T11:00:00Z" }),
      ],
      REQUIRED,
    );
    assert.deepEqual(out.map((p) => p.number), [21, 20]);
  });
});

describe("rollup collapse + verdicts", () => {
  test("a superseded CANCELLED/FAILURE run followed by a SUCCESS rerun is green", () => {
    const rollup = [
      { name: "test", conclusion: "CANCELLED", completedAt: "2026-09-29T08:00:00Z" },
      { name: "test", conclusion: "FAILURE", completedAt: "2026-09-29T08:30:00Z" },
      { name: "test", conclusion: "SUCCESS", completedAt: "2026-09-29T09:00:00Z" },
    ];
    assert.equal(classifyRollupEntry(collapseRollupByContext(rollup).get("test")), "green");
    // Order-independent: the latest timestamp wins even if listed first.
    assert.equal(classifyRollupEntry(collapseRollupByContext([...rollup].reverse()).get("test")), "green");
    const out = classifyStalledPrs(
      [pr({ number: 30, autoMergeArmed: true, statusCheckRollup: [...rollup, allGreen[1]] })],
      REQUIRED,
    );
    assert.deepEqual(out, []);
  });

  test("a zero-time completedAt (in-progress rerun) does not lose to an older FAILURE", () => {
    const rollup = [
      { name: "test", conclusion: "FAILURE", completedAt: "2026-09-29T08:00:00Z" },
      { name: "test", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-09-29T09:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
    ];
    const winner = collapseRollupByContext(rollup).get("test");
    assert.equal(winner?.status, "IN_PROGRESS");
    assert.equal(classifyRollupEntry(winner), "pending");
    assert.equal(classifyRollupEntry(collapseRollupByContext([...rollup].reverse()).get("test")), "pending");
  });

  test("CheckRun and StatusContext entries collapse under one context name", () => {
    const rollup = [
      { name: "deep-qa-gate", conclusion: "SUCCESS", completedAt: "2026-09-29T08:00:00Z" },
      { context: "deep-qa-gate", state: "FAILURE", startedAt: "2026-09-29T09:00:00Z" },
    ];
    const collapsed = collapseRollupByContext(rollup);
    assert.equal(collapsed.size, 1);
    assert.equal(classifyRollupEntry(collapsed.get("deep-qa-gate")), "failing");
  });

  test("failing conclusions and states are exactly the documented sets", () => {
    for (const c of ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]) {
      assert.equal(classifyRollupEntry({ name: "x", conclusion: c }), "failing", c);
    }
    for (const s of ["FAILURE", "ERROR"]) {
      assert.equal(classifyRollupEntry({ context: "x", state: s }), "failing", s);
    }
    for (const c of ["SUCCESS", "NEUTRAL", "SKIPPED"]) {
      assert.equal(classifyRollupEntry({ name: "x", conclusion: c }), "green", c);
    }
    assert.equal(classifyRollupEntry({ context: "x", state: "SUCCESS" }), "green");
    for (const e of [
      { name: "x", status: "QUEUED" },
      { name: "x", status: "IN_PROGRESS", conclusion: "" },
      { context: "x", state: "PENDING" },
      undefined,
    ]) {
      assert.equal(classifyRollupEntry(e), "pending");
    }
  });

  test("stuck-items selectPrsWithFailedCi delegates to the shared collapse", () => {
    const rows = [
      pr({
        number: 31,
        statusCheckRollup: [
          { name: "changelog-check", conclusion: "CANCELLED", completedAt: "2026-09-29T08:00:00Z" },
          { name: "changelog-check", conclusion: "SUCCESS", completedAt: "2026-09-29T09:00:00Z" },
          { context: "deep-qa-gate", state: "ERROR" },
        ],
      }),
    ];
    const out = selectPrsWithFailedCi(rows, null);
    assert.deepEqual(out[0].failedChecks, ["deep-qa-gate"]);
  });
});

// ---------------------------------------------------------------------------
// PR-list seam — additive fields
// ---------------------------------------------------------------------------

describe("github/prs.ts additive fields (#4624)", () => {
  test("parsePrRows defaults mergeable/isDraft/autoMergeArmed when unrequested", () => {
    const [row] = parsePrRows([{ number: 1 }], "o/r");
    assert.equal(row.mergeable, "");
    assert.equal(row.isDraft, null);
    assert.equal(row.autoMergeArmed, null);
  });

  test("parsePrRows lifts mergeable/isDraft/autoMergeRequest and rollup timestamps", () => {
    const [armed, unarmed] = parsePrRows(
      [
        {
          number: 1,
          mergeable: "conflicting",
          isDraft: true,
          autoMergeRequest: { enabledAt: "x" },
          statusCheckRollup: [
            { __typename: "StatusContext", context: "c", state: "ERROR", startedAt: "s" },
            { __typename: "CheckRun", name: "n", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "t" },
          ],
        },
        { number: 2, isDraft: false, autoMergeRequest: null },
      ],
      "o/r",
    );
    assert.equal(armed.mergeable, "CONFLICTING");
    assert.equal(armed.isDraft, true);
    assert.equal(armed.autoMergeArmed, true);
    assert.equal(armed.statusCheckRollup[0].state, "ERROR");
    assert.equal(armed.statusCheckRollup[0].startedAt, "s");
    assert.equal(armed.statusCheckRollup[1].status, "COMPLETED");
    assert.equal(armed.statusCheckRollup[1].completedAt, "t");
    assert.equal(unarmed.autoMergeArmed, false);
    assert.equal(unarmed.isDraft, false);
  });

  test("PR_LIST_JSON_FIELDS carries mergedAt (#4700); stalled-prs passes a fields override", () => {
    assert.equal(PR_LIST_JSON_FIELDS, "number,state,title,url,headRefName,createdAt,mergedAt,updatedAt,statusCheckRollup");
    assert.equal(STALLED_PR_FIELDS, `${PR_LIST_JSON_FIELDS},isDraft,mergeable,autoMergeRequest`);
  });
});

// ---------------------------------------------------------------------------
// getStalledPrs — asserted emptiness + never throws
// ---------------------------------------------------------------------------

describe("getStalledPrs — sources + asserted emptiness", () => {
  test("scanned is the open PR rows returned, not the admitted count; fields override is passed", async () => {
    let seenFields: string | undefined;
    let seenRepo: string | undefined;
    const res = await getStalledPrs({
      githubRepo: "gaberoo322/hydra",
      listOpenPrs: async (opts) => {
        seenFields = opts?.fields;
        seenRepo = opts?.repo;
        return { ok: true, rows: [pr({ number: 1, autoMergeArmed: true, statusCheckRollup: allGreen }), pr({ number: 2, mergeable: "CONFLICTING" })] };
      },
      listRequiredStatusContextsOrNull: async () => [...REQUIRED],
    });
    assert.equal(seenFields, STALLED_PR_FIELDS);
    assert.equal(seenRepo, "gaberoo322/hydra");
    assert.equal(res.scanned, 2);
    assert.equal(res.items.length, 1);
    assert.equal(res.sourcesOk, true);
    assert.deepEqual(res.sourceErrors, []);
  });

  test("a failed PR-list read is sourcesOk:false with a named pr-list error, never an asserted zero", async () => {
    const res = await getStalledPrs({
      listOpenPrs: async () => ({ ok: false, code: "timeout" }) as never,
      listRequiredStatusContextsOrNull: async () => [...REQUIRED],
    });
    assert.equal(res.sourcesOk, false);
    assert.deepEqual(res.sourceErrors, ["pr-list"]);
    assert.equal(res.scanned, 0);
  });

  test("a null required set names required-contexts and still admits conflicted rows", async () => {
    const res = await getStalledPrs({
      listOpenPrs: async () => ({
        ok: true,
        rows: [pr({ number: 1, mergeable: "CONFLICTING" }), pr({ number: 2, statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] })],
      }),
      listRequiredStatusContextsOrNull: async () => null,
    });
    assert.deepEqual(res.sourceErrors, ["required-contexts"]);
    assert.equal(res.sourcesOk, false);
    assert.deepEqual(res.items.map((p) => [p.number, p.line]), [[1, "conflicted"]]);
  });

  test("an empty required set is UNKNOWN: no unshepherded admission, required-contexts named", async () => {
    const res = await getStalledPrs({
      listOpenPrs: async () => ({
        ok: true,
        rows: [pr({ number: 1, mergeable: "CONFLICTING" }), pr({ number: 2 })],
      }),
      listRequiredStatusContextsOrNull: async () => [],
    });
    assert.deepEqual(res.sourceErrors, ["required-contexts"]);
    assert.equal(res.sourcesOk, false);
    assert.deepEqual(res.items.map((p) => [p.number, p.line]), [[1, "conflicted"]]);
  });

  test("classifyStalledPrs with an empty Set admits no unshepherded row", () => {
    assert.deepEqual(classifyStalledPrs([pr({ number: 3 })], new Set()), []);
  });

  test("getStalledPrs never throws when both readers throw", async () => {
    const res = await getStalledPrs({
      listOpenPrs: () => {
        throw new Error("sync boom");
      },
      listRequiredStatusContextsOrNull: async () => {
        throw new Error("async boom");
      },
    });
    assert.deepEqual(res.sourceErrors, ["pr-list", "required-contexts"]);
    assert.deepEqual(res.items, []);
  });
});

// ---------------------------------------------------------------------------
// Composer wiring — rank 1
// ---------------------------------------------------------------------------

function stuckSnapshot(over: Partial<StuckItems> = {}): StuckItems {
  return {
    blockedOver2d: [],
    needsInfoWaiting: [],
    prsWithFailedCi: [],
    thresholds: DEFAULT_THRESHOLDS,
    generatedAt: NOW.toISOString(),
    scanned: 0,
    sourcesOk: true,
    ...over,
  };
}

function frictionSnapshot(): FrictionPatternsSnapshot {
  return {
    bySkill: [],
    thresholdCandidates: [],
    recentMetaFrictionIssues: [],
    promotionThreshold: PROMOTION_THRESHOLD,
    candidateWindow: 1,
    windowHours: 168,
    generatedAt: NOW.toISOString(),
    scanned: 0,
    sourcesOk: true,
  };
}

function stalled(line: StalledPr["line"], number: number, over: Partial<StalledPr> = {}): StalledPr {
  return {
    number,
    title: `PR #${number}`,
    url: `https://github.com/gaberoo322/hydra/pull/${number}`,
    updatedAt: "2026-09-29T10:00:00.000Z",
    line,
    failedChecks: line === "failed-required" ? ["test"] : [],
    requiredGreen: line === "unshepherded" ? 8 : 0,
    requiredTotal: 8,
    ...over,
  };
}

function feedDeps(over: Partial<AttentionFeedDeps> = {}): AttentionFeedDeps {
  return {
    now: NOW,
    getStuckItems: async () => stuckSnapshot(),
    getStalledPrs: async () => ({ items: [], scanned: 0, sourcesOk: true, sourceErrors: [] }),
    getFrictionPatterns: async () => frictionSnapshot(),
    loadDismissedIds: async () => [],
    recordSurfaced: async () => {},
    readPaused: async () => ({ paused: false }),
    readSessionBlockedUntil: async () => null,
    readSchedulerStopReason: async () => null,
    readShaDrift: async () => ({ deployedSha: "a", originMasterSha: "a", firstSeenMs: null, driftSeconds: null, active: false }),
    ...over,
  };
}

describe("getAttentionFeed — rank-1 stalled-PRs wiring", () => {
  const threeLines: StalledPrsResult = {
    items: [stalled("conflicted", 1), stalled("failed-required", 2, { failedChecks: ["test", "tier-gate"] }), stalled("unshepherded", 3)],
    scanned: 5,
    sourcesOk: true,
    sourceErrors: [],
  };

  test("each line resolves its registry action with {repo, number, kind: pr}", async () => {
    let seenRepo: string | undefined;
    const result = await getAttentionFeed(
      feedDeps({
        githubRepo: "gaberoo322/hydra",
        getStalledPrs: async (d) => {
          seenRepo = d?.githubRepo;
          return threeLines;
        },
      }),
    );
    assert.equal(seenRepo, "gaberoo322/hydra");
    const rank1 = result.items.filter((i) => i.bucket === "prs-not-landing");
    assert.deepEqual(
      rank1.map((i) => [i.id, i.key, i.signal]),
      [
        ["pr-conflicted-1", "prs-not-landing:conflicted", "breakage"],
        ["pr-failed-ci-2", "prs-not-landing:failed-required", "breakage"],
        ["pr-unshepherded-3", "prs-not-landing:unshepherded", "blocked-on-human"],
      ],
    );
    for (const item of rank1) {
      const actions: Action[] = [item.action.recommended, item.action.alternatives[0], item.action.alternatives[1]];
      const templates = actions
        .map((a) => (a.kind === "terminal-skill" ? a.command : a.kind === "in-dashboard" ? a.route : ""))
        .join(" ");
      assert.doesNotMatch(templates, /\{(repo|number|kind)\}/);
    }
    const failed = rank1.find((i) => i.id === "pr-failed-ci-2")!;
    assert.match(failed.action.recommended.kind === "terminal-skill" ? failed.action.recommended.command : "", /gh pr checks 2 --repo gaberoo322\/hydra/);
    assert.deepEqual([failed.observedValue, failed.threshold, failed.thresholdLabel], [2, 1, "≥ 1 failed required check"]);
    const conflicted = rank1.find((i) => i.id === "pr-conflicted-1")!;
    assert.deepEqual([conflicted.observedValue, conflicted.threshold, conflicted.thresholdLabel], [1, 1, "mergeable = CONFLICTING"]);
    const unshep = rank1.find((i) => i.id === "pr-unshepherded-3")!;
    assert.deepEqual([unshep.observedValue, unshep.threshold, unshep.thresholdLabel], [8, 8, "required checks green, auto-merge unset"]);
    const bucket = result.buckets.find((b) => b.bucket === "prs-not-landing")!;
    assert.equal(bucket.scanned, 5, "scanned = open PR rows, not the admitted count");
    assert.equal(bucket.count, 3);
  });

  test("a failed stalled-prs source renders rank 1 UNKNOWN with the named error", async () => {
    const result = await getAttentionFeed(
      feedDeps({
        getStalledPrs: async () => ({ items: [], scanned: 0, sourcesOk: false, sourceErrors: ["pr-list"] }),
      }),
    );
    const bucket = result.buckets.find((b) => b.bucket === "prs-not-landing")!;
    assert.equal(bucket.sourcesOk, false);
    assert.deepEqual(bucket.sourceErrors, ["pr-list"]);
    assert.equal(result.sourcesOk, false);
  });

  test("getAttentionFeed never throws when stalled-prs throws", async () => {
    const result = await getAttentionFeed(
      feedDeps({
        getStalledPrs: () => {
          throw new Error("boom");
        },
      }),
    );
    const bucket = result.buckets.find((b) => b.bucket === "prs-not-landing")!;
    assert.deepEqual(bucket.sourceErrors, ["stalled-prs"]);
  });

  test("the feed injects an empty PR lister into getStuckItems (one gh pr list call)", async () => {
    let stuckDeps: StuckItemsDeps | undefined;
    const result = await getAttentionFeed(
      feedDeps({
        getStuckItems: async (d) => {
          stuckDeps = d;
          return stuckSnapshot({ scanned: 3 });
        },
      }),
    );
    assert.ok(stuckDeps?.listOpenPrsOrEmpty, "a PR lister override is injected");
    assert.deepEqual(await stuckDeps!.listOpenPrsOrEmpty!("x"), []);
    const waiting = result.buckets.find((b) => b.bucket === "waiting-on-you")!;
    assert.equal(waiting.scanned, 3, "waiting-on-you.scanned = stuck.scanned");
  });
});
