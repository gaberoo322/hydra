/**
 * Issue #3390 — anchor classification 15% unclassified rate.
 *
 * The live 50-cycle sample carried ~29 metrics records stuck in the
 * `unclassified` bucket. Diagnosis against production Redis showed two DISTINCT
 * families of unclassified record, both with a DECODABLE cycleId that the
 * classifier was rejecting:
 *
 *   (A) inference gaps — `inferAnchorTypeFromCycleId` hard-anchored the slot on
 *       `_(orch|target)$`, so it rejected:
 *         - the two real taxonomy classes with NO `_orch`/`_target` suffix
 *           (`skill_prune`, `health`) — e.g. `…-t2-skill_prune`; and
 *         - a trailing `-<suffix>` after the slot — e.g. `…-t5-dev_orch-3170`,
 *           `a664419f-t1-dev_orch-3104` — which the end-anchored `$` rejected.
 *       The slot is now resolved against the taxonomy class alphabet
 *       (`SLOT_ANCHOR_TYPE`) rather than a structural suffix, and a trailing
 *       suffix is tolerated. The mandatory `-t{N}-` fence is unchanged, so the
 *       #2822 safety negatives (bare UUIDs, harness `worktree-agent-<longhash>`
 *       branches) are preserved.
 *
 *   (B) read-path recovery — a follow-up write (the phase-6 merged-cycle
 *       enrichment / cycle-merge-reconcile) often lands the FIRST record for a
 *       cycleId while omitting anchorType, and at write time the pre-#3390
 *       classifier could not decode the cycleId, so the record persisted as
 *       `unclassified`. `getMetricsTrend` now re-infers from the cycleId when
 *       the stored anchorType is the `unclassified`/`unknown` sentinel — so
 *       already-persisted rows surface in their real lane WITHOUT a Redis
 *       backfill migration.
 *
 * Uses Redis DB 1 for the read-path round-trip — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const { inferAnchorTypeFromCycleId, classifyAnchorType, UNCLASSIFIED_ANCHOR_TYPE } =
  await import("../src/autopilot/anchor-type.ts");
const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getMetricsTrend } = await import("../src/metrics/trend.ts");

describe("inferAnchorTypeFromCycleId — decodes suffix-less + trailing-suffix slots (#3390)", () => {
  // (A) Previously unclassified BUT decodable — the fix must now resolve these.
  const NOW_DECODABLE: ReadonlyArray<readonly [string, string]> = [
    // Real taxonomy classes with no `_orch`/`_target` suffix.
    ["41bbe60d-0f62-499a-b324-ef3d8eeaffff-t2-skill_prune", "skill-prune"],
    ["worktree-agent-deadbeef-t1-skill_prune", "skill-prune"],
    // A trailing `-<issue>`/`-<pr>` suffix after the slot.
    ["e3aedd6b-t5-dev_orch-3170", "work-queue"],
    ["a664419f-t1-dev_orch-3104", "work-queue"],
    ["worktree-agent-568fde2a-t3-cleanup_orch-2200", "cleanup"],
    // A full-UUID run-token prefix (hyphens inside the token before `-t{N}-`).
    ["41bbe60d-0f62-499a-b324-ef3d8eeaffff-t2-qa_orch", "qa-review"],
  ];

  for (const [cycleId, expected] of NOW_DECODABLE) {
    test(`'${cycleId}' → ${expected}`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), expected);
      // classifyAnchorType (no explicit anchorType supplied) must agree.
      assert.equal(classifyAnchorType(cycleId, undefined), expected);
    });
  }

  test("a trailing suffix does not change the resolved lane vs the bare slot", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("e3aedd6b-t5-dev_orch-3170"),
      inferAnchorTypeFromCycleId("e3aedd6b-t5-dev_orch"),
    );
  });

  // (A) Safety fence — the widened parser must STILL reject every non-dispatch
  // id and the harness's own branch names. If any goes non-undefined, the fence
  // is too loose.
  const SENTINEL_IDS = [
    "worktree-agent-ab501d7d0f2c6aab8", // harness branch, no -t{N}- middle
    "worktree-agent-a4f8a3811688505c3",
    "hydra-dev", // skill-name cycleId
    "dev_orch", // bare class name, no -t{N}- fence
    "b8a3071f-a783-4812-bec5-8fa0f5079a08", // bare UUID
    "b17ee362-3c54-4b5c-8707-8565b0cc9498-t3", // -t3 with no slot tail
    "c6db11dc-t3-pr3326", // `pr3326` is not a class
    "c116d6f7-t1-issue-3212", // `issue` is not a class
    "autopilot-d6706178-3079",
    "issue-3114",
    "6fd1300b-t1-unknown_class", // prefix-less but unmapped slot
  ];

  for (const cycleId of SENTINEL_IDS) {
    test(`'${cycleId}' stays undefined (safety fence preserved)`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }
});

describe("getMetricsTrend — re-infers a stored `unclassified` record from its cycleId (#3390)", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("a decodable cycleId stored as `unclassified` surfaces in its real lane", async () => {
    // Simulate the phase-6 follow-up write shape: a record keyed on the
    // synthesised worktree branch, whose stored anchorType was `unclassified`
    // (the writer omitted it and the pre-#3390 classifier could not decode the
    // cycleId — but this shape carries a trailing PR suffix the widened parser
    // now decodes).
    const cycleId = "worktree-agent-15dc1488-t3-dev_orch-3348";
    await recordCycleMetrics(cycleId, {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      prNumber: "3348",
      tasksMerged: 1,
    });

    const trend = await getMetricsTrend(10);
    const row = trend.find((r) => r.cycleId === cycleId);
    assert.ok(row, "the recorded cycle is present in the trend");
    assert.equal(
      row!.anchorType,
      "work-queue",
      "the read path re-inferred the real lane from the cycleId",
    );
  });

  test("a truly un-inferrable `unclassified` cycleId stays unclassified", async () => {
    // The harness's own branch name carries no slot — it must NOT be forced
    // into a bucket; `unclassified` is the honest, visible data-quality state.
    const cycleId = "worktree-agent-ab501d7d0f2c6aab8";
    await recordCycleMetrics(cycleId, {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      prNumber: "3348",
      tasksMerged: 1,
    });

    const trend = await getMetricsTrend(10);
    const row = trend.find((r) => r.cycleId === cycleId);
    assert.ok(row, "the recorded cycle is present in the trend");
    assert.equal(
      row!.anchorType,
      UNCLASSIFIED_ANCHOR_TYPE,
      "an un-inferrable cycleId is not fabricated into a lane",
    );
  });

  test("a genuine stored anchorType is never overwritten by cycleId inference", async () => {
    // Even if the cycleId would infer `work-queue`, an explicitly-stored lane
    // (e.g. a research cycle recorded under a dev-shaped relay id) wins — the
    // recovery only fires for the sentinel buckets.
    const cycleId = "worktree-agent-15dc1488-t3-dev_orch";
    await recordCycleMetrics(cycleId, {
      anchorType: "research",
      tasksMerged: 1,
    });

    const trend = await getMetricsTrend(10);
    const row = trend.find((r) => r.cycleId === cycleId);
    assert.ok(row, "the recorded cycle is present in the trend");
    assert.equal(row!.anchorType, "research", "the stored lane is preserved");
  });
});
