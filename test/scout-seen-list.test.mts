/**
 * Regression tests for `src/scout/seen-list.ts` and `src/scout/aliases.ts`
 * (issue #484).
 *
 * Phase A of the /hydra-tool-scout epic ships the seen-list — the Redis-
 * backed ledger that lets re-runs of the scout skip tools we've already
 * considered. These tests cover:
 *
 *  1. Slug canonicalization (so `@tanstack/query` and `react-query` collapse
 *     to one entry).
 *  2. recordDecision — basic write + idempotent overwrite.
 *  3. recordDecision — `filed` requires `issueNum`.
 *  4. recordDecision — `skipped-cooldown` is a heartbeat (does NOT clobber
 *     prior terminal decision / filedAt).
 *  5. isEligibleForReEval — pure-function variants for every decision +
 *     cooldown path.
 *  6. eligibleForReEval — convenience wrapper round-trip through Redis.
 *  7. Operator-forced re-eval via `reEvalAt`.
 *  8. Corrupt-timestamp fallback (treated as eligible).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Use Redis DB 1 — same convention as other regression tests in this repo.
// Must be set before the seen-list module imports the connection adapter.
process.env.REDIS_URL = "redis://localhost:6379/1";

const { canonicalizeSlug, normalizeSlug, listKnownAliases } = await import(
  "../src/scout/aliases.ts"
);
const {
  recordDecision,
  getSeen,
  isEligibleForReEval,
  eligibleForReEval,
  REJECT_COOLDOWN_DAYS,
  WONTFIX_COOLDOWN_DAYS,
} = await import("../src/scout/seen-list.ts");

let testRedis: any = null;

function getTestRedis(): any {
  // Single shared connection for the file. The file-level `after` hook below
  // is the only place that closes it. Per-describe disconnect was brittle and
  // left the runner hanging on the production-singleton ioredis socket — see
  // PR #518 friction items 2/3 and the follow-up commit.
  if (!testRedis) {
    testRedis = new Redis("redis://localhost:6379/1");
  }
  return testRedis;
}

async function cleanTestKeys(): Promise<void> {
  const r = getTestRedis();
  const keys = await r.keys("hydra:scout:tools-considered:*");
  if (keys.length > 0) await r.del(...keys);
}

// File-level teardown — node:test runs top-level `after` hooks even when
// subtests fail, so this is the only place that needs to close sockets.
// Closes both:
//   1. The test-owned ioredis connection (created in getTestRedis()).
//   2. The production singleton in src/redis/connection.ts that
//      `recordDecision` / `getSeen` / `eligibleForReEval` pull through
//      `src/redis/kv.ts`. Without this, the node:test runner stays alive on
//      the open socket and CI's count-regression check fails because the
//      final `# pass NN` line never gets emitted before --test-force-exit
//      cuts the process.
after(async () => {
  if (testRedis && testRedis.status !== "end") {
    testRedis.disconnect();
    testRedis = null;
  }
  try {
    const { closeRedisConnections } = await import("../src/redis-adapter.ts");
    closeRedisConnections();
  } catch (err) {
    console.error("scout-seen-list teardown: closeRedisConnections failed", err);
  }
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ===========================================================================
// 1. Slug canonicalization
// ===========================================================================

describe("aliases.canonicalizeSlug (issue #484)", () => {
  test("lower-cases and strips junk via normalizeSlug", () => {
    assert.equal(normalizeSlug("React-Query"), "react-query");
    assert.equal(normalizeSlug("  effect_schema  "), "effect-schema");
    assert.equal(normalizeSlug("ast-grep!!"), "ast-grep");
  });

  test("strips npm scope prefix", () => {
    assert.equal(normalizeSlug("@tanstack/react-query"), "tanstack-react-query");
  });

  test("collides @tanstack/query, tanstack-query, react-query to one slug", () => {
    const canonical = "tanstack-query";
    assert.equal(canonicalizeSlug("@tanstack/query"), canonical);
    assert.equal(canonicalizeSlug("@tanstack/react-query"), canonical);
    assert.equal(canonicalizeSlug("react-query"), canonical);
    assert.equal(canonicalizeSlug("tanstack-query"), canonical);
    assert.equal(canonicalizeSlug("TanStack/Query"), canonical);
  });

  test("idempotent: canonicalize(canonicalize(x)) === canonicalize(x)", () => {
    const inputs = ["@tanstack/query", "react-query", "Zod", "fast-check"];
    for (const i of inputs) {
      const once = canonicalizeSlug(i);
      const twice = canonicalizeSlug(once);
      assert.equal(twice, once, `not idempotent for ${i}`);
    }
  });

  test("rejects empty and non-string inputs", () => {
    assert.throws(() => normalizeSlug(""), RangeError);
    assert.throws(() => normalizeSlug("   "), RangeError);
    assert.throws(() => normalizeSlug(123 as any), TypeError);
  });

  test("listKnownAliases returns a shallow copy", () => {
    const aliases = listKnownAliases();
    assert.equal(aliases["react-query"], "tanstack-query");
    // Mutating returned object must NOT mutate source-of-truth.
    aliases["mutated"] = "x";
    const fresh = listKnownAliases();
    assert.equal(fresh["mutated"], undefined);
  });
});

// ===========================================================================
// 2-4. recordDecision
// ===========================================================================

describe("seen-list.recordDecision (issue #484)", () => {
  beforeEach(async () => {
    getTestRedis();
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    // Connection disconnect happens in the file-level `after` hook above.
  });

  test("writes a 'filed' entry with all fields", async () => {
    const fixedNow = new Date("2026-05-18T12:00:00.000Z");
    await recordDecision("zod", "filed", "leverage score 5 — typed schemas", {
      tool: "zod",
      category: "typed-schemas",
      issueNum: 567,
      trigger: "manual",
      rubricVersion: "1",
      leverageScore: 5,
      now: () => fixedNow,
    });

    const entry = await getSeen("zod");
    assert.ok(entry, "entry should exist");
    assert.equal(entry.tool, "zod");
    assert.equal(entry.slug, "zod");
    assert.equal(entry.category, "typed-schemas");
    assert.equal(entry.decision, "filed");
    assert.equal(entry.reason, "leverage score 5 — typed schemas");
    assert.equal(entry.filedAt, "2026-05-18T12:00:00.000Z");
    assert.equal(entry.issueNum, 567);
    assert.equal(entry.reEvalAt, null);
    assert.equal(entry.trigger, "manual");
    assert.equal(entry.lastChecked, "2026-05-18T12:00:00.000Z");
    assert.equal(entry.rubricVersion, "1");
    assert.equal(entry.leverageScore, 5);
  });

  test("writes a 'rejected' entry without an issueNum", async () => {
    await recordDecision("chalk", "rejected", "structured-signal score 1", {
      tool: "chalk",
      category: "observability-ai-readable-spans",
      trigger: "manual",
    });
    const entry = await getSeen("chalk");
    assert.ok(entry);
    assert.equal(entry.decision, "rejected");
    assert.equal(entry.issueNum, null);
  });

  test("rejects decision='filed' with no issueNum", async () => {
    await assert.rejects(
      () =>
        recordDecision("foo", "filed", "x", {
          tool: "foo",
          category: "typed-schemas",
        }),
      RangeError,
    );
  });

  test("rejects empty slug / decision", async () => {
    await assert.rejects(
      () => recordDecision("", "filed", "x", { tool: "x", category: "y" }),
      TypeError,
    );
    await assert.rejects(
      () =>
        recordDecision("foo", "" as any, "x", { tool: "x", category: "y" }),
      TypeError,
    );
  });

  test("'skipped-cooldown' is a heartbeat — does NOT overwrite the prior terminal decision", async () => {
    const t1 = new Date("2026-05-18T12:00:00.000Z");
    const t2 = new Date("2026-05-19T12:00:00.000Z");

    // First: real filed decision.
    await recordDecision("zod", "filed", "leverage 5", {
      tool: "zod",
      category: "typed-schemas",
      issueNum: 999,
      now: () => t1,
    });

    // Second: heartbeat skip — re-scouted but in cooldown.
    await recordDecision(
      "zod",
      "skipped-cooldown",
      "still in cooldown",
      {
        tool: "zod",
        category: "typed-schemas",
        now: () => t2,
      },
    );

    const entry = await getSeen("zod");
    assert.ok(entry);
    assert.equal(entry.decision, "filed", "prior decision preserved");
    assert.equal(entry.reason, "leverage 5", "prior reason preserved");
    assert.equal(entry.filedAt, t1.toISOString(), "filedAt frozen");
    assert.equal(entry.issueNum, 999, "issueNum preserved");
    assert.equal(entry.lastChecked, t2.toISOString(), "heartbeat advanced");
  });

  test("subsequent terminal decisions overwrite the prior one", async () => {
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-06-01T00:00:00.000Z");

    await recordDecision("foo", "rejected", "stars too low", {
      tool: "foo",
      category: "typed-schemas",
      now: () => t1,
    });
    await recordDecision("foo", "filed", "now over the threshold", {
      tool: "foo",
      category: "typed-schemas",
      issueNum: 42,
      now: () => t2,
    });

    const entry = await getSeen("foo");
    assert.ok(entry);
    assert.equal(entry.decision, "filed");
    assert.equal(entry.issueNum, 42);
    assert.equal(entry.filedAt, t2.toISOString());
  });
});

// ===========================================================================
// 5. isEligibleForReEval — pure function paths
// ===========================================================================

describe("seen-list.isEligibleForReEval (issue #484)", () => {
  const baseNow = new Date("2026-05-18T00:00:00.000Z");

  test("null entry — always eligible (never considered)", () => {
    assert.equal(isEligibleForReEval(null, baseNow), true);
  });

  test("rejected, age < cooldown — NOT eligible", () => {
    const filedAt = new Date(
      baseNow.getTime() - (REJECT_COOLDOWN_DAYS - 1) * MS_PER_DAY,
    );
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "rejected",
          reason: "r",
          filedAt: filedAt.toISOString(),
          issueNum: null,
          reEvalAt: null,
          trigger: "manual",
          lastChecked: filedAt.toISOString(),
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      false,
    );
  });

  test("rejected, age >= cooldown — eligible", () => {
    const filedAt = new Date(
      baseNow.getTime() - (REJECT_COOLDOWN_DAYS + 1) * MS_PER_DAY,
    );
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "rejected",
          reason: "r",
          filedAt: filedAt.toISOString(),
          issueNum: null,
          reEvalAt: null,
          trigger: "manual",
          lastChecked: filedAt.toISOString(),
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      true,
    );
  });

  test("filed, age < cooldown — NOT eligible", () => {
    const filedAt = new Date(
      baseNow.getTime() - (WONTFIX_COOLDOWN_DAYS - 5) * MS_PER_DAY,
    );
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "filed",
          reason: "r",
          filedAt: filedAt.toISOString(),
          issueNum: 123,
          reEvalAt: null,
          trigger: "manual",
          lastChecked: filedAt.toISOString(),
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      false,
    );
  });

  test("filed, age >= cooldown — eligible (caller still checks GH state)", () => {
    const filedAt = new Date(
      baseNow.getTime() - (WONTFIX_COOLDOWN_DAYS + 1) * MS_PER_DAY,
    );
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "filed",
          reason: "r",
          filedAt: filedAt.toISOString(),
          issueNum: 123,
          reEvalAt: null,
          trigger: "manual",
          lastChecked: filedAt.toISOString(),
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      true,
    );
  });

  test("operator-forced re-eval via reEvalAt — eligible even inside cooldown", () => {
    const filedAt = new Date(
      baseNow.getTime() - 30 * MS_PER_DAY, // well inside cooldown
    );
    const reEvalAt = new Date(baseNow.getTime() - 1000); // already passed
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "filed",
          reason: "r",
          filedAt: filedAt.toISOString(),
          issueNum: 123,
          reEvalAt: reEvalAt.toISOString(),
          trigger: "manual",
          lastChecked: filedAt.toISOString(),
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      true,
    );
  });

  test("reEvalAt in the future — NOT eligible (cooldown still applies)", () => {
    const filedAt = new Date(baseNow.getTime() - 30 * MS_PER_DAY);
    const reEvalAt = new Date(baseNow.getTime() + 7 * MS_PER_DAY);
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "rejected",
          reason: "r",
          filedAt: filedAt.toISOString(),
          issueNum: null,
          reEvalAt: reEvalAt.toISOString(),
          trigger: "manual",
          lastChecked: filedAt.toISOString(),
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      false,
    );
  });

  test("corrupt filedAt — defaults to eligible (so next walk overwrites)", () => {
    assert.equal(
      isEligibleForReEval(
        {
          tool: "x",
          slug: "x",
          category: "y",
          decision: "rejected",
          reason: "r",
          filedAt: "not-a-date",
          issueNum: null,
          reEvalAt: null,
          trigger: "manual",
          lastChecked: "not-a-date",
          rubricVersion: null,
          leverageScore: null,
        },
        baseNow,
      ),
      true,
    );
  });
});

// ===========================================================================
// 6. eligibleForReEval — round-trip via Redis
// ===========================================================================

describe("seen-list.eligibleForReEval (Redis round-trip)", () => {
  beforeEach(async () => {
    getTestRedis();
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    // Connection disconnect happens in the file-level `after` hook above.
  });

  test("no record — eligible", async () => {
    assert.equal(await eligibleForReEval("never-seen"), true);
  });

  test("fresh rejection — NOT eligible immediately", async () => {
    const fixedNow = new Date("2026-05-18T00:00:00.000Z");
    await recordDecision("foo", "rejected", "leverage 2", {
      tool: "foo",
      category: "typed-schemas",
      now: () => fixedNow,
    });
    // Check using a `now` only 1 day later.
    const later = new Date(fixedNow.getTime() + 1 * MS_PER_DAY);
    assert.equal(await eligibleForReEval("foo", later), false);
  });

  test("rejection older than REJECT_COOLDOWN_DAYS — eligible", async () => {
    const longAgo = new Date("2024-01-01T00:00:00.000Z");
    await recordDecision("foo", "rejected", "leverage 2", {
      tool: "foo",
      category: "typed-schemas",
      now: () => longAgo,
    });
    // "Now" is well past the 90-day floor.
    const today = new Date("2026-05-18T00:00:00.000Z");
    assert.equal(await eligibleForReEval("foo", today), true);
  });
});
