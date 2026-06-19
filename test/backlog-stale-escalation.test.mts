/**
 * Regression tests for src/backlog/stale-escalation.ts — the stale-claim
 * escalation pass (issue #2031), extracted from reconciler.ts into its own
 * Module (issue #2138).
 *
 * The merged-token scan in reconciler.ts only closes items whose id/title
 * appears in a recently-merged PR/commit. Items shipped OUT-OF-BAND (a
 * different cycle, a pre-removal claimant like `codex`, or work abandoned for
 * weeks) carry NO matching token, so the merged scan keeps them and the claim
 * path re-serves shipped/obsolete work. The escalation pass routes such
 * unconfirmable items to `blocked` (operator-visible) — NEVER silently to
 * `done`.
 *
 * The pure predicates (`itemAgeMs`, `staleEscalationVerdict`) are imported
 * directly from `stale-escalation.ts`; the integration tests drive the pass
 * end-to-end through `reconcileMergedItems` (the escalation is reached through
 * the orchestrator, which threads the live merged-`refs` set in for the #2110
 * subject fuzzy-match gate).
 *
 * Feeds are injected via `opts.fetchMergedPrRefs` / `opts.fetchMergeCommitRefs`
 * so no test shells out to `gh`.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// This file shares the `hydra:backlog:*` keyspace shape with backlog.test.mts,
// the two reaper suites, and the merge-reconciler suite. Those are pinned to
// dedicated logical DBs (1/5/6/8 — see the #1446 note); pin this file to its
// OWN DB so concurrent invocations can never clobber a sibling's fixtures.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/9";

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

  // Fully-local connection + module state. Sharing a module-level
  // `redis`/`admin` raced "Connection is closed" depending on suite ordering —
  // own state keeps this block deterministic.
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
    const { itemAgeMs } = await import("../src/backlog/stale-escalation.ts");
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
    const { staleEscalationVerdict } = await import("../src/backlog/stale-escalation.ts");
    const now = new Date("2026-06-18T00:00:00.000Z").getTime();
    const fresh = new Date(now - 1000).toISOString();
    const v = staleEscalationVerdict({ claimedBy: "codex", movedAt: fresh }, now);
    assert.equal(v.escalate, true);
    assert.match(v.reason, /retired claimant/i);
    // case-insensitive on the claimant
    assert.equal(staleEscalationVerdict({ claimedBy: "CODEX", movedAt: fresh }, now).escalate, true);
  });

  test("staleEscalationVerdict flags age past the 14d threshold, spares fresh", async () => {
    const { staleEscalationVerdict } = await import("../src/backlog/stale-escalation.ts");
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

  // -------------------------------------------------------------------------
  // Subject fuzzy-match gate (issue #2110). A stale item whose work shipped
  // under a RENAMED title (no item-NNN token) must reconcile to done via the
  // subject-coverage gate, not escalate as a false-positive "unconfirmable".
  // -------------------------------------------------------------------------

  test("#2110: stale item whose title is subject-covered by a merged blob (no item-NNN) is reconciled, not escalated", async (t) => {
    requireEscRedis(t);

    // The item title shares all its significant words with the merged blob, but
    // the blob carries NO `item-NNN`/`#NNN` token — the token scan misses it,
    // and only the new subject gate can recognise the shipment.
    const { id } = await escAdmin.addToBacklog({
      title: "Extract scheduler housekeeping cooldown helper",
      category: "test",
      lane: "queued",
    });

    const result = await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        {
          ref: "pr-2200",
          // Renamed PR title + extra body text, no item id at all.
          blob:
            "refactor(scheduler): extract cooldown helper from housekeeping module\n\n" +
            "Pulls the per-class cooldown logic into a pure helper for testability.",
        },
      ],
      fetchMergeCommitRefs: async () => [],
      now: Date.now() + 20 * DAY,
    });

    assert.equal(result.escalated.length, 0, "subject match suppresses the false-positive escalation");
    assert.equal(result.reconciled.length, 1, "the shipped-under-rename item is reconciled to done");
    assert.equal(result.reconciled[0].id, id);
    assert.equal(result.reconciled[0].ref, "pr-2200");

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.queued.length, 0, "item leaves queued");
    assert.equal(lanes.blocked.length, 0, "NOT escalated to blocked");
    assert.equal(lanes.done.length, 1, "reconciled to done");
    assert.equal(lanes.done[0].id, id);
    assert.equal(lanes.done[0].meta.reconciledFrom, "pr-2200");
    assert.equal(lanes.done[0].meta.reconciledBy, "subject-match");
    assert.equal(lanes.done[0].meta.outcome, "merged");
  });

  test("#2110: a subject match emits a merged-item-reconciled alert stamped reconciledBy=subject-match", async (t) => {
    requireEscRedis(t);

    const { id } = await escAdmin.addToBacklog({
      title: "Consolidate backlog reconciler escalation helpers",
      category: "test",
      lane: "queued",
    });

    await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        {
          ref: "pr-2201",
          blob: "fix(reconciler): consolidate the escalation helpers for the backlog sweep",
        },
      ],
      fetchMergeCommitRefs: async () => [],
      now: Date.now() + 20 * DAY,
    });

    const alerts = await escRedis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "merged-item-reconciled" && a.payload.reconciledBy === "subject-match");
    assert.equal(matching.length, 1, "subject-match reconciliation is auditable");
    assert.equal(matching[0].payload.itemId, id);
    assert.equal(matching[0].payload.reconciledFrom, "pr-2201");
  });

  test("#2110: an unrelated merged blob does NOT subject-match — genuinely stale item still escalates", async (t) => {
    requireEscRedis(t);

    const { id } = await escAdmin.addToBacklog({
      title: "Implement portfolio risk dashboard widget",
      category: "test",
      lane: "queued",
    });

    const result = await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        // Totally unrelated subject — must not spuriously cover the item title.
        { ref: "pr-2202", blob: "chore(deps): bump ioredis and update connection pooling timeouts" },
      ],
      fetchMergeCommitRefs: async () => [],
      now: Date.now() + 20 * DAY,
    });

    assert.equal(result.reconciled.length, 0, "no false subject match on unrelated work");
    assert.equal(result.escalated.length, 1, "genuinely-stale item still escalates (no regression)");
    assert.equal(result.escalated[0].id, id);

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.done.length, 0);
    assert.equal(lanes.blocked.length, 1);
  });

  test("#2110: empty merged-ref set makes the subject gate a no-op (feeds-down → still escalates)", async (t) => {
    requireEscRedis(t);

    // Feeds DOWN (null) → refs is empty → subject gate cannot fire → the stale
    // item escalates exactly as before. Preserves the feeds-down fail-closed
    // contract: a quiet/blind feed never silently reconciles work to done.
    const { id } = await escAdmin.addToBacklog({
      title: "Extract scheduler housekeeping cooldown helper",
      category: "test",
      lane: "queued",
    });

    const result = await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => null,
      fetchMergeCommitRefs: async () => null,
      now: Date.now() + 20 * DAY,
    });

    assert.equal(result.feedsAvailable, false);
    assert.equal(result.reconciled.length, 0, "no subject reconciliation when feeds are down");
    assert.equal(result.escalated.length, 1, "item escalates via the local-age signal");
    assert.equal(result.escalated[0].id, id);

    const lanes = await escAdmin.loadBacklog();
    assert.equal(lanes.done.length, 0);
    assert.equal(lanes.blocked.length, 1);
  });

  test("#2110: token-match + subject-match in one run keep the #2057 metric invariant (referencesFound counts subject closures)", async (t) => {
    requireEscRedis(t);

    // Item A ships under a TOKEN ref (counted by the token scan); item B ships
    // under a RENAMED subject with no token (counted only by the escalation-pass
    // subject gate). Both reconcile to done in the same run. The #2057 invariant
    // `reconciled.length === referencesFound - movesFailed` must hold across BOTH
    // closure paths — before the fix, referencesFound omitted the subject closure
    // and undercounted (1 vs reconciled.length 2), misreporting production health.
    const { id: tokenId } = await escAdmin.addToBacklog({
      title: "Wire arbitrage scanner output feed",
      category: "test",
      lane: "queued",
    });
    const { id: subjectId } = await escAdmin.addToBacklog({
      title: "Extract scheduler housekeeping cooldown helper",
      category: "test",
      lane: "queued",
    });

    const result = await escAdmin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-3100", blob: `feat(scanner): wire output feed (${tokenId})\ncloses ${tokenId}` },
        {
          ref: "pr-3101",
          blob:
            "refactor(scheduler): extract cooldown helper from housekeeping module\n\n" +
            "Pulls the per-class cooldown logic into a pure helper for testability.",
        },
      ],
      fetchMergeCommitRefs: async () => [],
      now: Date.now() + 20 * DAY,
    });

    assert.equal(result.reconciled.length, 2, "both the token-match and subject-match items reconcile");
    assert.equal(result.metrics.movesFailed, 0, "no failed moves in this scenario");
    assert.equal(
      result.metrics.referencesFound,
      result.reconciled.length,
      "referencesFound must count subject closures too (#2057 invariant across both paths)",
    );
    assert.equal(
      result.reconciled.length,
      result.metrics.referencesFound - result.metrics.movesFailed,
      "#2057 invariant: reconciled.length === referencesFound - movesFailed",
    );

    const ids = result.reconciled.map((r: { id: string }) => r.id).sort();
    assert.deepEqual(ids, [tokenId, subjectId].sort(), "both items present in the unified reconciled list");
  });
});
