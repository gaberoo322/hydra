/**
 * Operator Channel Redis accessor (`src/redis/operator-channel.ts`, issue
 * #5045): dedup hash round-trip with TTL, suppression counter, brief list and
 * delivery log. Uses sentinel dedup keys so it never disturbs real state.
 *
 * REDIS_URL is set by the test launcher to a per-worktree DB (never DB 0).
 */

import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const acc = await import("../src/redis/operator-channel.ts");

const KEYS = ["sentinel:a", "sentinel:b"];

describe("redis/operator-channel accessor", () => {
  let raw: any;

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  beforeEach(async () => {
    for (const k of KEYS) await acc.delDedup(k);
    await raw.del(acc.BRIEF_ITEMS_KEY, acc.DELIVERY_LOG_KEY, acc.BRIEF_LAST_SENT_KEY);
  });

  after(async () => {
    for (const k of KEYS) await acc.delDedup(k);
    await raw.del(acc.BRIEF_ITEMS_KEY, acc.DELIVERY_LOG_KEY, acc.BRIEF_LAST_SENT_KEY);
    await raw.quit();
  });

  test("an absent key reads as null", async () => {
    assert.equal(await acc.readDedup("sentinel:a"), null);
  });

  test("writeDedup round-trips numbers and stamps a 7-day TTL", async () => {
    await acc.writeDedup("sentinel:a", { state: "bad", firstAt: 10, lastSentAt: 20, suppressed: 0 });
    assert.deepEqual(await acc.readDedup("sentinel:a"), { state: "bad", firstAt: 10, lastSentAt: 20, suppressed: 0 });
    const ttl = await raw.ttl(acc.dedupKeyFor("sentinel:a"));
    assert.ok(ttl > 6 * 24 * 3600 && ttl <= acc.DEDUP_TTL_SECONDS, `ttl ${ttl}`);
  });

  test("incrSuppressed bumps the counter and refreshes the TTL", async () => {
    await acc.writeDedup("sentinel:a", { state: "bad", firstAt: 1, lastSentAt: 1, suppressed: 0 });
    await raw.expire(acc.dedupKeyFor("sentinel:a"), 100);
    await acc.incrSuppressed("sentinel:a");
    await acc.incrSuppressed("sentinel:a");
    assert.equal((await acc.readDedup("sentinel:a"))?.suppressed, 2);
    assert.ok((await raw.ttl(acc.dedupKeyFor("sentinel:a"))) > 1000, "TTL refreshed on touch");
  });

  test("delDedup clears the key", async () => {
    await acc.writeDedup("sentinel:b", { state: "bad", firstAt: 1, lastSentAt: 1, suppressed: 0 });
    await acc.delDedup("sentinel:b");
    assert.equal(await acc.readDedup("sentinel:b"), null);
  });

  test("appendBrief and appendLog are newest-first and bounded to 500", async () => {
    for (let i = 0; i < 503; i++) await acc.appendBrief({ kind: "cycle:completed", n: i });
    const items = await acc.readBriefItems();
    assert.equal(items.length, 500);
    assert.equal(items[0].n, 502);

    await acc.appendLog({ at: 1, kind: "page", dedupKey: "sentinel:a", title: "t", outcome: "sent-html" });
    await acc.appendLog({ at: 2, kind: "recovered", dedupKey: "sentinel:a", title: "t", outcome: "failed", status: 500 });
    const log = await acc.readDeliveryLog();
    assert.deepEqual(log.map((e) => e.kind), ["recovered", "page"]);
  });

  test("key names are the documented constants", () => {
    assert.equal(acc.BRIEF_ITEMS_KEY, "hydra:operator-channel:brief:items");
    assert.equal(acc.DELIVERY_LOG_KEY, "hydra:operator-channel:delivery-log");
    assert.equal(acc.BRIEF_LAST_SENT_KEY, "hydra:operator-channel:brief:last-sent");
    assert.equal(acc.dedupKeyFor("x:y"), "hydra:operator-channel:dedup:x:y");
  });

  test("the brief last-sent key round-trips epoch ms and reads null when absent or corrupt", async () => {
    assert.equal(await acc.getBriefLastSent(), null);
    await acc.setBriefLastSent(1_792_500_000_000);
    assert.equal(await acc.getBriefLastSent(), 1_792_500_000_000);
    assert.equal(await raw.get(acc.BRIEF_LAST_SENT_KEY), "1792500000000", "stored as a plain epoch-ms string");
    await raw.set(acc.BRIEF_LAST_SENT_KEY, "not-a-number");
    assert.equal(await acc.getBriefLastSent(), null);
    assert.deepEqual(Object.keys(acc.redisBriefStore).sort(), ["getLastSent", "setLastSent"]);
  });

  test("listDedupStates returns the bad keys with their suppressed counts and never mutates them", async () => {
    await acc.writeDedup("sentinel:a", { state: "bad", firstAt: 10, lastSentAt: 20, suppressed: 3 });
    await acc.writeDedup("sentinel:b", { state: "bad", firstAt: 30, lastSentAt: 30, suppressed: 0 });
    const before = await Promise.all(KEYS.map((k) => raw.hgetall(acc.dedupKeyFor(k))));
    const ttlBefore = await raw.ttl(acc.dedupKeyFor("sentinel:a"));

    const rows = (await acc.listDedupStates()).filter((r) => r.dedupKey.startsWith("sentinel:"));
    assert.deepEqual(rows, [
      { dedupKey: "sentinel:a", state: "bad", firstAt: 10, lastSentAt: 20, suppressed: 3 },
      { dedupKey: "sentinel:b", state: "bad", firstAt: 30, lastSentAt: 30, suppressed: 0 },
    ]);

    const after = await Promise.all(KEYS.map((k) => raw.hgetall(acc.dedupKeyFor(k))));
    assert.deepEqual(after, before, "the SCAN is read-only");
    assert.ok((await raw.ttl(acc.dedupKeyFor("sentinel:a"))) <= ttlBefore, "no TTL refresh");
    await acc.delDedup("sentinel:a");
    assert.deepEqual((await acc.listDedupStates()).filter((r) => r.dedupKey.startsWith("sentinel:")).map((r) => r.dedupKey), ["sentinel:b"]);
  });
});
