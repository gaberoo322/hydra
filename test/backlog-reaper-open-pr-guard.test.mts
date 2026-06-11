/**
 * Regression tests for src/backlog/reaper.ts — stale-claim reaper open-PR guard (issue #490).
 *
 * Background: on 2026-05-17 the autopilot dispatched a dev_target subagent
 * against backlog item-302. The work was already shipped in
 * hydra-betting PR #10 (OPEN, MERGEABLE, ~5h before the tick). The
 * stale-claim reaper had returned item-302 to `queued` despite the open
 * implementing PR, causing the candidates feed to re-surface it. The duplicate
 * dispatch wasted 76k tokens before the subagent noticed the existing PR
 * and abandoned its cycle.
 *
 * Fix: `reapStaleClaims` now fetches OPEN PRs from the target repo before
 * reaping and skips any item whose ID (or exact title) appears in a PR
 * title/body. Time-only reaping is preserved as a fall-through when the PR
 * fetch is unavailable so a `gh` outage can't wedge the WIP cap.
 *
 * Each test corresponds to an acceptance criterion in the issue:
 *   - item with an open target PR is preserved, not reaped
 *   - item without a matching open PR is still reaped (regression-safe)
 *   - whole-word ID match (item-302 does NOT match item-3020)
 *   - exact title substring match for PRs that don't embed the ID
 *   - `gh` failure / null fetcher falls back to original behaviour
 *   - skippedOpenPr is reported in the result for operator audit
 *   - the pure `itemMatchesOpenPr` helper has correct match semantics
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
// Static import keeps the pure matcher statically traceable (knip) — the
// Redis-backed cases below still reach the rest of the backlog surface through
// the dynamic-import `admin` namespace, but the pure helper needs no Redis.
import { itemMatchesOpenPr } from "../src/backlog/reaper.ts";

let admin: any;
let redis: any;
let redisAvailable = false;

// issue #1446 — dedicated non-zero logical DB so this file's
// `hydra:backlog:*` fixtures can never be clobbered by a concurrently-running
// sibling backlog file (backlog.test.mts on DB-1,
// backlog-stale-claim-reaper.test.mts on DB-5). See that file's header for the
// full rationale: serial `--test-concurrency=1` masks the shared-DB-1
// collision, but a subset run without the flag re-surfaces the recurring
// "redis-shared-backlog-tests-flaky-in-full-run" flake. 3 dedicated DBs is
// inside the 16-DB budget #1231 was protecting.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/6";

async function cleanBacklogKeys() {
  const patterns = ["hydra:backlog:*", "hydra:alerts", "hydra:metrics:claims-reaped*"];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

async function backdateClaim(itemId: string, ageMs: number) {
  const raw = await redis.hget("hydra:backlog:items", itemId);
  const item = JSON.parse(raw);
  const backdated = new Date(Date.now() - ageMs).toISOString();
  item.claimedAt = backdated;
  item.movedAt = backdated;
  await redis.hset("hydra:backlog:items", itemId, JSON.stringify(item));
}

describe("backlog reaper open-PR guard (issue #490)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable at localhost:6379/1, skipping open-PR guard tests");
        return;
      }
      const reads = await import("../src/backlog/reads.ts");
      const items = await import("../src/backlog/items.ts");
      const lanes = await import("../src/backlog/lanes.ts");
      const claims = await import("../src/backlog/claims.ts");
      const wip = await import("../src/backlog/wip.ts");
      const reaper = await import("../src/backlog/reaper.ts");
      admin = { ...reads, ...items, ...lanes, ...claims, ...wip, ...reaper };
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

  // ---------------------------------------------------------------------------
  // Pure helper — itemMatchesOpenPr
  // ---------------------------------------------------------------------------

  test("itemMatchesOpenPr matches whole-word item IDs in PR title or body", () => {
    const item = { id: "item-302", title: "Add scanner run history page with suppression rate trends" };
    assert.equal(
      itemMatchesOpenPr(item, ["feat(scanner): item-302 add run history page\nCloses item-302."]),
      true,
      "matches ID in title",
    );
    assert.equal(
      itemMatchesOpenPr(item, ["random title\ncloses item-302 in the body"]),
      true,
      "matches ID in body",
    );
  });

  test("itemMatchesOpenPr does NOT match an ID that's a substring of a longer ID", () => {
    const item = { id: "item-302", title: "Short title" };
    // item-3020 should NOT cause item-302 to match
    assert.equal(
      itemMatchesOpenPr(item, ["feat(scanner): item-3020 do something else"]),
      false,
      "rejects substring collision item-302 vs item-3020",
    );
    assert.equal(
      itemMatchesOpenPr(item, ["touches item-3025 and item-30200"]),
      false,
      "rejects multiple longer IDs",
    );
  });

  test("itemMatchesOpenPr falls back to exact title match when ID is absent", () => {
    const item = { id: "item-77", title: "Add scanner run history page with suppression rate trends" };
    assert.equal(
      itemMatchesOpenPr(item, [
        "feat: scanner page\nAdd scanner run history page with suppression rate trends — initial pass",
      ]),
      true,
      "matches exact title substring (no ID required)",
    );
  });

  test("itemMatchesOpenPr returns false for empty / null inputs", () => {
    const item = { id: "item-302", title: "Foo" };
    assert.equal(itemMatchesOpenPr(item, []), false);
    assert.equal(itemMatchesOpenPr(item, null as any), false);
    assert.equal(itemMatchesOpenPr({ id: "", title: "Foo" }, ["foo"]), false);
  });

  test("itemMatchesOpenPr rejects very short titles to avoid false positives", () => {
    // A 5-char title like "Fix X" must not match every PR mentioning "Fix X" in their body.
    const item = { id: "item-99", title: "Fix" };
    assert.equal(
      itemMatchesOpenPr(item, ["some PR\nFix this thing"]),
      false,
      "short titles (<12 chars) should not match by title alone",
    );
  });

  // ---------------------------------------------------------------------------
  // End-to-end — reapStaleClaims with open-PR guard
  // ---------------------------------------------------------------------------

  test("reapStaleClaims SKIPS an item whose ID appears in an open target PR (issue #490 repro)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({
      title: "Add scanner run history page with suppression rate trends",
      category: "test",
    });
    await admin.moveToInProgress(
      "Add scanner run history page with suppression rate trends",
      { claimedBy: "claude" },
    );
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    // Simulate the production failure: an open target-repo PR references this item.
    const fetchOpenPrBlobs = async () => [
      `feat(scanner): ${id} add run history page\nCloses ${id}.\nImplements suppression rate trends.`,
    ];

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrBlobs,
      // issue #1714: inject a null merged-PR feed so these tests stay
      // hermetic — without it the new merged-PR guard's default fetcher
      // would shell out to `gh` (and real merged PRs could match test IDs).
      fetchMergedPrBlobs: async () => null,
    });

    assert.equal(result.reaped.length, 0, "no items reaped — open PR guard protected the item");
    assert.equal(result.skippedOpenPr.length, 1, "skippedOpenPr lists the protected item");
    assert.equal(result.skippedOpenPr[0].id, id);

    // Item remains inProgress (the whole point of the fix).
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 1);
    assert.equal(lanes.inProgress[0].id, id);
    assert.equal(lanes.queued.length, 0);

    // Metrics counter is NOT incremented for skipped items.
    const lifetime = await redis.get("hydra:metrics:claims-reaped");
    assert.equal(lifetime, null, "claims-reaped counter unchanged when reap was skipped");

    // No stale-claim-reaped alert for the skipped item.
    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const reapAlerts = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "stale-claim-reaped");
    assert.equal(reapAlerts.length, 0, "no reap alert emitted for skipped item");
  });

  test("reapStaleClaims still reaps items WITHOUT an open target PR (no regression)", async (t) => {
    requireRedis(t);

    const { id: protectedId } = await admin.addToBacklog({ title: "Protected item alpha", category: "test" });
    await admin.moveToInProgress("Protected item alpha", { claimedBy: "claude" });
    await backdateClaim(protectedId, 3 * 60 * 60 * 1000);

    const { id: unprotectedId } = await admin.addToBacklog({ title: "Unprotected item beta", category: "test" });
    await admin.moveToInProgress("Unprotected item beta", { claimedBy: "claude" });
    await backdateClaim(unprotectedId, 3 * 60 * 60 * 1000);

    // Only the protected item has an open PR.
    const fetchOpenPrBlobs = async () => [`feat: ${protectedId} ship it`];

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrBlobs,
      // issue #1714: inject a null merged-PR feed so these tests stay
      // hermetic — without it the new merged-PR guard's default fetcher
      // would shell out to `gh` (and real merged PRs could match test IDs).
      fetchMergedPrBlobs: async () => null,
    });

    assert.equal(result.reaped.length, 1, "exactly one item reaped (the unprotected one)");
    assert.equal(result.reaped[0].id, unprotectedId);
    assert.equal(result.skippedOpenPr.length, 1);
    assert.equal(result.skippedOpenPr[0].id, protectedId);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 1);
    assert.equal(lanes.inProgress[0].id, protectedId, "protected item still in inProgress");
    assert.equal(lanes.queued.length, 1);
    assert.equal(lanes.queued[0].id, unprotectedId, "unprotected item moved to queued");
  });

  test("reapStaleClaims falls back to time-only reaping when the PR fetcher returns null (gh outage)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Gh outage victim", category: "test" });
    await admin.moveToInProgress("Gh outage victim", { claimedBy: "claude" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    // Null = "couldn't check". The reaper must NOT wedge the slot — it falls
    // back to the original time-only behaviour. Over-reap once > wedge forever.
    const fetchOpenPrBlobs = async () => null;

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrBlobs,
      // issue #1714: inject a null merged-PR feed so these tests stay
      // hermetic — without it the new merged-PR guard's default fetcher
      // would shell out to `gh` (and real merged PRs could match test IDs).
      fetchMergedPrBlobs: async () => null,
    });

    assert.equal(result.reaped.length, 1, "item reaped when PR feed is unavailable");
    assert.equal(result.reaped[0].id, id);
    assert.equal(result.skippedOpenPr.length, 0);
  });

  test("reapStaleClaims open-PR guard ignores PRs that mention a different item ID", async (t) => {
    requireRedis(t);

    const { id: targetId } = await admin.addToBacklog({ title: "Item under test", category: "test" });
    await admin.moveToInProgress("Item under test", { claimedBy: "claude" });
    await backdateClaim(targetId, 3 * 60 * 60 * 1000);

    // PR talks about a different item entirely.
    const fetchOpenPrBlobs = async () => [
      "feat: item-999 unrelated work\nNothing about the item we're testing.",
    ];

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrBlobs,
      // issue #1714: inject a null merged-PR feed so these tests stay
      // hermetic — without it the new merged-PR guard's default fetcher
      // would shell out to `gh` (and real merged PRs could match test IDs).
      fetchMergedPrBlobs: async () => null,
    });

    assert.equal(result.reaped.length, 1, "unrelated open PR does not protect the item");
    assert.equal(result.skippedOpenPr.length, 0);
  });

  test("reapStaleClaims open-PR guard skips items whose long title is embedded in the PR body", async (t) => {
    requireRedis(t);

    const title = "Add scanner run history page with suppression rate trends";
    const { id } = await admin.addToBacklog({ title, category: "test" });
    await admin.moveToInProgress(title, { claimedBy: "claude" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    // PR uses a different ID scheme (or no ID), but quotes the title verbatim.
    const fetchOpenPrBlobs = async () => [
      `feat(scanner): history page\nFrom the backlog: "${title}"`,
    ];

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrBlobs,
      // issue #1714: inject a null merged-PR feed so these tests stay
      // hermetic — without it the new merged-PR guard's default fetcher
      // would shell out to `gh` (and real merged PRs could match test IDs).
      fetchMergedPrBlobs: async () => null,
    });

    assert.equal(result.reaped.length, 0);
    assert.equal(result.skippedOpenPr.length, 1);
    assert.equal(result.skippedOpenPr[0].id, id);
  });
});
