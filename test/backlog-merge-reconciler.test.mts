/**
 * Regression tests for src/backlog/reconciler.ts — merge→done reconciler
 * (issue #1715).
 *
 * Background: marking a target-backlog item `done` after its PR merges
 * depends on the build flow doing it. When that path is missed (agent crash
 * after merge, reaper interference, manual merges) the item lingers in a
 * non-done lane as phantom work — `item-490` sat in `queued` for 9+ hours
 * after hydra-betting PR #109 merged (2026-06-11). The reaper's merged-PR
 * guard (#1714) only covers stale `inProgress` claims; the reconciler closes
 * the general hole across all non-done lanes.
 *
 * Each test corresponds to an acceptance criterion in the issue:
 *   - merged PR ref, item in queued/backlog/inProgress → moved to done with
 *     reconciledAt/reconciledFrom/outcome stamps
 *   - merge-commit ref (cycle merge bypassing PRs) → moved to done
 *   - item without a merged ref → untouched
 *   - feed outage (both fetchers null) → guaranteed no-op
 *   - idempotent: re-running over the same window is a no-op
 *   - closure emits a `merged-item-reconciled` alert (auditable)
 *   - blocked-lane items are NEVER reconciled even with a merged ref
 *     (design-concept invariant 3 — operator-attention lane)
 *
 * Feeds are injected via `opts.fetchMergedPrRefs` / `opts.fetchMergeCommitRefs`
 * (same seam style as `reaper.ts` `opts.fetchOpenPrBlobs`) so no test shells
 * out to `gh`.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let admin: any;
let redis: any;
let redisAvailable = false;

// This file shares the `hydra:backlog:*` keyspace shape with backlog.test.mts
// and the two reaper suites. Those are pinned to dedicated logical DBs
// (1/5/6 — see the #1446 note in backlog-stale-claim-reaper.test.mts); pin
// this file to its own DB so concurrent invocations can never clobber a
// sibling's fixtures.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/8";

async function cleanBacklogKeys() {
  const patterns = ["hydra:backlog:*", "hydra:alerts"];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

/** Inject-nothing feeds: both fetchers report a `gh` outage. */
const OUTAGE_FEEDS = {
  fetchMergedPrRefs: async () => null,
  fetchMergeCommitRefs: async () => null,
};

