/**
 * Regression test for issue #3340 — pattern-memory cue demotion on issue
 * RESOLUTION (the inverse of the #512 escalation path).
 *
 * What this proves:
 *   1. `parseCueFromMetaTitle` recovers the cue from both meta-friction title
 *      shapes (`meta(friction): <cue> hit N times across <skills>` and
 *      `meta(lesson): <cue> hit N times`), and rejects non-matching titles.
 *   2. `demotePattern` reduces hitCount modulo PROMOTION_THRESHOLD and stamps
 *      the demotion metadata.
 *   3. `runCueDemotion` demotes a friction pattern when its escalated issue is
 *      CLOSED, and does NOT demote when the issue is still OPEN (an OPEN issue
 *      never appears in the closed-issue query, so its cue is untouched).
 *   4. Idempotency: a closed issue already carrying a processed marker is
 *      skipped — no second demotion.
 *   5. A closed issue whose cue has no live pattern is marked processed but
 *      demotes nothing.
 *   6. The `pattern-cue-demotion` chore persists the run's demotion count.
 *   7. Integration: the DEFAULT load/save deps round-trip through the real
 *      friction Redis key (DB 1).
 *
 * The pure + injected-deps cases need no `gh`/Redis. One integration case
 * exercises the default `loadPatterns`/`savePatterns` against Redis DB 1.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  parseCueFromMetaTitle,
  demotePattern,
  runCueDemotion,
  type ClosedMetaIssue,
  type CueDemotionDeps,
} from "../src/pattern-memory/demotion.ts";
import { runPatternCueDemotion } from "../src/scheduler/chores/pattern-cue-demotion.ts";
import { PROMOTION_THRESHOLD } from "../src/pattern-memory/constants.ts";
import type { MemoryPattern } from "../src/pattern-memory/pattern-store.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

/** Build a minimal friction pattern fixture with a given cue + hit count. */
function pattern(category: string, hitCount: number): MemoryPattern {
  return {
    category,
    severity: "prevent",
    hitCount,
    firstSeen: "2026-07-01",
    lastSeen: "2026-07-10",
    lastCycleId: "cycle-1",
    action: "do the thing",
    examples: ["example one"],
    promoted: hitCount >= PROMOTION_THRESHOLD,
  };
}

describe("cue demotion: pure helpers (issue #3340)", () => {
  test("parseCueFromMetaTitle recovers the friction cue", () => {
    assert.equal(
      parseCueFromMetaTitle(
        "meta(friction): worktree-write-fence-desync hit 13 times across hydra-dev, hydra-qa",
      ),
      "worktree-write-fence-desync",
    );
  });

  test("parseCueFromMetaTitle recovers the lesson cue", () => {
    assert.equal(
      parseCueFromMetaTitle("meta(lesson): stale-anchor-hint hit 3 times"),
      "stale-anchor-hint",
    );
  });

  test("parseCueFromMetaTitle handles a cue containing the word 'hit'", () => {
    // Non-greedy capture must stop at the ` hit <n> times` anchor, not the
    // literal "hit" inside the cue.
    assert.equal(
      parseCueFromMetaTitle("meta(friction): cache-hit-miss-race hit 5 times across hydra-dev"),
      "cache-hit-miss-race",
    );
  });

  test("parseCueFromMetaTitle rejects non-meta titles", () => {
    assert.equal(parseCueFromMetaTitle("some unrelated issue title"), null);
    assert.equal(parseCueFromMetaTitle("meta(friction): no hit count here"), null);
    assert.equal(parseCueFromMetaTitle(""), null);
    // Deliberate wrong type: exercises the runtime `typeof title !== "string"`
    // guard. Cast (not @ts-expect-error) because strictNullChecks is off, so
    // a bare `null` argument raises no type error for the directive to consume.
    assert.equal(parseCueFromMetaTitle(null as unknown as string), null);
  });

  test("demotePattern reduces hitCount modulo the promotion threshold", () => {
    // At the threshold → 0. At threshold+k → k. Always < threshold afterward.
    const atThreshold = pattern("cue-a", PROMOTION_THRESHOLD);
    demotePattern(atThreshold, "2026-07-15");
    assert.equal(atThreshold.hitCount, 0);

    const above = pattern("cue-b", PROMOTION_THRESHOLD + 10); // 13
    demotePattern(above, "2026-07-15");
    assert.equal(above.hitCount, 13 % PROMOTION_THRESHOLD); // 1
    assert.ok(above.hitCount < PROMOTION_THRESHOLD);
  });

  test("demotePattern stamps demotion metadata + clears promoted", () => {
    const p = pattern("cue-c", 6);
    p.promoted = true;
    demotePattern(p, "2026-07-15");
    assert.equal(p.promoted, false);
    assert.equal(p.demoted, true);
    assert.equal(p.demotedAt, "2026-07-15");
    assert.equal(p.demotedReason, "resolved");
  });
});

