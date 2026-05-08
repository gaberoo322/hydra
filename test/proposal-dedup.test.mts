/**
 * Regression test for proposal deduplication and impact measurement (issue #149).
 *
 * Bug: The proposals system had no automated deduplication, allowing duplicate
 * proposals to pile up. Also no feedback loop to measure whether applied
 * proposals actually improved metrics.
 *
 * Fix: createProposal() now checks title+targetFile against proposals from
 * the last 30 days. approveProposal() captures pre-application metrics.
 * checkProposalImpact() measures post-application delta after 3+ cycles.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

const TEST_PREFIX = "hydra:proposals:";

async function cleanProposalKeys() {
  const keys = await redis.keys(`${TEST_PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
}

describe("proposal deduplication (issue #149)", () => {
  let createProposal: any;
  let checkDuplicate: any;
  let titleOverlap: any;
  let getProposalHash: any;
  let saveProposalHash: any;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      const proposals = await import("../src/proposals.ts");
      createProposal = proposals.createProposal;
      checkDuplicate = proposals.checkDuplicate;
      titleOverlap = proposals.titleOverlap;
      const adapter = await import("../src/redis-adapter.ts");
      getProposalHash = adapter.getProposalHash;
      saveProposalHash = adapter.saveProposalHash;
    }
    await cleanProposalKeys();
  });

  after(async () => {
    if (redis) {
      await cleanProposalKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // titleOverlap unit tests
  // ---------------------------------------------------------------------------

  test("titleOverlap returns 1.0 for identical titles", () => {
    assert.equal(titleOverlap("Improve executor feedback", "Improve executor feedback"), 1.0);
  });

  test("titleOverlap returns 0 for completely different titles", () => {
    assert.equal(titleOverlap("alpha beta gamma", "delta epsilon zeta"), 0);
  });

  test("titleOverlap returns >0.7 for high overlap", () => {
    const overlap = titleOverlap(
      "Improve executor error handling",
      "Improve executor error recovery",
    );
    // 3 of 4 words match (improve, executor, error) = 75%
    assert.ok(overlap > 0.7, `expected >0.7, got ${overlap}`);
  });

  test("titleOverlap handles empty strings", () => {
    assert.equal(titleOverlap("", "something"), 0);
    assert.equal(titleOverlap("something", ""), 0);
    assert.equal(titleOverlap("", ""), 0);
  });

  // ---------------------------------------------------------------------------
  // AC1: duplicate rejection
  // ---------------------------------------------------------------------------

  test("duplicate proposal is rejected with clear reason", async () => {
    // Create the first proposal
    const first = await createProposal(
      { title: "Add retry logic to executor", targetFile: "agents/executor", type: "personality", risk: "low" },
      "test-corr-1",
      null,
    );
    assert.ok(first.proposalId, "first proposal should be created");
    assert.equal(first.status, "pending");

    // Attempt to create a near-duplicate
    const dup = await createProposal(
      { title: "Add retry logic to the executor agent", targetFile: "agents/executor", type: "personality", risk: "low" },
      "test-corr-2",
      null,
    );
    assert.equal(dup.dedupRejected, true, "duplicate should be rejected");
    assert.ok(dup.rejectionReason.includes("Duplicate of proposal"), `reason should mention duplicate: ${dup.rejectionReason}`);
    assert.equal(dup.proposalId, null, "rejected proposals have no proposalId");
  });

  test("proposal with different title passes dedup", async () => {
    await createProposal(
      { title: "Add retry logic to executor", targetFile: "agents/executor", type: "personality", risk: "low" },
      "test-corr-1",
      null,
    );

    const different = await createProposal(
      { title: "Improve planner scope validation", targetFile: "agents/planner", type: "personality", risk: "low" },
      "test-corr-2",
      null,
    );
    assert.ok(different.proposalId, "different proposal should be created");
    assert.equal(different.dedupRejected, undefined, "should not be dedup-rejected");
  });

  test("old proposals (>30 days) do not trigger dedup", async () => {
    // Manually create a proposal with an old timestamp in the index
    const oldId = "proposal-old-test-0001";
    const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
    await saveProposalHash(oldId, {
      proposalId: oldId,
      title: "Add retry logic to executor",
      targetFile: "agents/executor",
      type: "personality",
      risk: "low",
      status: "pending",
      createdAt: new Date(oldTimestamp).toISOString(),
    });
    // Override the index score to the old timestamp
    await redis.zadd("hydra:proposals:index", oldTimestamp, oldId);

    // Now create the "same" proposal — should pass because old one is >30 days
    const newProposal = await createProposal(
      { title: "Add retry logic to executor", targetFile: "agents/executor", type: "personality", risk: "low" },
      "test-corr-3",
      null,
    );
    assert.ok(newProposal.proposalId, "should not be blocked by 31-day-old proposal");
    assert.equal(newProposal.dedupRejected, undefined);
  });

  // ---------------------------------------------------------------------------
  // AC2: pre-metrics snapshot structure
  // ---------------------------------------------------------------------------

  test("captureMetricsSnapshot returns expected shape", async () => {
    const { captureMetricsSnapshot } = await import("../src/proposals.ts");
    const snapshot = await captureMetricsSnapshot();
    assert.ok("mergeRate" in snapshot, "should have mergeRate");
    assert.ok("failureRate" in snapshot, "should have failureRate");
    assert.ok("avgDuration" in snapshot, "should have avgDuration");
    assert.ok("capturedAt" in snapshot, "should have capturedAt");
    assert.equal(typeof snapshot.mergeRate, "number");
    assert.equal(typeof snapshot.failureRate, "number");
    assert.equal(typeof snapshot.avgDuration, "number");
    // capturedAt should be a valid ISO timestamp
    assert.ok(!isNaN(Date.parse(snapshot.capturedAt)), "capturedAt should be valid ISO");
  });

  // ---------------------------------------------------------------------------
  // checkDuplicate edge cases
  // ---------------------------------------------------------------------------

  test("checkDuplicate returns { duplicate: false } when no proposals exist", async () => {
    const result = await checkDuplicate("Brand new proposal", "agents/planner");
    assert.equal(result.duplicate, false);
  });

  test("checkDuplicate requires targetFile match when both present", async () => {
    await createProposal(
      { title: "Add retry logic to executor", targetFile: "agents/executor", type: "personality", risk: "low" },
      "test-corr-1",
      null,
    );

    // Same title but different targetFile — should not be a duplicate
    const result = await checkDuplicate("Add retry logic to executor", "agents/planner");
    assert.equal(result.duplicate, false, "different targetFile should not be duplicate");
  });
});
