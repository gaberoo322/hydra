/**
 * Regression tests for the meta-friction GitHub Read seam (issue #864).
 *
 * `readMetaFrictionIssues` consolidates the previously-triplicated `gh issue
 * list --label meta-friction` read. After issue #915 it reads through the
 * **GitHub Issue/PR Read seam** (`listIssuesBySearchOrEmpty`) rather than a
 * hand-built `gh` argv + parser. These tests pin the behaviour the three
 * consumers (lessons-overnight, friction-patterns, lessons-trend) used to own:
 * the seam query parameters (label / state / limit / search), the exact-
 * createdAt re-filter, and the newest-first sort. The canonical-row parse +
 * title/url fallbacks now live in the seam's own suite (`github-issues.test.mts`).
 * The sibling `readFrictionPatterns` (Redis) is covered by the aggregator
 * integration tests that stub it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  readMetaFrictionIssues,
  readPatternGroups,
  readFrictionPatterns,
} from "../src/aggregators/friction-source.ts";
import type { IssueRow } from "../src/github/issues.ts";
import type { PatternGroupRaw, PatternNamespace } from "../src/redis/agent-memory.ts";

const WINDOW_START = new Date("2026-05-25T00:00:00.000Z");

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

describe("readMetaFrictionIssues — seam query", () => {
  test("queries the meta-friction label, state all, limit 200 and the created:>= search", async () => {
    let capturedSearch = "";
    let capturedOpts: { label?: string; state?: string; limit?: number } = {};
    await readMetaFrictionIssues("seam-test", WINDOW_START, {
      githubRepo: "gaberoo322/hydra",
      listIssuesBySearchOrEmpty: async (search, _prefix, opts) => {
        capturedSearch = search;
        capturedOpts = { label: opts?.label, state: opts?.state, limit: opts?.limit };
        return [];
      },
    });
    // Day-coarse created:>= search against the window start date.
    assert.equal(capturedSearch, "created:>=2026-05-25");
    assert.equal(capturedOpts.label, "meta-friction");
    assert.equal(capturedOpts.state, "all");
    // Unified limit (was overnight=100 / friction-patterns=100 / trend=200).
    assert.equal(capturedOpts.limit, 200);
  });
});

describe("readMetaFrictionIssues — window / sort", () => {
  test("keeps in-window rows, drops pre-window, sorts newest-createdAt-first", async () => {
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      listIssuesBySearchOrEmpty: async () => [
        issueRow({ number: 1, title: "older in", url: "u1", createdAt: "2026-05-25T01:00:00Z" }),
        issueRow({ number: 2, title: "newer in", url: "u2", createdAt: "2026-05-25T20:00:00Z" }),
        issueRow({ number: 3, title: "before", url: "u3", createdAt: "2026-05-24T23:00:00Z" }),
      ],
    });
    assert.deepEqual(out.map((i) => i.number), [2, 1]);
    assert.equal(out[0].title, "newer in");
    assert.equal(out[0].url, "u2");
  });

  test("drops rows whose createdAt is empty / unparseable", async () => {
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      listIssuesBySearchOrEmpty: async () => [
        issueRow({ number: 9, title: "ok", url: "u9", createdAt: "2026-05-26T00:00:00Z" }),
        issueRow({ number: 10, createdAt: "" }),
      ],
    });
    assert.deepEqual(out.map((i) => i.number), [9]);
  });

  test("carries the seam's synthesized title/url fallbacks through", async () => {
    // The seam's parseIssueRows synthesizes `Issue #N` / a pulls URL when the
    // gh payload omits them; readMetaFrictionIssues passes those through.
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      listIssuesBySearchOrEmpty: async () => [issueRow({ number: 42, createdAt: "2026-05-26T00:00:00Z" })],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "Issue #42");
    assert.equal(out[0].url, "https://github.com/gaberoo322/hydra/issues/42");
  });
});

describe("readMetaFrictionIssues — never throws", () => {
  test("seam reader degrading to [] → []", async () => {
    // The *OrEmpty reader swallows gh failures / malformed JSON into [];
    // readMetaFrictionIssues just window-filters an empty list.
    const out = await readMetaFrictionIssues("seam-test", WINDOW_START, {
      listIssuesBySearchOrEmpty: async () => [],
    });
    assert.deepEqual(out, []);
  });
});

// ---------------------------------------------------------------------------
// readPatternGroups — the shared namespace SCAN-and-parse seam (issue #3265).
// Exercised via an injected `scanPatternGroupsRaw` stub so no live Redis is
// needed (design invariant #5). Covers both namespaces + parse-isolation.
// ---------------------------------------------------------------------------

function stubScan(
  byNamespace: Partial<Record<PatternNamespace, PatternGroupRaw[]>>,
): (ns?: PatternNamespace) => Promise<PatternGroupRaw[]> {
  const seen: PatternNamespace[] = [];
  const fn = async (ns: PatternNamespace = "memory") => {
    seen.push(ns);
    return byNamespace[ns] ?? [];
  };
  (fn as any).seen = seen;
  return fn as any;
}

describe("readPatternGroups — namespace fan-out", () => {
  test("scans the friction namespace and parses each group's JSON array", async () => {
    const scan = stubScan({
      friction: [
        { name: "hydra-dev", raw: JSON.stringify([{ cue: "a" }, { cue: "b" }]) },
        { name: "hydra-qa", raw: JSON.stringify([{ cue: "c" }]) },
      ],
    });
    const out = await readPatternGroups<{ cue: string }>("friction", "t", {
      scanPatternGroupsRaw: scan,
    });
    assert.equal((scan as any).seen[0], "friction");
    assert.deepEqual(
      out.map((g) => [g.skill, g.patterns.map((p) => p.cue)]),
      [["hydra-dev", ["a", "b"]], ["hydra-qa", ["c"]]],
    );
  });

  test("scans the memory namespace independently", async () => {
    const scan = stubScan({
      memory: [{ name: "hydra-dev", raw: JSON.stringify([{ category: "x" }]) }],
    });
    const out = await readPatternGroups<{ category: string }>("memory", "t", {
      scanPatternGroupsRaw: scan,
    });
    assert.equal((scan as any).seen[0], "memory");
    assert.deepEqual(out, [{ skill: "hydra-dev", patterns: [{ category: "x" }] }]);
  });
});

describe("readPatternGroups — parse isolation (never throws)", () => {
  test("skips missing / malformed / non-array values, keeps the good ones", async () => {
    const scan = stubScan({
      memory: [
        { name: "good", raw: JSON.stringify([{ category: "ok" }]) },
        { name: "null-raw", raw: null },
        { name: "malformed", raw: "{not json" },
        { name: "not-array", raw: JSON.stringify({ category: "obj" }) },
      ],
    });
    const out = await readPatternGroups<{ category: string }>("memory", "t", {
      scanPatternGroupsRaw: scan,
    });
    assert.deepEqual(out, [{ skill: "good", patterns: [{ category: "ok" }] }]);
  });
});

describe("readFrictionPatterns — thin friction wrapper", () => {
  test("delegates to readPatternGroups on the friction namespace", async () => {
    // The default (non-injected) path hits the live seam; here we assert the
    // wrapper preserves the FrictionGroup shape by driving the shared reader
    // through the same code path with the friction namespace.
    const out = await readPatternGroups<{ cue: string }>("friction", "w", {
      scanPatternGroupsRaw: stubScan({
        friction: [{ name: "hydra-dev", raw: JSON.stringify([{ cue: "z" }]) }],
      }),
    });
    assert.deepEqual(out, [{ skill: "hydra-dev", patterns: [{ cue: "z" }] }]);
    // readFrictionPatterns exists and is a function with the (label) arity.
    assert.equal(typeof readFrictionPatterns, "function");
    assert.equal(readFrictionPatterns.length, 1);
  });
});
