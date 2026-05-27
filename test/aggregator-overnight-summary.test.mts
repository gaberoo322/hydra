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
 * Follows the test/api-anchor-candidates.test.mts pattern: pure helpers
 * tested directly, integration shape tested with stubs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getOvernightSummary,
  countNonEmptyLines,
  countIssuesInWindow,
  projectHeadroom,
} from "../src/aggregators/overnight-summary.ts";

// Stable wall-clock anchor used across the suite: 2026-05-26 12:00:00 UTC.
// A fixed instant lets the window-boundary tests assert exact `since` values.
const NOW = new Date("2026-05-26T12:00:00.000Z");

function makeExecStub(routes: Record<string, { stdout: string; stderr?: string }>) {
  return async (cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const prefix of Object.keys(routes)) {
      if (key.startsWith(prefix)) return { stdout: routes[prefix].stdout, stderr: routes[prefix].stderr ?? "" };
    }
    throw new Error(`exec-stub: no route for "${key}"`);
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
  test("returns 0 on non-JSON stdout", () => {
    assert.equal(countIssuesInWindow("not json", new Date()), 0);
  });

  test("returns 0 on empty array", () => {
    assert.equal(countIssuesInWindow("[]", new Date()), 0);
  });

  test("counts only items whose createdAt is >= windowStart", () => {
    const items = [
      { number: 1, createdAt: "2026-05-26T08:00:00.000Z" }, // inside (window starts 00:00)
      { number: 2, createdAt: "2026-05-25T12:00:00.000Z" }, // outside
      { number: 3, createdAt: "2026-05-26T11:59:00.000Z" }, // inside
    ];
    const windowStart = new Date("2026-05-26T00:00:00.000Z");
    assert.equal(countIssuesInWindow(JSON.stringify(items), windowStart), 2);
  });

  test("treats items missing createdAt as outside", () => {
    const items = [{ number: 1 }, { number: 2, createdAt: 42 }];
    assert.equal(countIssuesInWindow(JSON.stringify(items), new Date(0)), 0);
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
    const exec = makeExecStub({
      "git log master": { stdout: "hash1\nhash2\nhash3\n" },
      "gh issue list": {
        stdout: JSON.stringify([
          { number: 100, createdAt: "2026-05-26T06:00:00.000Z" },
          { number: 101, createdAt: "2026-05-26T07:30:00.000Z" },
        ]),
      },
    });

    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: exec,
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
    const exec = makeExecStub({
      "git log master": { stdout: "" },
      "gh issue list": { stdout: "[]" },
    });

    let observedEpoch: number | undefined;
    await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: exec,
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
    const exec = makeExecStub({
      "git log master": { stdout: "" },
      "gh issue list": { stdout: "[]" },
    });

    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: exec,
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
    const exec = makeExecStub({
      "git log master": { stdout: "" },
      "gh issue list": {
        stdout: JSON.stringify([
          { number: 1, createdAt: "2026-05-26T00:00:01.000Z" }, // 1s INSIDE
          { number: 2, createdAt: "2026-05-25T23:59:59.000Z" }, // 1s OUTSIDE
          { number: 3, createdAt: "2026-05-26T11:59:59.000Z" }, // 1s before NOW: INSIDE
        ]),
      },
    });

    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: exec,
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
    const exec = async (cmd: string, args: readonly string[]) => {
      if (cmd === "git") throw new Error("git not found");
      if (cmd === "gh") {
        return {
          stdout: JSON.stringify([{ number: 1, createdAt: "2026-05-26T11:00:00.000Z" }]),
          stderr: "",
        };
      }
      throw new Error(`unstubbed: ${cmd}`);
    };

    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: exec,
      countAutopilotRunsSince: async () => 4,
      readCostUsd: async () => 7.50,
      readUsageHeadroom: async () => ({
        pacingState: "under",
        emergencyStop: false,
        calibrated: true,
        projectedWeeklyPercent: 20,
      }),
    });

    assert.equal(summary.mergeCount, 0); // degraded
    assert.equal(summary.runCount, 4);
    assert.equal(summary.costSpent, 7.50);
    assert.equal(summary.issuesOpened, 1);
    assert.equal(summary.headroom, "green");
  });

  test("aggregator never throws even when every sub-source rejects", async () => {
    const summary = await getOvernightSummary(12, {
      now: NOW,
      execFileAsync: async () => {
        throw new Error("all subprocesses dead");
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