describe("backlog merge→done reconciler (issue #1715)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable, skipping merge-reconciler tests");
        return;
      }
      const reads = await import("../src/backlog/reads.ts");
      const items = await import("../src/backlog/items.ts");
      const lanes = await import("../src/backlog/lanes.ts");
      const reconciler = await import("../src/backlog/reconciler.ts");
      admin = { ...reads, ...items, ...lanes, ...reconciler };
    }
    if (!redisAvailable) return;
    await cleanBacklogKeys();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanBacklogKeys();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("merged PR ref moves a queued item to done with reconciled stamps (item-490 repro)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Wire scanner output", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-109", blob: `feat(scanner): wire output (${id})\ncloses ${id}` },
      ],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.feedsAvailable, true);
    assert.equal(result.reconciled.length, 1, "exactly one item reconciled");
    assert.equal(result.reconciled[0].id, id);
    assert.equal(result.reconciled[0].fromLane, "queued");
    assert.equal(result.reconciled[0].ref, "pr-109");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 0, "item must leave queued");
    assert.equal(lanes.done.length, 1);

    const done = lanes.done[0];
    assert.equal(done.id, id);
    assert.equal(done.lane, "done");
    assert.equal(done.meta.reconciledFrom, "pr-109");
    assert.ok(done.meta.reconciledAt, "reconciledAt must be stamped");
    assert.equal(done.meta.outcome, "merged");
    assert.ok(done.meta.completedAt, "completedAt must be set so done-retention prunes it");
    assert.equal(done.checked, true);
  });

  test("merge-commit ref (cycle merge bypassing PRs) moves a backlog-lane item to done", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Calibrate odds feed", category: "test" }); // default lane: backlog

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-f61e9ed", blob: `merge: claude cycle — calibrate odds feed (${id})` },
      ],
    });

    assert.equal(result.reconciled.length, 1);
    assert.equal(result.reconciled[0].fromLane, "backlog");
    assert.equal(result.reconciled[0].ref, "commit-f61e9ed");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.backlog.length, 0);
    assert.equal(lanes.done.length, 1);
    assert.equal(lanes.done[0].meta.reconciledFrom, "commit-f61e9ed");
  });

  test("merged ref moves an inProgress item to done and clears its claim", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Backfill run history", category: "test" });
    await admin.moveToInProgress("Backfill run history", { claimedBy: "claude" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-117", blob: `feat: run history page\n\ncloses ${id}` },
      ],
      fetchMergeCommitRefs: async () => null, // commit feed down — PR feed alone suffices
    });

    assert.equal(result.feedsAvailable, true);
    assert.equal(result.reconciled.length, 1);
    assert.equal(result.reconciled[0].fromLane, "inProgress");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 0);
    assert.equal(lanes.done.length, 1);
    // claimedAt/claimedBy cleared by the lane transition out of inProgress.
    assert.equal(lanes.done[0].claimedAt, null);
    assert.equal(lanes.done[0].claimedBy, null);
  });

  test("items without a merged reference are untouched", async (t) => {
    requireRedis(t);

    const { id: untouchedId } = await admin.addToBacklog({ title: "Unrelated future work", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-200", blob: "feat: something about item-99999 only" },
      ],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-abc1234", blob: "merge: claude cycle — other thing (item-88888)" },
      ],
    });

    assert.equal(result.reconciled.length, 0, "nothing may move without a concrete reference");
    assert.ok(result.scanned >= 1, "the untouched item was scanned");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
    assert.equal(lanes.queued[0].id, untouchedId);
    assert.equal(lanes.done.length, 0);
  });

  test("whole-word ID matching: item-3 must not match a PR referencing item-30", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Prefix collision guard", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-300", blob: `feat: superstring ref ${id}0 — different item` },
      ],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.reconciled.length, 0, "superstring ID must not match");
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
  });

  test("feed outage (both fetchers null) is a guaranteed no-op", async (t) => {
    requireRedis(t);

    await admin.addToBacklog({ title: "Survives the outage", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems(OUTAGE_FEEDS);

    assert.equal(result.feedsAvailable, false, "both feeds down must be reported");
    assert.equal(result.reconciled.length, 0);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1, "no item may move on a feed outage");
    assert.equal(lanes.done.length, 0);
  });

  test("idempotent: a second run over the same window reconciles nothing", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Once and only once", category: "test", lane: "queued" });
    const feeds = {
      fetchMergedPrRefs: async () => [{ ref: "pr-110", blob: `fix: done (${id})` }],
      fetchMergeCommitRefs: async () => [] as any[],
    };

    const first = await admin.reconcileMergedItems(feeds);
    assert.equal(first.reconciled.length, 1);

    const second = await admin.reconcileMergedItems(feeds);
    assert.equal(second.reconciled.length, 0, "done items are not re-reconciled");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.done.length, 1, "item stays done");
  });

  test("each closure emits a merged-item-reconciled alert (auditable)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Audit trail check", category: "test", lane: "queued" });

    await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [{ ref: "pr-111", blob: `chore: cleanup (${id})` }],
      fetchMergeCommitRefs: async () => [],
    });

    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "merged-item-reconciled");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].payload.itemId, id);
    assert.equal(matching[0].payload.fromLane, "queued");
    assert.equal(matching[0].payload.reconciledFrom, "pr-111");
    assert.ok(matching[0].ts, "alert carries a timestamp");
  });

  test("blocked-lane items are NEVER reconciled, even with a matching merged ref (invariant 3)", async (t) => {
    requireRedis(t);

    // The blocked lane is an operator-attention lane: a blocked item with a
    // merged PR still needs its blocker resolved by a human/agent decision,
    // never a silent auto-done (approved design-concept invariant 3).
    const { id } = await admin.addToBacklog({ title: "Blocked despite merge", category: "test", lane: "queued" });
    await admin.blockByTitle("Blocked despite merge", "waiting on operator decision");

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-112", blob: `feat: lands the work anyway (${id})\ncloses ${id}` },
      ],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-beef123", blob: `merge: claude cycle — blocked item work (${id})` },
      ],
    });

    assert.equal(result.reconciled.length, 0, "a blocked item must never be auto-reconciled");
    assert.equal(result.scanned, 0, "the blocked lane must not even be scanned");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.blocked.length, 1, "item stays in blocked");
    assert.equal(lanes.blocked[0].id, id);
    assert.equal(lanes.blocked[0].lane, "blocked");
    assert.equal(lanes.blocked[0].meta.reconciledFrom, undefined, "no reconciled stamp may be written");
    assert.equal(lanes.done.length, 0);

    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "merged-item-reconciled");
    assert.equal(matching.length, 0, "no reconciliation alert for a blocked item");
  });

  test("empty feeds (available but nothing merged) is a no-op without scanning movement", async (t) => {
    requireRedis(t);

    await admin.addToBacklog({ title: "Quiet repo day", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.feedsAvailable, true);
    assert.equal(result.reconciled.length, 0);
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
  });
});

