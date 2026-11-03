/**
 * Regression tests for the stuck-items aggregator (issue #617, PRD #615).
 *
 * After issue #915 the aggregator reads GitHub through the **GitHub Issue/PR
 * Read seam** (`src/github/issues.ts`) instead of a local argv + parser. Tests
 * stub the seam readers (`listIssuesByLabel` / `listOpenPrsOrEmpty`)
 * rather than crafting raw `gh` JSON strings — the canonical-row parse now lives
 * in (and is tested by) the seam's own suite (`github-issues.test.mts`). The
 * pure classifier here (`selectPrsWithFailedCi`) is tested
 * directly against the seam's `IssueRow`/`PrRow` shapes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getStuckItems,
  selectPrsWithFailedCi,
  DEFAULT_THRESHOLDS,
} from "../src/aggregators/stuck-items.ts";
import type { IssueReadResult, IssueRow, PrRow } from "../src/github/issues.ts";
import { readFileSync } from "node:fs";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function issueRow(over: Partial<IssueRow> & { number: number }): IssueRow {
  return {
    number: over.number,
    title: over.title ?? `Issue #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/issues/${over.number}`,
    createdAt: over.createdAt ?? "",
    labels: over.labels ?? [],
    body: over.body ?? "",
    state: over.state ?? "OPEN",
  };
}

function prRow(over: Partial<PrRow> & { number: number }): PrRow {
  return {
    number: over.number,
    title: over.title ?? `PR #${over.number}`,
    url: over.url ?? `https://github.com/gaberoo322/hydra/pull/${over.number}`,
    state: over.state ?? "OPEN",
    headRefName: over.headRefName ?? "",
    createdAt: over.createdAt ?? "",
    updatedAt: over.updatedAt ?? "",
    statusCheckRollup: over.statusCheckRollup ?? [],
  };
}

/**
 * Build a `listIssuesByLabel` stub (the discriminated seam reader the waiting
 * read consumes) from a label->rows map. Unknown labels resolve to `{ok, []}`.
 * `failLabels` model a failed `gh` read for those labels.
 */
function makeLabelReader(byLabel: Record<string, IssueRow[]>, failLabels: string[] = []) {
  return (async (label: string): Promise<IssueReadResult<IssueRow>> =>
    failLabels.includes(label)
      ? ({ ok: false, code: "gh-failed" } as unknown as IssueReadResult<IssueRow>)
      : ({ ok: true, rows: byLabel[label] ?? [] } as IssueReadResult<IssueRow>)) as never;
}

