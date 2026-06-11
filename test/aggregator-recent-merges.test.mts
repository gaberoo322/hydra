/**
 * Regression tests for the recent-merges aggregator (issue #617, PRD #615).
 *
 * Pure helpers (`extractPrNumbersFromGitLog`, `tierFromLabels`,
 * `clampLimit`, `prMetaFromView`) are tested directly. Provenance
 * classification (#1672) is the taxonomy Module's `provenanceFromLabels`,
 * pinned in `taxonomy-classes.test.mts`; here the integration suite pins
 * that `classLabel` carries the live provenance vocabulary. Integration
 * tests use exec stubs + a `fetchPrMeta` override.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getRecentMerges,
  extractPrNumbersFromGitLog,
  tierFromLabels,
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
    assert.equal(tierFromLabels(["cleanup-scan", "needs-qa"]), null);
  });

  test("parses tier:N", () => {
    assert.equal(tierFromLabels(["tier:2"]), 2);
    assert.equal(tierFromLabels(["TIER:0"]), 0);
  });

  test("ignores tier-without-number labels", () => {
    assert.equal(tierFromLabels(["tier:unknown"]), null);
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
  test("git log + per-PR meta → enriched MergeItem[] with provenance classLabel (#1672)", async () => {
    const gitLogStdout = ["feat: a (#100)", "fix: b (#101)", "fix: c (#102)"].join("\n");
    const exec = makeExecStub({
      "git fetch origin master": { stdout: "" },
      "git log origin/master": { stdout: gitLogStdout },
    });
    const meta = new Map([
      [100, { title: "feat: a", labels: ["tier:2", "cleanup-scan"], mergedAt: "2026-05-26T03:00:00Z", url: "u100" }],
      // dev_orch is NOT a provenance label — the dead class alphabet must not classify.
      [101, { title: "fix: b", labels: ["tier:1", "dev_orch"], mergedAt: "2026-05-26T02:00:00Z", url: "u101" }],
      // sentry is the residual provenance label with no owning dispatch class.
      [102, { title: "fix: c", labels: ["sentry"], mergedAt: "2026-05-26T01:00:00Z", url: "u102" }],
    ]);
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async (n) => meta.get(n) ?? null,
    });
    assert.equal(result.length, 3);
    assert.equal(result[0].prNumber, 100);
    assert.equal(result[0].tier, 2);
    assert.equal(result[0].classLabel, "cleanup-scan");
    assert.equal(result[1].prNumber, 101);
    assert.equal(result[1].tier, 1);
    assert.equal(result[1].classLabel, null);
    assert.equal(result[2].prNumber, 102);
    assert.equal(result[2].classLabel, "sentry");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("getRecentMerges — empty state", () => {
  test("git log returns nothing → []", async () => {
    const exec = makeExecStub({
      "git fetch origin master": { stdout: "" },
      "git log origin/master": { stdout: "" },
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
// Ref freshness (issue #1757): read origin/master, not the deploy-lagged
// local master; fetch is bounded + fail-open; local master is the fallback.
// ---------------------------------------------------------------------------

describe("getRecentMerges — origin/master ref freshness (#1757)", () => {
  test("reads origin/master, not local master, when both exist", async () => {
    // Stale local master knows only #100; origin/master has the merge wave.
    const exec = makeExecStub({
      "git fetch origin master": { stdout: "" },
      "git log origin/master": { stdout: ["fix: wave (#200)", "feat: a (#100)"].join("\n") },
      "git log master": { stdout: "feat: a (#100)" },
    });
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async () => null,
    });
    assert.deepEqual(result.map((m) => m.prNumber), [200, 100]);
  });

  test("fetch failure is fail-open → still reads cached origin/master", async () => {
    const exec = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("fetch")) throw new Error("network down");
      if (key.includes("git log origin/master")) return { stdout: "fix: cached (#300)", stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async () => null,
    });
    assert.deepEqual(result.map((m) => m.prNumber), [300]);
  });

  test("missing origin/master ref → falls back to local master", async () => {
    const exec = async (cmd: string, args: readonly string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("fetch")) throw new Error("no remote");
      if (key.includes("origin/master")) {
        throw new Error("fatal: ambiguous argument 'origin/master'");
      }
      if (key.includes("git log master")) return { stdout: "feat: local (#400)", stderr: "" };
      throw new Error(`unexpected: ${key}`);
    };
    const result = await getRecentMerges(10, {
      execFileAsync: exec,
      fetchPrMeta: async () => null,
    });
    assert.deepEqual(result.map((m) => m.prNumber), [400]);
  });
});

// ---------------------------------------------------------------------------
// Boundary: per-PR meta failure → tier/classLabel null, item still listed
// ---------------------------------------------------------------------------

describe("getRecentMerges — per-PR meta failure isolation", () => {
  test("missing meta → MergeItem with nulls but PR number preserved", async () => {
    const gitLogStdout = ["feat: x (#999)"].join("\n");
    const exec = makeExecStub({
      "git fetch origin master": { stdout: "" },
      "git log origin/master": { stdout: gitLogStdout },
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
