/**
 * Regression tests for the recent-merges aggregator (issue #617, PRD #615).
 *
 * Pure helpers (`extractPrNumbersFromGitLog`, `tierFromLabels`,
 * `classLabelFromLabels`, `clampLimit`, `parsePrMeta`) are tested
 * directly. Integration tests use exec stubs + a `fetchPrMeta` override.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getRecentMerges,
  extractPrNumbersFromGitLog,
  tierFromLabels,
  classLabelFromLabels,
  clampLimit,
  prMetaFromView,
} from "../src/aggregators/recent-merges.ts";

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

describe("clampLimit — pure helper", () => {
  test("clamps to [1, 50]", () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-3), 1);
    assert.equal(clampLimit(100), 50);
    assert.equal(clampLimit(50), 50);
  });

  test("falls back to 10 on non-finite input", () => {
    // NaN and ±Infinity both fail Number.isFinite — both fall back to 10.
    assert.equal(clampLimit(NaN), 10);
    assert.equal(clampLimit(Infinity), 10);
  });

  test("floors a fractional limit", () => {
    assert.equal(clampLimit(12.7), 12);
  });
});

describe("extractPrNumbersFromGitLog — pure helper", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(extractPrNumbersFromGitLog("", 10), []);
  });

  test("pulls (#NNN) suffixes from squash-merge subjects", () => {
    const stdout = [
      "feat(scheduler): add knob (#622)",
      "refactor(cost): consolidate (#611)",
      "operator: stuff with no PR",
      "Merge pull request #599 from x/y",
    ].join("\n");
    assert.deepEqual(extractPrNumbersFromGitLog(stdout, 10), [622, 611, 599]);
  });

  test("dedupes repeated numbers (e.g. revert of a revert)", () => {
    const stdout = ["feat: x (#10)", "Revert (#10)", "feat: y (#11)"].join("\n");
    assert.deepEqual(extractPrNumbersFromGitLog(stdout, 10), [10, 11]);
  });

  test("respects the limit", () => {
    const stdout = ["(#1)", "(#2)", "(#3)", "(#4)"].join("\n");
    assert.deepEqual(extractPrNumbersFromGitLog(stdout, 2), [1, 2]);
  });
});

describe("tierFromLabels — pure helper", () => {
  test("returns null when no tier label exists", () => {
    assert.equal(tierFromLabels(["dev_orch", "needs-qa"]), null);
  });

  test("parses tier:N", () => {
    assert.equal(tierFromLabels(["tier:2"]), 2);
    assert.equal(tierFromLabels(["TIER:0"]), 0);
  });

  test("ignores tier-without-number labels", () => {
    assert.equal(tierFromLabels(["tier:unknown"]), null);
  });
});

describe("classLabelFromLabels — pure helper", () => {
  test("finds a known autopilot class label", () => {
    assert.equal(classLabelFromLabels(["dev_orch", "tier:2"]), "dev_orch");
    assert.equal(classLabelFromLabels(["sweep_target"]), "sweep_target");
  });

  test("returns null when none of the labels match a known class", () => {
    assert.equal(classLabelFromLabels(["ready-for-agent", "tier:0"]), null);
  });
});

describe("prMetaFromView — pure helper", () => {
  test("maps a typical viewPr object", () => {
    const meta = prMetaFromView({
      title: "feat: thing",
      labels: [{ name: "tier:1" }, { name: "dev_orch" }],
      mergedAt: "2026-05-26T00:00:00Z",
      url: "https://example/pr/1",
    });
    assert.equal(meta.title, "feat: thing");
    assert.deepEqual(meta.labels, ["tier:1", "dev_orch"]);
  });

  test("defaults missing string fields to '' and flattens absent labels to []", () => {
    const meta = prMetaFromView({});
    assert.equal(meta.title, "");
    assert.equal(meta.url, "");
    assert.equal(meta.mergedAt, "");
    assert.deepEqual(meta.labels, []);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getRecentMerges — happy path", () => {
  test("git log + per-PR meta → enriched MergeItem[]", async () => {
    const gitLogStdout = ["feat: a (#100)", "fix: b (#101)"].join("\n");
    const exec = makeExecStub({
      "git log master": { stdout: gitLogStdout },
    });
    const meta = new Map([
      [100, { title: "feat: a", labels: ["tier:2", "dev_orch"], mergedAt: "2026-05-26T02:00:00Z", url: "u100" }],
      [101, { title: "fix: b", labels: ["tier:1"], mergedAt: "2026-05-26T01:00:00Z", url: "u101" }],
    ]);
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async (n) => meta.get(n) ?? null,
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].prNumber, 100);
    assert.equal(result[0].tier, 2);
    assert.equal(result[0].classLabel, "dev_orch");
    assert.equal(result[1].prNumber, 101);
    assert.equal(result[1].tier, 1);
    assert.equal(result[1].classLabel, null);
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getRecentMerges — empty state", () => {
  test("git log returns nothing → []", async () => {
    const exec = makeExecStub({
      "git log master": { stdout: "" },
    });
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async () => {
        throw new Error("should not be called");
      },
    });
    assert.deepEqual(result, []);
  });

  test("git log throws → [] (degrades, doesn't reject)", async () => {
    const exec = async () => {
      throw new Error("git not found");
    };
    const result = await getRecentMerges(10, { execFileAsync: exec });
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// Boundary: per-PR meta failure → tier/classLabel null, item still listed
// ---------------------------------------------------------------------------

describe("getRecentMerges — per-PR meta failure isolation", () => {
  test("missing meta → MergeItem with nulls but PR number preserved", async () => {
    const gitLogStdout = ["feat: x (#999)"].join("\n");
    const exec = makeExecStub({
      "git log master": { stdout: gitLogStdout },
    });
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async () => null,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].prNumber, 999);
    assert.equal(result[0].tier, null);
    assert.equal(result[0].classLabel, null);
  });
});