/**
 * Stale-claim escalation pass (issue #2031). The merged-token scan only closes
 * items whose id/title appears in a recently-merged PR/commit. Items shipped
 * OUT-OF-BAND (a different cycle, a pre-removal claimant like `codex`, or work
 * abandoned for weeks) carry NO matching token, so the merged scan keeps them
 * and the claim path re-serves shipped/obsolete work. The escalation pass
 * routes such unconfirmable items to `blocked` (operator-visible) — NEVER
 * silently to `done`.
 */
describe("backlog stale-claim escalation (issue #2031)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FRESH_FEEDS = {
    // Feeds available but referencing nothing in the board → merged scan is a
    // no-op, so only the escalation pass can move anything.
    fetchMergedPrRefs: async () => [] as any[],
    fetchMergeCommitRefs: async () => [] as any[],
  };

  // Fully-local connection + module state, independent of the sibling describe
  // above (whose `after` disconnects its handle AND closes the shared singleton
  // pool). Sharing the module-level `redis`/`admin` raced "Connection is closed"
  // depending on suite ordering — own state keeps this block deterministic.
  let escRedis: any;
  let escAvailable = false;
  let escAdmin: any;

  async function cleanEscKeys() {
    for (const pattern of ["hydra:backlog:*", "hydra:alerts"]) {
      const keys = await escRedis.keys(pattern);
      if (keys.length > 0) await escRedis.del(...keys);
    }
  }

  beforeEach(async () => {
    if (!escRedis) {
      escRedis = new Redis(process.env.REDIS_URL!);
      try {
        await escRedis.ping();
        escAvailable = true;
      } catch {
        console.error("Redis unavailable, skipping stale-escalation tests");
        return;
      }
      const reads = await import("../src/backlog/reads.ts");
      const items = await import("../src/backlog/items.ts");
      const lanes = await import("../src/backlog/lanes.ts");
      const reconciler = await import("../src/backlog/reconciler.ts");
      escAdmin = { ...reads, ...items, ...lanes, ...reconciler };
    }
    if (!escAvailable) return;
    await cleanEscKeys();
  });

  after(async () => {
    if (escRedis) {
      if (escAvailable) await cleanEscKeys();
      escRedis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  function requireEscRedis(t: any) {
    if (!escAvailable) t.skip("Redis unavailable");
  }

  test("itemAgeMs reads movedAt → claimedAt → meta.addedAt, null when unageable", async () => {
    const { itemAgeMs } = await import("../src/backlog/reconciler.ts");
    // A fixed clock well after the 2020 fallback date below.
    const now = new Date("2026-06-18T00:00:00.000Z").getTime();
    assert.equal(itemAgeMs({ movedAt: new Date(now - 5 * DAY).toISOString() }, now), 5 * DAY);
    // claimedAt fallback when movedAt is absent
    assert.equal(itemAgeMs({ claimedAt: new Date(now - 2 * DAY).toISOString() }, now), 2 * DAY);
    // meta.addedAt last fallback (date-only string), far in the past → positive age
    assert.ok((itemAgeMs({ meta: { addedAt: "2020-01-01" } }, now) ?? 0) > 0);
    // movedAt takes precedence over an older meta.addedAt
    assert.equal(
      itemAgeMs({ movedAt: new Date(now - 1 * DAY).toISOString(), meta: { addedAt: "2020-01-01" } }, now),
      1 * DAY,
    );
    // no parseable timestamp → null (never escalated)
    assert.equal(itemAgeMs({}, now), null);
    assert.equal(itemAgeMs({ movedAt: "not-a-date" }, now), null);
  });

  test("staleEscalationVerdict flags retired claimant regardless of age", async () => {
    const { staleEscalationVerdict } = await import("../src/backlog/reconciler.ts");
    const now = new Date("2026-06-18T00:00:00.000Z").getTime();
    const fresh = new Date(now - 1000).toISOString();
    const v = staleEscalationVerdict({ claimedBy: "codex", movedAt: fresh }, now);
    assert.equal(v.escalate, true);
    assert.match(v.reason, /retired claimant/i);
    // case-insensitive on the claimant
    assert.equal(staleEscalationVerdict({ claimedBy: "CODEX", movedAt: fresh }, now).escalate, true);
  });

  test("staleEscalationVerdict flags age past the 14d threshold, spares fresh", async () => {
    const { staleEscalationVerdict } = await import("../src/backlog/reconciler.ts");
    const now = new Date("2026-06-18T00:00:00.000Z").getTime();
    assert.equal(
      staleEscalationVerdict({ movedAt: new Date(now - 20 * DAY).toISOString() }, now).escalate,
      true,
    );
    assert.equal(
      staleEscalationVerdict({ movedAt: new Date(now - 3 * DAY).toISOString() }, now).escalate,
      false,
    );
    // unageable + non-retired → never escalate (fail-open)
    assert.equal(staleEscalationVerdict({ claimedBy: "claude" }, now).escalate, false);
  });

  test("a 20-day-old queued item with no merged ref is escalated to blocked, not done", async (t) => {
    requireEscRedis(t);

    const { id } = await escAdmin.addToBacklog({ title: "Long-abandoned queued work", category: "test", lane: "queued" });

    // Pin the clock 20 days past the item's movedAt so it reads stale.
    const result = await escAdmin.reconcileMergedItems({ ...FRESH_FEEDS, now: Date.now() + 20 * DAY });

    assert.equal(result.reconciled.length, 0, "nothing may be auto-done without a merged ref");
    assert.equal(result.escalated.length, 1, "the stale item is escalated");
    assert.equal(result.escalated[0].id, id);
    assert.equal(result.escalated[0].fromLane, "queued");

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.queued.length, 0, "item leaves queued");
    assert.equal(lanes.done.length, 0, "item must NOT be silently done");
    assert.equal(lanes.blocked.length, 1, "item lands in operator-attention blocked");
    assert.equal(lanes.blocked[0].id, id);
    assert.equal(lanes.blocked[0].lane, "blocked");
    assert.ok(lanes.blocked[0].meta.blockedReason, "blockedReason stamped (schedulability invariant #1920)");
    assert.match(lanes.blocked[0].meta.blockedReason, /unconfirmable-shipped/);
    assert.equal(lanes.blocked[0].meta.staleEscalatedFrom, "queued");
  });

  test("a codex-claimed inProgress item is escalated even when fresh", async (t) => {
    requireEscRedis(t);

    const { id } = await escAdmin.addToBacklog({ title: "Codex orphan", category: "test" });
    await escAdmin.moveToInProgress("Codex orphan", { claimedBy: "codex" });

    // No clock skew — fresh item, but retired claimant triggers escalation.
    const result = await escAdmin.reconcileMergedItems(FRESH_FEEDS);

    assert.equal(result.escalated.length, 1);
    assert.equal(result.escalated[0].id, id);
    assert.match(result.escalated[0].reason, /retired claimant/i);

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.inProgress.length, 0);
    assert.equal(lanes.blocked.length, 1);
    assert.equal(lanes.done.length, 0);
    // claim fields cleared by the lane transition out of inProgress.
    assert.equal(lanes.blocked[0].claimedAt, null);
    assert.equal(lanes.blocked[0].claimedBy, null);
  });

  test("a merged-ref item is DONE'd, never escalated (merged scan wins)", async (t) => {
    requireEscRedis(t);

    // Old AND has a merged ref: the merged→done sweep must take it before the
    // escalation pass sees it.
    const { id } = await escAdmin.addToBacklog({ title: "Old but shipped", category: "test", lane: "queued" });

    const result = await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [{ ref: "pr-900", blob: `feat: shipped (${id})\ncloses ${id}` }],
      fetchMergeCommitRefs: async () => [],
      now: Date.now() + 30 * DAY,
    });

    assert.equal(result.reconciled.length, 1, "merged ref takes precedence");
    assert.equal(result.escalated.length, 0, "no double-handling — already left the lane");

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.done.length, 1);
    assert.equal(lanes.blocked.length, 0);
    assert.equal(lanes.done[0].meta.reconciledFrom, "pr-900");
  });

  test("blocked-lane items are never escalated (idempotent, operator-attention)", async (t) => {
    requireEscRedis(t);

    // An already-blocked item, even ancient, must not be re-touched.
    const { id } = await escAdmin.addToBacklog({ title: "Already blocked", category: "test", lane: "queued" });
    await escAdmin.blockByTitle("Already blocked", "waiting on operator");

    const result = await escAdmin.reconcileMergedItems({ ...FRESH_FEEDS, now: Date.now() + 60 * DAY });

    assert.equal(result.escalated.length, 0, "blocked lane is not swept");
    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.blocked.length, 1);
    assert.equal(lanes.blocked[0].id, id);
    assert.equal(lanes.blocked[0].meta.blockedReason, "waiting on operator", "original reason preserved");
  });

  test("fresh items are left untouched (no premature escalation)", async (t) => {
    requireEscRedis(t);

    const { id } = await escAdmin.addToBacklog({ title: "Brand new work", category: "test", lane: "queued" });

    const result = await escAdmin.reconcileMergedItems(FRESH_FEEDS);

    assert.equal(result.escalated.length, 0);
    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
    assert.equal(lanes.queued[0].id, id);
    assert.equal(lanes.blocked.length, 0);
  });

  test("escalation runs even on a full feed outage (local age signal, safe blocked lane)", async (t) => {
    requireEscRedis(t);

    await escAdmin.addToBacklog({ title: "Stale during gh outage", category: "test", lane: "queued" });

    const result = await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => null,
      fetchMergeCommitRefs: async () => null,
      now: Date.now() + 20 * DAY,
    });

    assert.equal(result.feedsAvailable, false, "both feeds down reported");
    assert.equal(result.reconciled.length, 0, "merged→done stays fail-closed on outage");
    assert.equal(result.escalated.length, 1, "escalation still runs — it routes to safe blocked lane");

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.blocked.length, 1);
    assert.equal(lanes.done.length, 0);
  });

  test("idempotent: a second run does not re-escalate (item already in blocked)", async (t) => {
    requireEscRedis(t);

    await escAdmin.addToBacklog({ title: "Escalate once", category: "test", lane: "queued" });
    const futureNow = Date.now() + 20 * DAY;

    const first = await escAdmin.reconcileMergedItems({ ...FRESH_FEEDS, now: futureNow });
    assert.equal(first.escalated.length, 1);

    const second = await escAdmin.reconcileMergedItems({ ...FRESH_FEEDS, now: futureNow });
    assert.equal(second.escalated.length, 0, "blocked items are not re-swept");

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.blocked.length, 1);
  });

  test("each escalation emits a stale-item-escalated alert (auditable)", async (t) => {
    requireEscRedis(t);

    const { id } = await escAdmin.addToBacklog({ title: "Audit the escalation", category: "test", lane: "queued" });

    await escAdmin.reconcileMergedItems({ ...FRESH_FEEDS, now: Date.now() + 20 * DAY });

    const alerts = await escRedis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "stale-item-escalated");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].payload.itemId, id);
    assert.equal(matching[0].payload.fromLane, "queued");
    assert.match(matching[0].payload.blockedReason, /unconfirmable-shipped/);
    assert.ok(matching[0].ts, "alert carries a timestamp");
  });
});
