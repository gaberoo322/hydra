/**
 * Regression tests for the reflections-domain coordinator (issue #2232).
 *
 * `loadReflectionsForAnchor` owns the two-axis composition that
 * `src/api/reflections.ts` (and, historically, `getContext()`) used to
 * re-derive inline: extract file keys from the anchor, read the per-anchor +
 * by-file axes in parallel, and merge them into one combined `ReflectionBlock`
 * while surfacing the per-axis blocks for attribution.
 *
 * The composition logic is exercised through the injectable `deps` bag, so the
 * core tests need NO Redis connection — they pin the file-extraction gate, the
 * parallel fan-out, the `\n\n` content join, the count sum, and the per-axis
 * block pass-through deterministically. One Redis-backed test (DB 1, like the
 * sibling reflection suites) confirms the default (un-stubbed) path wires the
 * real axis reads.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { loadReflectionsForAnchor } = await import("../src/reflections/index.ts");

describe("issue #2232: loadReflectionsForAnchor coordinator (deps-injected, no Redis)", () => {
  test("merges both axes — content \\n\\n-joined, count summed, per-axis blocks surfaced", async () => {
    const perAnchorBlock = { content: "## PRIOR ATTEMPTS (1 …)\nbody-A", count: 1 };
    const byFileBlock = { content: "## RELATED FILES …\nbody-B", count: 2 };

    let byFileArgs: { files: string[]; exclude?: string } | null = null;

    const result = await loadReflectionsForAnchor(
      "src/foo/bar.ts — fix the thing",
      {
        scopeFiles: ["src/foo/bar.ts"],
        deps: {
          loadAnchorReflections: async () => perAnchorBlock,
          loadAnchorReflectionsByFile: async (files, exclude) => {
            byFileArgs = { files, exclude };
            return byFileBlock;
          },
        },
      },
    );

    assert.equal(result.combined.content, `${perAnchorBlock.content}\n\n${byFileBlock.content}`);
    assert.equal(result.combined.count, 3, "count is the sum of both axes");
    assert.deepEqual(result.perAnchor, perAnchorBlock, "per-anchor block passed through verbatim");
    assert.deepEqual(result.byFile, byFileBlock, "by-file block passed through verbatim");

    // The coordinator derives files (scope + anchor-string) and excludes the
    // anchor itself from the by-file fan-out.
    assert.ok(byFileArgs, "by-file read was called when files were derived");
    assert.ok(byFileArgs!.files.includes("src/foo/bar.ts"));
    assert.equal(byFileArgs!.exclude, "src/foo/bar.ts — fix the thing");
  });

  test("total miss yields an empty combined block (skill no-ops)", async () => {
    const empty = { content: "", count: 0 };
    const result = await loadReflectionsForAnchor("issue-9999", {
      deps: {
        loadAnchorReflections: async () => empty,
        loadAnchorReflectionsByFile: async () => empty,
      },
    });
    assert.equal(result.combined.content, "");
    assert.equal(result.combined.count, 0);
    assert.equal(result.perAnchor.count, 0);
    assert.equal(result.byFile.count, 0);
  });

  test("no derivable files → by-file read is skipped, only per-anchor contributes", async () => {
    let byFileCalled = false;
    const perAnchorBlock = { content: "## PRIOR ATTEMPTS\nbody", count: 1 };

    // "issue-841" has no path-shaped token and no scopeFiles → extractFilesFromAnchor
    // returns [] → the by-file branch is never invoked.
    const result = await loadReflectionsForAnchor("issue-841", {
      deps: {
        loadAnchorReflections: async () => perAnchorBlock,
        loadAnchorReflectionsByFile: async () => {
          byFileCalled = true;
          return { content: "should-not-appear", count: 99 };
        },
      },
    });

    assert.equal(byFileCalled, false, "by-file read skipped when no files derived");
    assert.equal(result.combined.content, perAnchorBlock.content);
    assert.equal(result.combined.count, 1);
    assert.equal(result.byFile.count, 0, "by-file axis is an empty block on no files");
  });

  test("only-per-anchor hit drops the empty by-file section from the join", async () => {
    const result = await loadReflectionsForAnchor("src/x/y.ts", {
      scopeFiles: ["src/x/y.ts"],
      deps: {
        loadAnchorReflections: async () => ({ content: "PA", count: 1 }),
        loadAnchorReflectionsByFile: async () => ({ content: "", count: 0 }),
      },
    });
    assert.equal(result.combined.content, "PA", "no leading/trailing blank from an empty axis");
    assert.equal(result.combined.count, 1);
  });
});

describe("issue #2238: backfillOnHit sequencing (deps-injected, no Redis)", () => {
  test("default path runs NO backfill and fans both reads out in parallel", async () => {
    let backfillCalls = 0;
    const order: string[] = [];

    await loadReflectionsForAnchor("src/x/y.ts", {
      scopeFiles: ["src/x/y.ts"],
      // backfillOnHit omitted → parallel path, backfill never consulted.
      deps: {
        loadAnchorReflections: async () => {
          order.push("per-anchor");
          return { content: "PA", count: 1 };
        },
        loadAnchorReflectionsByFile: async () => {
          order.push("by-file");
          return { content: "BF", count: 1 };
        },
        backfillByFileIndex: async () => {
          backfillCalls++;
          return ["src/x/y.ts"];
        },
      },
    });

    assert.equal(backfillCalls, 0, "no backfill on the default (parallel) path");
    assert.ok(order.includes("per-anchor") && order.includes("by-file"), "both axes read");
  });

  test("backfillOnHit + per-anchor HIT: backfill runs and commits BEFORE the by-file read", async () => {
    const order: string[] = [];
    let backfillArgs: { ref: string; files?: string[] | null } | null = null;

    const result = await loadReflectionsForAnchor("src/x/y.ts", {
      scopeFiles: ["src/x/y.ts"],
      backfillOnHit: true,
      deps: {
        loadAnchorReflections: async () => {
          order.push("per-anchor");
          return { content: "PA", count: 2 };
        },
        backfillByFileIndex: async (ref, files) => {
          order.push("backfill");
          backfillArgs = { ref, files };
          return ["src/x/y.ts"];
        },
        loadAnchorReflectionsByFile: async () => {
          order.push("by-file");
          return { content: "BF", count: 1 };
        },
      },
    });

    // The ordering constraint expressed structurally: per-anchor read, then the
    // backfill write, then the by-file read — never by-file before backfill.
    assert.deepEqual(order, ["per-anchor", "backfill", "by-file"]);
    assert.ok(backfillArgs, "backfill was called");
    assert.equal(backfillArgs!.ref, "src/x/y.ts", "backfill keyed on the anchor ref");
    assert.deepEqual(backfillArgs!.files, ["src/x/y.ts"], "backfill receives the scope files");

    // The combined result is still the two axes merged.
    assert.equal(result.combined.content, "PA\n\nBF");
    assert.equal(result.combined.count, 3);
  });

  test("backfillOnHit + per-anchor MISS: backfill is skipped (no write on a miss)", async () => {
    let backfillCalls = 0;
    const order: string[] = [];

    const result = await loadReflectionsForAnchor("src/x/y.ts", {
      scopeFiles: ["src/x/y.ts"],
      backfillOnHit: true,
      deps: {
        // per-anchor MISS (count 0) → backfill must NOT fire.
        loadAnchorReflections: async () => {
          order.push("per-anchor");
          return { content: "", count: 0 };
        },
        backfillByFileIndex: async () => {
          backfillCalls++;
          return [];
        },
        loadAnchorReflectionsByFile: async () => {
          order.push("by-file");
          return { content: "BF", count: 1 };
        },
      },
    });

    assert.equal(backfillCalls, 0, "no backfill on a per-anchor miss");
    assert.deepEqual(order, ["per-anchor", "by-file"], "by-file still reads, backfill skipped");
    assert.equal(result.combined.content, "BF", "only the by-file axis contributes");
    assert.equal(result.combined.count, 1);
  });

  test("backfillOnHit with no derivable files: backfill runs on a hit but by-file is skipped", async () => {
    let backfillCalls = 0;
    let byFileCalls = 0;

    // "issue-841" yields no path-shaped tokens and no scopeFiles → no by-file
    // read — but a per-anchor hit still triggers the opportunistic backfill.
    const result = await loadReflectionsForAnchor("issue-841", {
      backfillOnHit: true,
      deps: {
        loadAnchorReflections: async () => ({ content: "PA", count: 1 }),
        backfillByFileIndex: async () => {
          backfillCalls++;
          return [];
        },
        loadAnchorReflectionsByFile: async () => {
          byFileCalls++;
          return { content: "should-not-appear", count: 9 };
        },
      },
    });

    assert.equal(backfillCalls, 1, "backfill fires on the per-anchor hit");
    assert.equal(byFileCalls, 0, "by-file read skipped when no files derived");
    assert.equal(result.combined.content, "PA");
    assert.equal(result.byFile.count, 0);
  });
});

describe("issue #2232: loadReflectionsForAnchor default path (Redis-backed)", () => {
  let redis: any;
  let redisAvailable = false;
  let reflections: any;

  function requireRedis(t: any) {
    if (!redisAvailable) t.skip("Redis unavailable");
  }

  async function cleanReflectionKeys() {
    const keys = await redis.keys("hydra:reflections:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping #2232 Redis tests");
        return;
      }
      reflections = await import("../src/reflections/per-anchor.ts");
    }
    if (redisAvailable) await cleanReflectionKeys();
  });

  after(async () => {
    if (redis) {
      await cleanReflectionKeys().catch(() => {});
      redis.disconnect();
    }
  });

  test("default deps read the real per-anchor store", async (t) => {
    requireRedis(t);
    const anchorRef = "issue-2232-coordinator-test";
    await reflections.recordAnchorReflection({
      cycleId: "cycle-2232-001",
      anchorRef,
      taskTitle: "coordinator wiring",
      outcome: "verification-failure",
      reason: "prior attempt left a dangling import",
    });

    const result = await loadReflectionsForAnchor(anchorRef);
    assert.ok(result.combined.count >= 1, "per-anchor reflection surfaced through the coordinator");
    assert.ok(result.combined.content.includes("PRIOR ATTEMPTS"), "formatted narrative present");
    assert.ok(result.perAnchor.count >= 1);
  });

  test("a clean anchor with no reflections is a combined miss", async (t) => {
    requireRedis(t);
    const result = await loadReflectionsForAnchor("issue-2232-never-failed");
    assert.equal(result.combined.content, "");
    assert.equal(result.combined.count, 0);
  });
});