/** Blocker-lookup stub: no open blockers anywhere (the happy-path fixtures). */
const noBlockers = (async () => ({ ok: true, rows: [] })) as never;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("selectPrsWithFailedCi — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(selectPrsWithFailedCi([]), []);
  });

  test("keeps PRs with at least one FAILURE check; reports the failing names", () => {
    const rows = [
      prRow({
        number: 1,
        title: "good",
        url: "u1",
        updatedAt: "2026-05-26T00:00:00Z",
        statusCheckRollup: [{ conclusion: "SUCCESS", name: "test" }],
      }),
      prRow({
        number: 2,
        title: "broken",
        url: "u2",
        updatedAt: "2026-05-26T01:00:00Z",
        statusCheckRollup: [
          { conclusion: "SUCCESS", name: "typecheck" },
          { conclusion: "FAILURE", name: "test" },
          { conclusion: "TIMED_OUT", name: "build" },
        ],
      }),
    ];
    const out = selectPrsWithFailedCi(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 2);
    assert.deepEqual(out[0].failedChecks, ["test", "build"]);
  });

  test("PENDING/SUCCESS-only rollups are filtered out", () => {
    const rows = [
      prRow({
        number: 3,
        title: "still running",
        url: "u3",
        updatedAt: "2026-05-26T02:00:00Z",
        statusCheckRollup: [{ conclusion: "PENDING", name: "ci" }],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows), []);
  });

  test("falls back to context then 'check' for a nameless failing entry", () => {
    const rows = [
      prRow({
        number: 4,
        statusCheckRollup: [
          { conclusion: "FAILURE", context: "legacy-status" },
          { conclusion: "FAILURE" },
        ],
      }),
    ];
    const out = selectPrsWithFailedCi(rows);
    assert.deepEqual(out[0].failedChecks, ["legacy-status", "check"]);
  });

  // Issue #4569: the ambient-red `advisory-checks` job is not in branch
  // protection, so counting it flagged EVERY open PR as breakage.
  test("#4569: with a known required set, a PR failing only a NON-required check is not breakage", () => {
    const rows = [
      prRow({
        number: 5,
        statusCheckRollup: [
          { conclusion: "SUCCESS", name: "test" },
          { conclusion: "FAILURE", name: "advisory-checks" },
        ],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows, new Set(["test", "tier-gate"])), []);
  });

  test("#4569: with a known required set, failedChecks names ONLY the required failures", () => {
    const rows = [
      prRow({
        number: 6,
        statusCheckRollup: [
          { conclusion: "FAILURE", name: "advisory-checks" },
          { conclusion: "FAILURE", name: "test" },
          { conclusion: "SUCCESS", name: "tier-gate" },
        ],
      }),
    ];
    const out = selectPrsWithFailedCi(rows, new Set(["test", "tier-gate"]));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].failedChecks, ["test"]);
  });

  test("#4569: an UNKNOWN required set (null) over-alerts — every failing entry still counts", () => {
    const rows = [
      prRow({
        number: 7,
        statusCheckRollup: [{ conclusion: "FAILURE", name: "advisory-checks" }],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows, null)[0].failedChecks, ["advisory-checks"]);
    assert.deepEqual(selectPrsWithFailedCi(rows)[0].failedChecks, ["advisory-checks"]);
  });
});

