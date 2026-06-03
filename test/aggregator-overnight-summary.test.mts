/**
 * Regression tests for the overnight-summary aggregator (issue #616).
 *
 * Tests the pure aggregator with full dependency injection — no Redis,
 * no subprocesses, no clock-skew flakiness. The aggregator's contract is:
 *
 *   - never throws (each sub-source degrades to a sentinel)
 *   - five inputs → one typed shape
 *   - clock + exec + redis + cost + usage are all injectable
 *
 * After issue #915 the issues-opened GitHub read goes through the **GitHub
 * Issue/PR Read seam** (`listIssuesBySearchOrEmpty`); tests stub that reader
 * with the canonical `IssueRow` shape. The `git log` merge count still uses the
 * `execFileAsync` injection (it is a `git` read, not a GitHub-issue read).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getOvernightSummary,
  countNonEmptyLines,
  countIssuesInWindow,
  projectHeadroom,
} from "../src/aggregators/overnight-summary.ts";
import type { IssueRow } from "../src/github/issues.ts";

// Stable wall-clock anchor used across the suite: 2026-05-26 12:00:00 UTC.
// A fixed instant lets the window-boundary tests assert exact `since` values.
const NOW = new Date("2026-05-26T12:00:00.000Z");

function issueRow(number: number, createdAt: string): IssueRow {
  return {
    number,
    title: `Issue #${number}`,
    url: `https://github.com/gaberoo322/hydra/issues/${number}`,
    createdAt,
    labels: [],
    body: "",
    state: "OPEN",
  };
}

function gitOnlyExec(gitStdout: string) {
  return async (cmd: string) => {
    if (cmd === "git") return { stdout: gitStdout, stderr: "" };
    throw new Error(`unstubbed exec: ${cmd}`);
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("countNonEmptyLines — pure helper", () => {
  test("returns 0 for empty / whitespace input", () => {
    assert.equal(countNonEmptyLines(""), 0);
    assert.equal(countNonEmptyLines("\n\n  \n"), 0);
  });

  test("counts one hash per line, ignores trailing newline", () => {
    const stdout = "abc123\ndef456\nfeed00\n";
    assert.equal(countNonEmptyLines(stdout), 3);
  });

  test("ignores leading/trailing blank lines", () => {
    assert.equal(countNonEmptyLines("\nabc\ndef\n\n"), 2);
  });
});

describe("countIssuesInWindow — pure helper", () => {
  test("returns 0 on empty rows", () => {
    assert.equal(countIssuesInWindow([], new Date()), 0);
  });

  test("counts only rows whose createdAt is >= windowStart", () => {
    const rows = [
      issueRow(1, "2026-05-26T08:00:00.000Z"), // inside (window starts 00:00)
      issueRow(2, "2026-05-25T12:00:00.000Z"), // outside
      issueRow(3, "2026-05-26T11:59:00.000Z"), // inside
    ];
    const windowStart = new Date("2026-05-26T00:00:00.000Z");
    assert.equal(countIssuesInWindow(rows, windowStart), 2);
  });

  test("treats rows with unparseable createdAt as outside", () => {
    const rows = [issueRow(1, ""), issueRow(2, "not-a-date")];
    assert.equal(countIssuesInWindow(rows, new Date(0)), 0);
  });
});

describe("projectHeadroom — pure helper", () => {
  test("uncalibrated → 'unknown' regardless of pacing", () => {
    assert.equal(
      projectHeadroom({ pacingState: "over", emergencyStop: true, calibrated: false, projectedWeeklyPercent: 0 }),
      "unknown",
    );
  });

  test("calibrated + pacing 'under' → 'green'", () => {
    assert.equal(
      projectHeadroom({ pacingState: "under", emergencyStop: false, calibrated: true, projectedWeeklyPercent: 40 }),
      "green",
    );
  });

  test("calibrated + pacing 'on' → 'yellow'", () => {
    assert.equal(
      projectHeadroom({ pacingState: "on", emergencyStop: false, calibrated: true, projectedWeeklyPercent: 92 }),
      "yellow",
    );
  });

  test("calibrated + pacing 'over' → 'red'", () => {
    assert.equal(
      projectHeadroom({ pacingState: "over", emergencyStop: false, calibrated: true, projectedWeeklyPercent: 120 }),
      "red",
    );
  });

  test("calibrated + emergencyStop → 'red' even when pacing 'under'", () => {
    // Defensive: emergencyStop is the autopilot-side kill switch — it must
    // dominate the pacing verdict so the operator sees red when shed is on.
    assert.equal(
      projectHeadroom({ pacingState: "under", emergencyStop: true, calibrated: true, projectedWeeklyPercent: 10 }),
      "red",
    );
  });
});

// ---------------------------------------------------------------------------
// Aggregator — happy path with all sub-sources stubbed
// ---------------------------------------------------------------------------

describe("getOvernightSummary — happy path", () => {
  test("returns the typed shape with all five fields populated", async () => {
    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: gitOnlyExec("hash1\nhash2\nhash3\n"),
      listIssuesBySearchOrEmpty: async () => [
        issueRow(100, "2026-05-26T06:00:00.000Z"),
        issueRow(101, "2026-05-26T07:30:00.000Z"),
      ],
      countAutopilotRunsSince: async () => 5,
      readCostUsd: async () => 12.34,
      readUsageHeadroom: async () => ({
        pacingState: "under",
        emergencyStop: false,
        calibrated: true,
        projectedWeeklyPercent: 30,
      }),
    });

    assert.equal(summary.mergeCount, 3);
    assert.equal(summary.runCount, 5);
    assert.equal(summary.costSpent, 12.34);
    assert.equal(summary.issuesOpened, 2);
    assert.equal(summary.headroom, "green");
    assert.equal(summary.windowHours, 12);
    assert.equal(summary.generatedAt, NOW.toISOString());
  });

  test("passes the correct window-start to autopilot-runs reader", async () => {
    let observedEpoch: number | undefined;
    await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: gitOnlyExec(""),
      listIssuesBySearchOrEmpty: async () => [],
      countAutopilotRunsSince: async (epoch) => {
        observedEpoch = epoch;
        return 0;
      },
      readCostUsd: async () => 0,
      readUsageHeadroom: async () => ({
        pacingState: "under",
        emergencyStop: false,
        calibrated: true,
        projectedWeeklyPercent: 0,
      }),
    });

    // NOW = 2026-05-26T12:00 UTC. 12h window → start = 2026-05-26T00:00 UTC.
    const expectedEpoch = Math.floor(new Date("2026-05-26T00:00:00.000Z").getTime() / 1000);
    assert.equal(observedEpoch, expectedEpoch);
  });
});

// ---------------------------------------------------------------------------
// Aggregator — empty state
// ---------------------------------------------------------------------------

describe("getOvernightSummary — empty state", () => {
  test("no merges, no runs, no issues, no cost → zeros + unknown headroom + no crash", async () => {
    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: gitOnlyExec(""),
      listIssuesBySearchOrEmpty: async () => [],
      countAutopilotRunsSince: async () => 0,
      readCostUsd: async () => 0,
      readUsageHeadroom: async () => ({
        pacingState: "under",
        emergencyStop: false,
        calibrated: false,
        projectedWeeklyPercent: 0,
      }),
    });

    assert.equal(summary.mergeCount, 0);
    assert.equal(summary.runCount, 0);
    assert.equal(summary.costSpent, 0);
    assert.equal(summary.issuesOpened, 0);
    assert.equal(summary.headroom, "unknown");
    assert.equal(summary.windowHours, 12);
  });
});

// ---------------------------------------------------------------------------
// Aggregator — window boundary
// ---------------------------------------------------------------------------

describe("getOvernightSummary — window boundary", () => {
  test("issues just inside the window count, items just outside do not", async () => {
    // 12h window from NOW → windowStart = 2026-05-26T00:00 UTC.
    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: gitOnlyExec(""),
      listIssuesBySearchOrEmpty: async () => [
        issueRow(1, "2026-05-26T00:00:01.000Z"), // 1s INSIDE
        issueRow(2, "2026-05-25T23:59:59.000Z"), // 1s OUTSIDE
        issueRow(3, "2026-05-26T11:59:59.000Z"), // 1s before NOW: INSIDE
      ],
      countAutopilotRunsSince: async () => 0,
      readCostUsd: async () => 0,
      readUsageHeadroom: async () => ({
        pacingState: "under",
        emergencyStop: false,
        calibrated: true,
        projectedWeeklyPercent: 0,
      }),
    });

    assert.equal(summary.issuesOpened, 2);
  });
});

// ---------------------------------------------------------------------------
// Aggregator — sub-source failure isolation
// ---------------------------------------------------------------------------

describe("getOvernightSummary — sub-source failure isolation", () => {
  test("git log throwing degrades mergeCount to 0; other fields still ship", async () => {
    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: async (cmd: string) => {
        if (cmd === "git") throw new Error("git not found");
        throw new Error(`unstubbed: ${cmd}`);
      },
      listIssuesBySearchOrEmpty: async () => [issueRow(1, "2026-05-26T11:00:00.000Z")],
      countAutopilotRunsSince: async () => 4,
      readCostUsd: async () => 7.5,
      readUsageHeadroom: async () => ({
        pacingState: "under",
        emergencyStop: false,
        calibrated: true,
        projectedWeeklyPercent: 20,
      }),
    });

    assert.equal(summary.mergeCount, 0); // degraded
    assert.equal(summary.runCount, 4);
    assert.equal(summary.costSpent, 7.5);
    assert.equal(summary.issuesOpened, 1);
    assert.equal(summary.headroom, "green");
  });

  test("aggregator never throws even when every sub-source rejects", async () => {
    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: async () => {
        throw new Error("all subprocesses dead");
      },
      listIssuesBySearchOrEmpty: async () => {
        throw new Error("gh dead");
      },
      countAutopilotRunsSince: async () => {
        throw new Error("redis down");
      },
      readCostUsd: async () => {
        throw new Error("surrogate offline");
      },
      readUsageHeadroom: async () => {
        throw new Error("usage tracker offline");
      },
    });

    // Contract: the route can render the banner with zeros + "unknown" even
    // in a total brown-out. No promise rejection escapes the aggregator.
    assert.equal(summary.mergeCount, 0);
    assert.equal(summary.runCount, 0);
    assert.equal(summary.costSpent, 0);
    assert.equal(summary.issuesOpened, 0);
    assert.equal(summary.headroom, "unknown");
    assert.equal(summary.windowHours, 12);
    assert.equal(typeof summary.generatedAt, "string");
  });
});
