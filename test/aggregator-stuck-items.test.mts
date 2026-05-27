/**
 * Regression tests for the stuck-items aggregator (issue #617, PRD #615).
 *
 * Pure helpers (`classifyByAge`, `parseRawIssues`, `parsePrsWithFailedCi`)
 * are tested directly. Integration shape is tested with an exec stub.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getStuckItems,
  classifyByAge,
  parseRawIssues,
  parsePrsWithFailedCi,
  DEFAULT_THRESHOLDS,
} from "../src/aggregators/stuck-items.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function makeExecStub(routes: Record<string, { stdout: string; stderr?: string }>) {
  return async (cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const prefix of Object.keys(routes)) {
      if (key.includes(prefix)) {
        return { stdout: routes[prefix].stdout, stderr: routes[prefix].stderr ?? "" };
      }
    }
    throw new Error(`exec-stub: no route for "${key}"`);
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classifyByAge — pure helper", () => {
  test("keeps issues older than the threshold; drops younger", () => {
    const issues = [
      { number: 1, title: "old", url: "u1", createdAt: "2026-05-20T00:00:00Z", labels: [] }, // 6d
      { number: 2, title: "young", url: "u2", createdAt: "2026-05-26T11:00:00Z", labels: [] }, // 1h
    ];
    const out = classifyByAge(issues, NOW, 2);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 1);
    assert.equal(out[0].ageDays, 6);
  });

  test("boundary: exactly at threshold counts as stuck", () => {
    // 2-day age from NOW = 2026-05-24T12:00 UTC.
    const issues = [
      { number: 1, title: "edge", url: "u1", createdAt: "2026-05-24T12:00:00Z", labels: [] },
    ];
    const out = classifyByAge(issues, NOW, 2);
    assert.equal(out.length, 1);
    assert.equal(out[0].ageDays, 2);
  });

  test("sorts oldest-first", () => {
    const issues = [
      { number: 2, title: "less old", url: "u2", createdAt: "2026-05-23T00:00:00Z", labels: [] },
      { number: 1, title: "oldest", url: "u1", createdAt: "2026-05-20T00:00:00Z", labels: [] },
    ];
    const out = classifyByAge(issues, NOW, 1);
    assert.deepEqual(out.map((i) => i.number), [1, 2]);
  });

  test("skips issues with unparseable createdAt", () => {
    const issues = [
      { number: 1, title: "junk", url: "u1", createdAt: "not-a-date", labels: [] },
    ];
    const out = classifyByAge(issues, NOW, 1);
    assert.deepEqual(out, []);
  });
});

describe("parseRawIssues — pure helper", () => {
  test("returns [] on empty / non-array", () => {
    assert.deepEqual(parseRawIssues(""), []);
    assert.deepEqual(parseRawIssues("{}"), []);
  });

  test("parses labels into a flat string[]", () => {
    const stdout = JSON.stringify([
      {
        number: 10,
        title: "x",
        url: "u",
        createdAt: "2026-05-25T00:00:00Z",
        labels: [{ name: "blocked" }, { name: "needs-info" }],
      },
    ]);
    const out = parseRawIssues(stdout);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].labels, ["blocked", "needs-info"]);
  });
});

describe("parsePrsWithFailedCi — pure helper", () => {
  test("returns [] on empty / non-array", () => {
    assert.deepEqual(parsePrsWithFailedCi(""), []);
    assert.deepEqual(parsePrsWithFailedCi("{}"), []);
  });

  test("keeps PRs with at least one FAILURE check; reports the failing names", () => {
    const stdout = JSON.stringify([
      {
        number: 1,
        title: "good",
        url: "u1",
        updatedAt: "2026-05-26T00:00:00Z",
        statusCheckRollup: [{ conclusion: "SUCCESS", name: "test" }],
      },
      {
        number: 2,
        title: "broken",
        url: "u2",
        updatedAt: "2026-05-26T01:00:00Z",
        statusCheckRollup: [
          { conclusion: "SUCCESS", name: "typecheck" },
          { conclusion: "FAILURE", name: "test" },
          { conclusion: "TIMED_OUT", name: "build" },
        ],
      },
    ]);
    const out = parsePrsWithFailedCi(stdout);
    assert.equal(out.length, 1);
    assert.equal(out[0].number, 2);
    assert.deepEqual(out[0].failedChecks, ["test", "build"]);
  });

  test("PENDING/SUCCESS-only rollups are filtered out", () => {
    const stdout = JSON.stringify([
      {
        number: 3,
        title: "still running",
        url: "u3",
        updatedAt: "2026-05-26T02:00:00Z",
        statusCheckRollup: [{ conclusion: "PENDING", name: "ci" }],
      },
    ]);
    assert.deepEqual(parsePrsWithFailedCi(stdout), []);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getStuckItems — happy path", () => {
  test("returns three buckets + thresholds + generatedAt", async () => {
    const blockedStdout = JSON.stringify([
      {
        number: 1,
        title: "blocked old",
        url: "u1",
        createdAt: "2026-05-22T00:00:00Z", // 4.5d old → stuck (≥2d)
        labels: [{ name: "blocked" }],
      },
    ]);
    const infoStdout = JSON.stringify([
      {
        number: 2,
        title: "needs-info waiting",
        url: "u2",
        createdAt: "2026-05-24T00:00:00Z", // 2.5d old → stuck (≥1d)
        labels: [{ name: "needs-info" }],
      },
    ]);
    const prsStdout = JSON.stringify([
      {
        number: 555,
        title: "ci broken",
        url: "p555",
        updatedAt: "2026-05-26T00:00:00Z",
        statusCheckRollup: [{ conclusion: "FAILURE", name: "test" }],
      },
    ]);
    const exec = makeExecStub({
      "issue list --repo gaberoo322/hydra --state open --label blocked": { stdout: blockedStdout },
      "issue list --repo gaberoo322/hydra --state open --label needs-info": { stdout: infoStdout },
      "pr list --repo gaberoo322/hydra --state open": { stdout: prsStdout },
    });

    const result = await getStuckItems({ now: NOW, execFileAsync: exec });
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
    const exec = makeExecStub({
      "issue list": { stdout: JSON.stringify([]) },
      "pr list": { stdout: JSON.stringify([]) },
    });
    const result = await getStuckItems({ now: NOW, execFileAsync: exec });
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
    const blockedStdout = JSON.stringify([
      {
        number: 1,
        title: "young blocked",
        url: "u1",
        createdAt: "2026-05-26T00:00:00Z", // 12h old
        labels: [{ name: "blocked" }],
      },
    ]);
    const exec = makeExecStub({
      "issue list --repo gaberoo322/hydra --state open --label blocked": { stdout: blockedStdout },
      "issue list --repo gaberoo322/hydra --state open --label needs-info": { stdout: JSON.stringify([]) },
      "pr list": { stdout: JSON.stringify([]) },
    });

    // With default 2-day threshold, this item is NOT stuck.
    const defaultResult = await getStuckItems({ now: NOW, execFileAsync: exec });
    assert.equal(defaultResult.blockedOver2d.length, 0);

    // With a 0-day threshold (everything counts), it IS stuck.
    const aggressiveResult = await getStuckItems({
      now: NOW,
      execFileAsync: exec,
      thresholds: { blockedDays: 0 },
    });
    assert.equal(aggressiveResult.blockedOver2d.length, 1);
  });
});

describe("getStuckItems — sub-source failure isolation", () => {
  test("PR fetch fails → issue buckets still ship", async () => {
    const blockedStdout = JSON.stringify([
      {
        number: 1,
        title: "blocked",
        url: "u1",
        createdAt: "2026-05-20T00:00:00Z",
        labels: [{ name: "blocked" }],
      },
    ]);
    const exec = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("issue list") && key.includes("--label blocked")) {
        return { stdout: blockedStdout, stderr: "" };
      }
      if (key.includes("issue list") && key.includes("--label needs-info")) {
        return { stdout: JSON.stringify([]), stderr: "" };
      }
      if (key.includes("pr list")) throw new Error("gh pr broken");
      throw new Error("unstubbed: " + key);
    };
    const result = await getStuckItems({ now: NOW, execFileAsync: exec });
    assert.equal(result.blockedOver2d.length, 1);
    assert.deepEqual(result.prsWithFailedCi, []);
  });
});