describe("selectPrsWithFailedCi — shared latest-wins collapse semantics (#4624)", () => {
  const base = { number: 7, title: "t", url: "u", updatedAt: "2026-05-26T00:00:00Z" };

  test("a SUCCESS rerun supersedes an earlier FAILURE of the same check", () => {
    const rows = [
      prRow({
        ...base,
        statusCheckRollup: [
          { conclusion: "FAILURE", name: "test", completedAt: "2026-05-26T01:00:00Z" },
          { conclusion: "SUCCESS", name: "test", completedAt: "2026-05-26T02:00:00Z" },
        ],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows), []);
  });

  test("StatusContext FAILURE/ERROR states count as failed", () => {
    const rows = [
      prRow({
        ...base,
        statusCheckRollup: [
          { context: "deep-qa-gate", state: "FAILURE" },
          { context: "legacy", state: "ERROR" },
        ],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows)[0].failedChecks, ["deep-qa-gate", "legacy"]);
  });

  test("a cancelled check still counts in failedChecks", () => {
    const rows = [
      prRow({
        ...base,
        statusCheckRollup: [{ conclusion: "CANCELLED", name: "test", completedAt: "2026-05-26T01:00:00Z" }],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows)[0].failedChecks, ["test"]);
  });

  test("an in-progress rerun with a zero-time completedAt supersedes an older FAILURE", () => {
    const rows = [
      prRow({
        ...base,
        statusCheckRollup: [
          { conclusion: "FAILURE", name: "test", completedAt: "2026-05-26T01:00:00Z" },
          { name: "test", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-05-26T02:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
        ],
      }),
    ];
    assert.deepEqual(selectPrsWithFailedCi(rows), []);
  });
});

describe("getStuckItems — required-context wiring (#4569)", () => {
  const onlyAdvisoryRed = async () => [
    prRow({
      number: 8,
      statusCheckRollup: [
        { conclusion: "SUCCESS", name: "test" },
        { conclusion: "FAILURE", name: "advisory-checks" },
      ],
    }),
  ];

  test("reads the required set through the injected seam reader and drops advisory-only reds", async () => {
    const result = await getStuckItems({
      listIssuesByLabel: makeLabelReader({}),
      listIssuesBySearch: noBlockers,
      listOpenPrsOrEmpty: onlyAdvisoryRed,
      listRequiredStatusContextsOrNull: async () => ["test"],
    });
    assert.deepEqual(result.prsWithFailedCi, []);
    assert.equal(result.sourcesOk, true);
  });

  test("an unreadable required set (null) keeps the PR surfaced rather than going silent", async () => {
    const result = await getStuckItems({
      listIssuesByLabel: makeLabelReader({}),
      listIssuesBySearch: noBlockers,
      listOpenPrsOrEmpty: onlyAdvisoryRed,
      listRequiredStatusContextsOrNull: async () => null,
    });
    assert.deepEqual(result.prsWithFailedCi.map((p) => p.number), [8]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getStuckItems — happy path", () => {
  test("returns three buckets + thresholds + generatedAt", async () => {
    const result = await getStuckItems({
      listRequiredStatusContextsOrNull: async () => null,
      now: NOW,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader({
        blocked: [
          issueRow({
            number: 1,
            title: "blocked old",
            url: "u1",
            createdAt: "2026-05-22T00:00:00Z", // 4.5d old → stuck (≥2d)
            labels: ["blocked"],
          }),
        ],
        "needs-info": [
          issueRow({
            number: 2,
            title: "needs-info waiting",
            url: "u2",
            createdAt: "2026-05-24T00:00:00Z", // 2.5d old → stuck (≥1d)
            labels: ["needs-info"],
          }),
        ],
      }),
      listOpenPrsOrEmpty: async () => [
        prRow({
          number: 555,
          title: "ci broken",
          url: "p555",
          updatedAt: "2026-05-26T00:00:00Z",
          statusCheckRollup: [{ conclusion: "FAILURE", name: "test" }],
        }),
      ],
    });
    assert.equal(result.blockedOver2d.length, 1);
    assert.equal(result.needsInfoWaiting.length, 1);
    assert.equal(result.prsWithFailedCi.length, 1);
    assert.deepEqual(result.thresholds, DEFAULT_THRESHOLDS);
    assert.equal(typeof result.generatedAt, "string");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getStuckItems — empty state", () => {
  test("no labeled issues, no failing PRs → empty buckets", async () => {
    const result = await getStuckItems({
      listRequiredStatusContextsOrNull: async () => null,
      now: NOW,
      listIssuesByLabel: makeLabelReader({}),
      listIssuesBySearch: noBlockers,
      listOpenPrsOrEmpty: async () => [],
    });
    assert.deepEqual(result.blockedOver2d, []);
    assert.deepEqual(result.needsInfoWaiting, []);
    assert.deepEqual(result.prsWithFailedCi, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: custom thresholds + sub-source failure isolation
// ---------------------------------------------------------------------------

describe("getStuckItems — custom thresholds", () => {
  test("overriding blockedDays reclassifies the bucket", async () => {
    const reader = {
      now: NOW,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader({
        blocked: [
          issueRow({
            number: 1,
            title: "young blocked",
            url: "u1",
            createdAt: "2026-05-26T00:00:00Z", // 12h old
            labels: ["blocked"],
          }),
        ],
      }),
      listOpenPrsOrEmpty: async () => [],
      listRequiredStatusContextsOrNull: async () => null,
    };

    // With default 2-day threshold, this item is NOT stuck.
    const defaultResult = await getStuckItems(reader);
    assert.equal(defaultResult.blockedOver2d.length, 0);

    // With a 0-day threshold (everything counts), it IS stuck.
    const aggressiveResult = await getStuckItems({
      listRequiredStatusContextsOrNull: async () => null,
      ...reader,
      thresholds: { blockedDays: 0 },
    });
    assert.equal(aggressiveResult.blockedOver2d.length, 1);
  });
});

describe("getStuckItems — sub-source failure isolation", () => {
  test("PR reader rejecting → issue buckets still ship", async () => {
    const result = await getStuckItems({
      listRequiredStatusContextsOrNull: async () => null,
      now: NOW,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader({
        blocked: [
          issueRow({
            number: 1,
            title: "blocked",
            url: "u1",
            createdAt: "2026-05-20T00:00:00Z",
            labels: ["blocked"],
          }),
        ],
      }),
      // The seam's *OrEmpty readers degrade to [] internally; this models a
      // harder failure (the reader itself rejecting) to prove allSettled
      // isolation in the aggregator.
      listOpenPrsOrEmpty: async () => {
        throw new Error("gh pr broken");
      },
    });
    assert.equal(result.blockedOver2d.length, 1);
    assert.deepEqual(result.prsWithFailedCi, []);
  });
});

// ---------------------------------------------------------------------------
// Issue #5093: the issue half is the CLASSIFIED set from the one waiting read
// ---------------------------------------------------------------------------

describe("getStuckItems — issue half is the classified waiting read (#5093)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
  const base = {
    now: NOW,
    listOpenPrsOrEmpty: async () => [],
    listRequiredStatusContextsOrNull: async () => null,
  };

  test("an Epic-labelled blocked row is excluded from blockedOver2d", async () => {
    const result = await getStuckItems({
      ...base,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader({
        blocked: [
          issueRow({ number: 1, createdAt: ago(5), labels: ["blocked"], body: "## Sub-issues\n- #2\n" }),
          issueRow({ number: 3, createdAt: ago(5), labels: ["blocked"] }),
        ],
      }),
    });
    assert.deepEqual(result.blockedOver2d.map((i) => i.number), [3]);
  });

  test("a blocked row whose every open blocker is machine-owned is excluded", async () => {
    const result = await getStuckItems({
      ...base,
      listIssuesBySearch: (async () => ({
        ok: true,
        rows: [issueRow({ number: 100, labels: ["ready-for-agent"] })],
      })) as never,
      listIssuesByLabel: makeLabelReader({
        blocked: [
          issueRow({ number: 4, createdAt: ago(5), labels: ["blocked"], body: "blocked by #100" }),
        ],
      }),
    });
    assert.deepEqual(result.blockedOver2d, []);
  });

  test("a failed blocked/needs-info label read flips sourcesOk; unrelated labels do not", async () => {
    const rows = { "needs-info": [issueRow({ number: 2, createdAt: ago(3), labels: ["needs-info"] })] };
    const failed = await getStuckItems({
      ...base,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader(rows, ["blocked"]),
    });
    assert.equal(failed.sourcesOk, false);
    const unrelated = await getStuckItems({
      ...base,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader(rows, ["ready-for-human"]),
    });
    assert.equal(unrelated.sourcesOk, true);
  });

  test("scanned sums raw blocked + needs-info rows and the failed-CI PR rows (legacy three-source sum)", async () => {
    const result = await getStuckItems({
      ...base,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader({
        blocked: [issueRow({ number: 1, labels: ["blocked"] })],
        "needs-info": [issueRow({ number: 2, labels: ["needs-info"] })],
      }),
      listOpenPrsOrEmpty: async () => [
        prRow({ number: 9, statusCheckRollup: [{ conclusion: "FAILURE", name: "test" }] }),
        prRow({ number: 10, statusCheckRollup: [{ conclusion: "SUCCESS", name: "test" }] }),
      ],
    });
    assert.equal(result.scanned, 3);
    assert.equal(result.generatedAt, NOW.toISOString());
  });

  test("a rejected PR read degrades prsWithFailedCi to [] and flips sourcesOk", async () => {
    const result = await getStuckItems({
      ...base,
      listIssuesBySearch: noBlockers,
      listIssuesByLabel: makeLabelReader({}),
      listOpenPrsOrEmpty: async () => {
        throw new Error("gh pr broken");
      },
    });
    assert.deepEqual(result.prsWithFailedCi, []);
    assert.equal(result.sourcesOk, false);
  });

  test("stuck-items.ts imports no issue-label reader (one issue-label reader on the Today path)", () => {
    const src = readFileSync(new URL("../src/aggregators/stuck-items.ts", import.meta.url), "utf8");
    const imports = src.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];
    for (const imp of imports) {
      assert.ok(!/listIssuesByLabel(OrEmpty)?\b/.test(imp), imp);
    }
    assert.ok(!src.includes("classifyByAge"), "classifyByAge must be deleted");
  });
});
