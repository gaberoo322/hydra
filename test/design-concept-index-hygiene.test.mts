/**
 * Regression tests for design-concept INDEX HYGIENE (issue #3236).
 *
 * The reported symptom was "QA resolve MISS" 404s on `GET
 * /api/design-concepts/:anchorRef` — traced to the design-concept index
 * (`hydra:design-concept:index` ZSET) accumulating members that could never be
 * pruned, so the live index diverged from the set of live hashes (observed:
 * 168 index members against 86 live hashes).
 *
 * Root cause: `pruneDesignConceptIndex` reads members VERBATIM out of the ZSET and,
 * when it decides one is stale, must remove that exact member string. The old
 * code called `removeDesignConceptFromIndex`, which NORMALIZES its argument
 * (`"705"` → `"issue-705"`) before `zrem` — so a legacy **non-canonical**
 * member (a bare issue number written to the index before the #736
 * normalization landed) was un-prunable: the `zrem` targeted `issue-705`, a
 * member that isn't in the index, and silently missed. The orphan lingered
 * forever, bloating the index without bound.
 *
 * The fix adds `removeExactDesignConceptFromIndex` (a verbatim, non-normalizing
 * removal) and points `pruneDesignConceptIndex` at it. These tests pin:
 *   1. The write→read round-trip resolves via the canonical handle (control).
 *   2. A legacy non-canonical index member whose hash is gone IS actually
 *      evicted by the prune (the previously-missing case).
 *   3. `removeExactDesignConceptFromIndex` removes the raw member; the
 *      canonicalizing `removeDesignConceptFromIndex` does NOT touch it.
 *
 * Isolation: this is a NEW top-level suite with its own before/after
 * lifecycle (per the CLAUDE.md authoring rule — never piggyback on a sibling
 * suite's teardown). It uses a test-only anchorRef namespace and cleans the
 * shared `...:index` ZSET of exactly its own members so it never removes a
 * sibling suite's data.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const dc = await import("../src/design-concept.ts");
const dcSeam = await import("../src/redis/design-concept.ts");

const INDEX_KEY = "hydra:design-concept:index";

// Unique namespace so this suite never collides with sibling DC suites that
// share DB 1 + the index ZSET. All refs live under `test:idx-hygiene:*`.
const HASH_PREFIX = "hydra:design-concept:test:idx-hygiene:";
// The legacy non-canonical member the prune must be able to evict. It is a
// bare number so `normalizeAnchorRef` maps it to `issue-<N>` — the exact
// asymmetry that made it un-prunable before #3236. We use a high, unlikely
// number so a stray `issue-990001` in DB 1 can't interfere.
const LEGACY_MEMBER = "990001";

let redis: any;

/** Remove only THIS suite's members/keys from the shared DB (leave siblings). */
async function cleanOwnState() {
  const hashes = await redis.keys(HASH_PREFIX + "*");
  if (hashes.length > 0) await redis.del(...hashes);
  await redis.zrem(INDEX_KEY, LEGACY_MEMBER);
  await redis.del("hydra:design-concept:issue-" + LEGACY_MEMBER);
}

describe("design-concept index hygiene (#3236)", () => {
  beforeEach(async () => {
    if (!redis) redis = new Redis(process.env.REDIS_URL);
    await cleanOwnState();
  });

  after(async () => {
    await cleanOwnState();
    if (redis) redis.disconnect();
  });

  test("write→read round-trips via the canonical handle (control)", async () => {
    const saved = await dc.saveDesignConcept({
      anchorRef: "test:idx-hygiene:rt",
      scope: "orch",
      invariants: ["round-trips"],
    } as any);
    assert.equal(saved.anchorRef, "test:idx-hygiene:rt");

    // Read path resolves the same persisted artifact.
    const got = await dc.getDesignConcept("test:idx-hygiene:rt");
    assert.ok(got, "artifact must resolve after write");
    assert.equal(got!.anchorRef, "test:idx-hygiene:rt");

    // And the QA-time resolver finds it (found:true, never a bare null).
    const resolved = await dc.resolveDesignConceptForQa("test:idx-hygiene:rt");
    assert.equal(resolved.found, true);
  });

  test("prune EVICTS a legacy non-canonical index member whose hash is gone (#3236)", async () => {
    // Simulate the pre-#736 wedge: a bare-number member sits in the index with
    // NO hash behind it (the hash TTL'd out, or was written before
    // normalization). This is the member that used to be un-prunable.
    await redis.zadd(INDEX_KEY, Date.now() - 1000, LEGACY_MEMBER);
    // No `hydra:design-concept:990001` hash exists — that's the whole point.

    let members = await redis.zrange(INDEX_KEY, 0, -1);
    assert.ok(
      members.includes(LEGACY_MEMBER),
      "precondition: the legacy non-canonical member is in the index",
    );

    // The explicit prune write (#3605 extracted this from the list read) must
    // evict the stale non-canonical member.
    await dc.pruneDesignConceptIndex();

    members = await redis.zrange(INDEX_KEY, 0, -1);
    assert.ok(
      !members.includes(LEGACY_MEMBER),
      "the legacy non-canonical member must be pruned from the index",
    );
    // And the canonicalized form was never created as a phantom member.
    assert.ok(
      !members.includes("issue-" + LEGACY_MEMBER),
      "prune must not leave/create a phantom canonical member",
    );
  });

  test("removeExactDesignConceptFromIndex removes the raw member; the canonicalizing accessor does not", async () => {
    // Seed a bare non-canonical member.
    await redis.zadd(INDEX_KEY, Date.now(), LEGACY_MEMBER);

    // The canonicalizing accessor targets `issue-990001` — a NO-OP here,
    // because the stored member is the bare form. This pins WHY the old prune
    // silently missed.
    await dcSeam.removeDesignConceptFromIndex(LEGACY_MEMBER);
    let members = await redis.zrange(INDEX_KEY, 0, -1);
    assert.ok(
      members.includes(LEGACY_MEMBER),
      "canonicalizing removal must NOT evict the bare non-canonical member",
    );

    // The verbatim accessor removes exactly what it was given.
    await dcSeam.removeExactDesignConceptFromIndex(LEGACY_MEMBER);
    members = await redis.zrange(INDEX_KEY, 0, -1);
    assert.ok(
      !members.includes(LEGACY_MEMBER),
      "verbatim removal must evict the bare non-canonical member",
    );
  });
});