describe("cue demotion: runCueDemotion with injected deps (issue #3340)", () => {
  /** In-memory pattern store keyed by skill, plus a marker set. */
  function makeStore(seed: Record<string, MemoryPattern[]>) {
    const store: Record<string, MemoryPattern[]> = {};
    for (const [skill, pats] of Object.entries(seed)) {
      // deep clone so cases don't share references
      store[skill] = pats.map(p => ({ ...p }));
    }
    const markers: Record<string, string> = {};
    const saves: string[] = [];
    const deps: CueDemotionDeps = {
      loadPatterns: async (skill) => store[skill] ?? [],
      savePatterns: async (skill, pats) => {
        store[skill] = pats;
        saves.push(skill);
      },
      getMarker: async (issueNumber) => markers[issueNumber] ?? null,
      setMarker: async (issueNumber, value) => {
        markers[issueNumber] = value;
      },
      frictionSkills: ["hydra-dev", "hydra-qa"],
      now: () => 1_752_000_000_000,
    };
    return { store, markers, saves, deps };
  }

  test("closed issue demotes the matching friction cue", async () => {
    const { store, markers, deps } = makeStore({
      "hydra-dev": [pattern("worktree-write-fence-desync", 13)],
    });
    const closed: ClosedMetaIssue[] = [
      { number: 501, title: "meta(friction): worktree-write-fence-desync hit 13 times across hydra-dev" },
    ];
    const result = await runCueDemotion({
      ...deps,
      fetchClosedIssues: async () => closed,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.demotions.length, 1);
    assert.equal(result.demotions[0].cue, "worktree-write-fence-desync");
    assert.equal(result.demotions[0].skill, "hydra-dev");
    assert.equal(result.demotions[0].hitCountBefore, 13);
    assert.equal(result.demotions[0].hitCountAfter, 13 % PROMOTION_THRESHOLD);
    // Store mutated + marker written.
    assert.equal(store["hydra-dev"][0].hitCount, 13 % PROMOTION_THRESHOLD);
    assert.equal(store["hydra-dev"][0].demoted, true);
    assert.ok(markers["501"]);
  });

  test("OPEN issue does not demote (never appears in the closed set)", async () => {
    const { store, deps } = makeStore({
      "hydra-dev": [pattern("open-cue", 9)],
    });
    // The closed-issue query returns ONLY closed issues; the open issue's cue is
    // therefore never handed to runCueDemotion. Simulate an empty closed set.
    const result = await runCueDemotion({
      ...deps,
      fetchClosedIssues: async () => [],
    });
    assert.equal(result.scanned, 0);
    assert.equal(result.demotions.length, 0);
    // Pattern untouched.
    assert.equal(store["hydra-dev"][0].hitCount, 9);
    assert.equal(store["hydra-dev"][0].demoted, undefined);
  });

  test("already-processed closed issue is skipped (idempotent)", async () => {
    const { store, markers, saves, deps } = makeStore({
      "hydra-dev": [pattern("already-done-cue", 12)],
    });
    markers["777"] = "already-processed";
    const closed: ClosedMetaIssue[] = [
      { number: 777, title: "meta(friction): already-done-cue hit 12 times across hydra-dev" },
    ];
    const result = await runCueDemotion({
      ...deps,
      fetchClosedIssues: async () => closed,
    });
    assert.equal(result.demotions.length, 0);
    assert.equal(saves.length, 0);
    // Pattern untouched — no double demotion.
    assert.equal(store["hydra-dev"][0].hitCount, 12);
  });

  test("closed issue with no live pattern marks processed, demotes nothing", async () => {
    const { markers, saves, deps } = makeStore({
      "hydra-dev": [pattern("some-other-cue", 5)],
    });
    const closed: ClosedMetaIssue[] = [
      { number: 888, title: "meta(friction): vanished-cue hit 3 times across hydra-dev" },
    ];
    const result = await runCueDemotion({
      ...deps,
      fetchClosedIssues: async () => closed,
    });
    assert.equal(result.demotions.length, 0);
    assert.equal(saves.length, 0);
    // Marked processed so it isn't re-inspected hourly.
    assert.ok(markers["888"]);
  });

  test("unparseable closed-issue title is marked processed, not an error", async () => {
    const { markers, deps } = makeStore({ "hydra-dev": [] });
    const closed: ClosedMetaIssue[] = [
      { number: 999, title: "a manually filed meta-friction issue" },
    ];
    const result = await runCueDemotion({
      ...deps,
      fetchClosedIssues: async () => closed,
    });
    assert.equal(result.demotions.length, 0);
    assert.equal(result.errors.length, 0);
    assert.ok(markers["999"]);
  });

  test("a fetch failure degrades to an empty result (never throws)", async () => {
    const { deps } = makeStore({ "hydra-dev": [] });
    const result = await runCueDemotion({
      ...deps,
      fetchClosedIssues: async () => {
        throw new Error("gh exploded");
      },
    });
    assert.equal(result.scanned, 0);
    assert.equal(result.demotions.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /gh exploded/);
  });
});

describe("cue demotion: chore count persistence (issue #3340)", () => {
  test("chore persists the run's demotion count", async () => {
    let persisted: number | null = null;
    await runPatternCueDemotion({
      runCueDemotion: async () => ({
        scanned: 3,
        demotions: [
          { issueNumber: 1, cue: "a", skill: "hydra-dev", hitCountBefore: 3, hitCountAfter: 0 },
          { issueNumber: 2, cue: "b", skill: "hydra-qa", hitCountBefore: 13, hitCountAfter: 1 },
        ],
        errors: [],
      }),
      setLastDemotionCount: async (count) => {
        persisted = count;
      },
    });
    assert.equal(persisted, 2);
  });

  test("chore swallows a thrown pass (never throws)", async () => {
    let persisted: number | null = null;
    await assert.doesNotReject(
      runPatternCueDemotion({
        runCueDemotion: async () => {
          throw new Error("boom");
        },
        setLastDemotionCount: async (count) => {
          persisted = count;
        },
      }),
    );
    // Persist is never reached when the pass throws.
    assert.equal(persisted, null);
  });
});

describe("cue demotion: default deps round-trip Redis (issue #3340)", () => {
  let redis: any;

  before(() => {
    redis = new Redis(REDIS_URL);
  });

  beforeEach(async () => {
    // Fresh state per case (this suite mutates a shared friction key).
    await redis.del("hydra:friction:hydra-dev:patterns");
    await redis.del("hydra:learning:demoted-issues");
  });

  after(async () => {
    await redis.del("hydra:friction:hydra-dev:patterns");
    await redis.del("hydra:learning:demoted-issues");
    redis.disconnect();
  });

  test("demotion loads + saves through the real friction Redis key", async () => {
    // Seed a promoted friction pattern via the raw key.
    const seeded = [pattern("real-redis-cue", 13)];
    await redis.set("hydra:friction:hydra-dev:patterns", JSON.stringify(seeded));

    const result = await runCueDemotion({
      // Only stub the gh query; load/save/marker use the real defaults.
      fetchClosedIssues: async () => [
        { number: 4242, title: "meta(friction): real-redis-cue hit 13 times across hydra-dev" },
      ],
      frictionSkills: ["hydra-dev"],
    });

    assert.equal(result.demotions.length, 1);
    assert.equal(result.demotions[0].hitCountAfter, 13 % PROMOTION_THRESHOLD);

    // Re-read the key: the demotion persisted.
    const raw = await redis.get("hydra:friction:hydra-dev:patterns");
    const stored = JSON.parse(raw);
    assert.equal(stored[0].hitCount, 13 % PROMOTION_THRESHOLD);
    assert.equal(stored[0].demoted, true);
    assert.equal(stored[0].demotedReason, "resolved");

    // Idempotency marker written — a re-run demotes nothing.
    const rerun = await runCueDemotion({
      fetchClosedIssues: async () => [
        { number: 4242, title: "meta(friction): real-redis-cue hit 13 times across hydra-dev" },
      ],
      frictionSkills: ["hydra-dev"],
    });
    assert.equal(rerun.demotions.length, 0);
    const raw2 = await redis.get("hydra:friction:hydra-dev:patterns");
    const stored2 = JSON.parse(raw2);
    assert.equal(stored2[0].hitCount, 13 % PROMOTION_THRESHOLD); // unchanged
  });
});
