/**
 * Lifecycle journal + dispatch-claim Redis seam (ADR-0047 D5, issue #5310).
 * Uses Redis DB 1 — never touches production (DB 0).
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

import {
  LIFECYCLE_JOURNAL_MAX_ENTRIES,
  appendLifecycleEntry,
  closeDispatchClaim,
  expireJournalOnClose,
  journalCloseTtlSeconds,
  lifecycleClaimKey,
  lifecycleJournalKey,
  openDispatchClaim,
  persistJournal,
  readDispatchClaim,
  readLifecycleJournal,
  type LifecycleJournalEntry,
} from "../src/redis/lifecycle-journal.ts";

const REPO = "test-owner/lifecycle-journal-test";
const ISSUE = 987654;

function entry(over: Partial<LifecycleJournalEntry> = {}): LifecycleJournalEntry {
  return {
    v: 1, ts: 1_750_000_000_000, kind: "transition", from: "ready-for-agent", to: "in-progress",
    source: "cli", actor: "test", evidence: {}, reason: null, rationale: null, result: "ok", written: true,
    ...over,
  };
}

describe("lifecycle-journal Redis seam (issue #5310)", () => {
  let redis: any;
  const cleanup = async () => {
    await redis.del(lifecycleJournalKey(REPO, ISSUE), lifecycleClaimKey(REPO, ISSUE));
  };

  before(() => {
    redis = new Redis(REDIS_URL);
  });
  beforeEach(cleanup);
  after(async () => {
    await cleanup();
    await redis.quit();
  });

  test("key shapes carry repo and issue", () => {
    assert.equal(lifecycleJournalKey("o/r", 7), "hydra:lifecycle:journal:o/r#7");
    assert.equal(lifecycleClaimKey("o/r", 7), "hydra:lifecycle:claim:o/r#7");
  });

  test("append is RPUSH + LTRIM and carries no TTL while open", async () => {
    const res = await appendLifecycleEntry(REPO, ISSUE, entry({ kind: "refused", result: "shadow-would-refuse:x" }));
    assert.equal(res.ok, true);
    const read = await readLifecycleJournal(REPO, ISSUE);
    assert.equal(read.ok && read.entries.length, 1);
    assert.equal(read.ok && read.entries[0].result, "shadow-would-refuse:x");
    assert.equal(await redis.ttl(lifecycleJournalKey(REPO, ISSUE)), -1);
  });

  test("journal is bounded to the newest 500 entries", async () => {
    for (let i = 0; i < LIFECYCLE_JOURNAL_MAX_ENTRIES + 5; i++) {
      await appendLifecycleEntry(REPO, ISSUE, entry({ ts: i }));
    }
    const read = await readLifecycleJournal(REPO, ISSUE);
    assert.ok(read.ok);
    assert.equal(read.entries.length, LIFECYCLE_JOURNAL_MAX_ENTRIES);
    assert.equal(read.entries[0].ts, 5);
    assert.equal(read.entries[read.entries.length - 1].ts, LIFECYCLE_JOURNAL_MAX_ENTRIES + 4);
  });

  test("expireJournalOnClose sets 180d and persistJournal clears it", async () => {
    await appendLifecycleEntry(REPO, ISSUE, entry());
    assert.equal(journalCloseTtlSeconds(), 15552000);
    await expireJournalOnClose(REPO, ISSUE);
    const ttl = await redis.ttl(lifecycleJournalKey(REPO, ISSUE));
    assert.ok(ttl > 15552000 - 60 && ttl <= 15552000, `ttl ${ttl}`);
    await persistJournal(REPO, ISSUE);
    assert.equal(await redis.ttl(lifecycleJournalKey(REPO, ISSUE)), -1);
  });

  test("a malformed journal row is skipped, not fatal", async () => {
    await redis.rpush(lifecycleJournalKey(REPO, ISSUE), "{not json");
    await appendLifecycleEntry(REPO, ISSUE, entry());
    const read = await readLifecycleJournal(REPO, ISSUE);
    assert.ok(read.ok);
    assert.equal(read.entries.length, 1);
  });

  test("claim is SET NX with no TTL; a second open fails and does not overwrite", async () => {
    const first = { dispatchId: "d1", class: "dev_orch", run: "r1", artifactHash: null, openedAt: 1 };
    const second = { ...first, dispatchId: "d2" };
    const a = await openDispatchClaim(REPO, ISSUE, first);
    assert.equal(a.ok, true);
    assert.equal(await redis.ttl(lifecycleClaimKey(REPO, ISSUE)), -1);
    const b = await openDispatchClaim(REPO, ISSUE, second);
    assert.equal(b.ok, false);
    assert.equal(!b.ok && b.code, "claim-held");
    assert.equal(!b.ok && b.code === "claim-held" && b.existing?.dispatchId, "d1");
  });

  test("a ttlSeconds claim gets an expiry and is still SET NX; an invalid ttl falls back to no TTL", async () => {
    const claim = { dispatchId: "d1", class: "dev_orch", run: "r1", artifactHash: null, openedAt: 1 };
    assert.equal((await openDispatchClaim(REPO, ISSUE, claim, 600)).ok, true);
    const ttl = await redis.ttl(lifecycleClaimKey(REPO, ISSUE));
    assert.ok(ttl > 0 && ttl <= 600, `ttl=${ttl}`);
    const second = await openDispatchClaim(REPO, ISSUE, { ...claim, dispatchId: "d2" }, 600);
    assert.equal(!second.ok && second.code, "claim-held");
    await closeDispatchClaim(REPO, ISSUE, "d1");
    assert.equal((await openDispatchClaim(REPO, ISSUE, claim, -5)).ok, true);
    assert.equal(await redis.ttl(lifecycleClaimKey(REPO, ISSUE)), -1);
  });

  test("closeDispatchClaim returns the prior claim and frees the key", async () => {
    const claim = { dispatchId: "d1", class: "qa_orch", run: "r1", artifactHash: "abc", openedAt: 1 };
    await openDispatchClaim(REPO, ISSUE, claim);
    const closed = await closeDispatchClaim(REPO, ISSUE, "d1");
    assert.ok(closed.ok);
    assert.equal(closed.prior?.dispatchId, "d1");
    assert.equal(await redis.exists(lifecycleClaimKey(REPO, ISSUE)), 0);
    const again = await closeDispatchClaim(REPO, ISSUE, "d1");
    assert.ok(again.ok);
    assert.equal(again.prior, null);
  });

  test("readDispatchClaim reads without modifying the held claim", async () => {
    const none = await readDispatchClaim(REPO, ISSUE);
    assert.deepEqual(none, { ok: true, claim: null });
    const claim = { dispatchId: "d1", class: "qa_orch", run: "r1", artifactHash: null, openedAt: 1 };
    await openDispatchClaim(REPO, ISSUE, claim);
    const held = await readDispatchClaim(REPO, ISSUE);
    assert.deepEqual(held, { ok: true, claim });
    assert.equal(await redis.exists(lifecycleClaimKey(REPO, ISSUE)), 1);
  });

  test("closeDispatchClaim with expectedDispatchId only deletes an owned claim (atomic)", async () => {
    const claim = { dispatchId: "d1", class: "qa_orch", run: "r1", artifactHash: null, openedAt: 1 };
    await openDispatchClaim(REPO, ISSUE, claim);
    const wrong = await closeDispatchClaim(REPO, ISSUE, "d2");
    assert.equal(wrong.ok, false);
    assert.equal(await redis.exists(lifecycleClaimKey(REPO, ISSUE)), 1);
    const right = await closeDispatchClaim(REPO, ISSUE, "d1");
    assert.ok(right.ok);
    assert.equal(right.prior?.dispatchId, "d1");
    assert.equal(await redis.exists(lifecycleClaimKey(REPO, ISSUE)), 0);
  });
});

describe("operator ruling round 4 (#5310): release requires --dispatch (INV-11)", () => {
  let redis: any;
  before(async () => { redis = new Redis(REDIS_URL); });
  after(async () => { await redis.quit(); });

  test("closeDispatchClaim with an empty dispatch id never deletes the claim", async () => {
    await redis.del(lifecycleClaimKey(REPO, ISSUE));
    await openDispatchClaim(REPO, ISSUE, { dispatchId: "d1", class: "dev_orch", run: "r1", artifactHash: null, openedAt: 1 });
    const res = await closeDispatchClaim(REPO, ISSUE, "");
    assert.equal(res.ok, false);
    assert.equal(await redis.exists(lifecycleClaimKey(REPO, ISSUE)), 1);
    await redis.del(lifecycleClaimKey(REPO, ISSUE));
  });

  test("CLI release without --dispatch exits 2 and the claim survives", async () => {
    const { main } = await import("../scripts/lifecycle.ts");
    const { resolveGithubRepo } = await import("../src/github/issues.ts");
    const repo = resolveGithubRepo();
    const issue = 987655;
    await redis.del(lifecycleClaimKey(repo, issue));
    await openDispatchClaim(repo, issue, { dispatchId: "d1", class: "dev_orch", run: "r1", artifactHash: null, openedAt: 1 });
    try {
      assert.equal(await main(["release", String(issue)]), 2);
      assert.equal(await redis.exists(lifecycleClaimKey(repo, issue)), 1);
    } finally {
      await redis.del(lifecycleClaimKey(repo, issue));
    }
  });
});
