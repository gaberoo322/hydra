/**
 * Regression tests for `recordDispatchPr` after its extraction from
 * `src/autopilot/runs.ts` into the focused sibling module
 * `src/autopilot/dispatch-pr-link.ts` (issue #3205).
 *
 * `recordDispatchPr` is the dispatch->PR link WRITE that feeds the
 * Builder-Health Scorecard's Autonomy Rate + time-to-merge (issue #732). Its
 * only live caller is `src/api/builder-health.ts`; its symmetric reader sibling
 * `listAutopilotPrLinksSince` is read from `src/aggregators/autonomy-rate.ts`.
 * The extraction is behavior-preserving — these tests pin the contract at the
 * NEW module home so a future move can't silently regress it.
 *
 * Pins:
 *   - validation: a non-positive / non-integer `prNumber` returns
 *     `{ok:false, code:"invalid"}` WITHOUT touching Redis (the pure guard).
 *   - never-throws: the merge/grounding/verification convention — errors come
 *     back as `{ok:false}` result objects.
 *   - round-trip: a valid write lands on the PR-link hash and is read back by
 *     the reader sibling `listAutopilotPrLinksSince`, preserving `prNumber` +
 *     the optional link fields, with `openedAt` parsed to epoch-ms.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

import { recordDispatchPr } from "../src/autopilot/dispatch-pr-link.ts";
import { listAutopilotPrLinksSince } from "../src/redis/autopilot-runs.ts";

describe("recordDispatchPr — validation (no Redis)", () => {
  test("rejects a non-integer prNumber with code:invalid", async () => {
    const r = await recordDispatchPr({ prNumber: 3.5 as any });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid");
  });

  test("rejects a non-positive prNumber with code:invalid", async () => {
    const r = await recordDispatchPr({ prNumber: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid");
  });

  test("rejects a NaN prNumber with code:invalid", async () => {
    const r = await recordDispatchPr({ prNumber: "not-a-number" as any });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid");
  });
});

describe("recordDispatchPr — round-trip through the reader sibling", () => {
  let redis: any;

  before(() => {
    redis = new Redis(REDIS_URL);
  });

  after(async () => {
    if (redis) {
      const keys = await redis.keys("hydra:autopilot:pr*");
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    }
  });

  test("a valid write is read back by listAutopilotPrLinksSince, fields preserved", async () => {
    // Unique high PR number so the case is isolated from any ambient data.
    const prNumber = 990000 + Math.floor(Math.random() * 9000);
    const openedAt = "2026-07-11T12:00:00.000Z";
    const openedAtMs = Date.parse(openedAt);

    const w = await recordDispatchPr({
      prNumber,
      runId: "run-3205",
      dispatchId: "dispatch-3205",
      skill: "hydra-dev",
      issueRef: "issue-3205",
      openedAt,
    });
    assert.equal(w.ok, true);
    if (w.ok) {
      assert.equal(w.prNumber, prNumber);
      assert.equal(w.openedAtMs, openedAtMs);
    }

    const links = await listAutopilotPrLinksSince(openedAtMs);
    const link = links.find((l) => l.prNumber === String(prNumber));
    assert.ok(link, "the written PR link must be readable by the reader sibling");
    assert.equal(link!.runId, "run-3205");
    assert.equal(link!.dispatchId, "dispatch-3205");
    assert.equal(link!.skill, "hydra-dev");
    assert.equal(link!.issueRef, "issue-3205");
    assert.equal(link!.openedAtMs, String(openedAtMs));
  });
});
