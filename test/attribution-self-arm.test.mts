/**
 * Attribution self-arm leaf (issue #3078, extracted in #3639).
 *
 * These tests exercise `selfArmConfirmedMergedPr` at its OWN narrow boundary —
 * one confirmed-merged PR + a tick-local pending Set + injected `wasEnrolled` /
 * `armPending` — with NO cycle-hash enrichment context (no recordCycle mock, no
 * getMetrics stub, no gh-view fetch). This is the locality win the #3639
 * extraction buys: the arm policy is testable in isolation from the enrichment
 * chore. Pure per-case fixtures, self-contained top-level suite (per the CLAUDE.md
 * shared-Redis-teardown authoring rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  selfArmConfirmedMergedPr,
  isSentinelReconcileAnchorType,
  type AttributionSelfArmDeps,
} from "../src/scheduler/chores/attribution-self-arm.ts";
import type { PendingEnrollEntry } from "../src/redis/holdback-merge-watch.ts";

/** A spy dep-set backed by an in-memory arm log + an enrolled Set. */
function makeDeps(over: {
  enrolled?: Set<number>;
  armImpl?: AttributionSelfArmDeps["armPending"];
  wasEnrolledImpl?: AttributionSelfArmDeps["wasEnrolled"];
} = {}): { deps: AttributionSelfArmDeps; arms: PendingEnrollEntry[] } {
  const enrolled = over.enrolled ?? new Set<number>();
  const arms: PendingEnrollEntry[] = [];
  const deps: AttributionSelfArmDeps = {
    wasEnrolled: over.wasEnrolledImpl ?? (async (pr) => enrolled.has(pr)),
    armPending:
      over.armImpl ??
      (async (entry) => {
        arms.push(entry);
        return { ok: true };
      }),
  };
  return { deps, arms };
}

describe("attribution-self-arm — selfArmConfirmedMergedPr (#3639 extraction)", () => {
  test("arms an unregistered, un-enrolled PR and mutates the tick-local pending Set", async () => {
    const { deps, arms } = makeDeps();
    const pending = new Set<number>();
    const outcome = await selfArmConfirmedMergedPr(
      { prNumber: 100, cycleId: "c1" },
      pending,
      deps,
    );
    assert.equal(outcome, "armed");
    assert.equal(arms.length, 1);
    assert.equal(arms[0].prNumber, 100);
    assert.equal(arms[0].cycleId, "c1");
    assert.equal(arms[0].tier, null, "tier is null — enrollHoldback resolves it server-side");
    assert.equal(arms[0].anchorType, undefined, "no hash anchorType ⇒ omitted");
    assert.ok(pending.has(100), "same-tick double-arm guard: prNumber added to the Set");
  });

  test("skips a PR already present in the pending Set (idempotent, no arm)", async () => {
    const { deps, arms } = makeDeps();
    const pending = new Set<number>([200]);
    const outcome = await selfArmConfirmedMergedPr({ prNumber: 200, cycleId: "c2" }, pending, deps);
    assert.equal(outcome, "skipped");
    assert.equal(arms.length, 0);
  });

  test("skips a PR already enrolled-marked", async () => {
    const { deps, arms } = makeDeps({ enrolled: new Set([300]) });
    const outcome = await selfArmConfirmedMergedPr({ prNumber: 300, cycleId: "c3" }, new Set(), deps);
    assert.equal(outcome, "skipped");
    assert.equal(arms.length, 0);
  });

  test("forwards a genuine hash anchorType verbatim onto the arm entry (#3579)", async () => {
    const { deps, arms } = makeDeps();
    await selfArmConfirmedMergedPr(
      { prNumber: 150, cycleId: "c-disc", hashAnchorType: "discover" },
      new Set(),
      deps,
    );
    assert.equal(arms[0].anchorType, "discover", "the real lane rides onto the entry, never a hardcoded work-queue");
  });

  test("trims a padded anchorType and omits a whitespace-only one (#3579)", async () => {
    const { deps, arms } = makeDeps();
    await selfArmConfirmedMergedPr({ prNumber: 160, cycleId: "c-pad", hashAnchorType: "  grill  " }, new Set(), deps);
    await selfArmConfirmedMergedPr({ prNumber: 161, cycleId: "c-blank", hashAnchorType: "   " }, new Set(), deps);
    assert.equal(arms.find((a) => a.prNumber === 160)?.anchorType, "grill");
    assert.equal(arms.find((a) => a.prNumber === 161)?.anchorType, undefined);
  });

  test("omits a stored sentinel anchorType so merge-watch re-decodes, not re-bakes (#3604)", async () => {
    const { deps, arms } = makeDeps();
    await selfArmConfirmedMergedPr(
      { prNumber: 170, cycleId: "c-sentinel", hashAnchorType: "unclassified" },
      new Set(),
      deps,
    );
    assert.equal(arms[0].anchorType, undefined, "the unclassified sentinel is dropped from the entry");
  });

  test("a pendingEnrollAdd non-ok result is reported as 'failed' and the Set is NOT mutated", async () => {
    const { deps } = makeDeps({ armImpl: async () => ({ ok: false, error: "redis down" }) });
    const pending = new Set<number>();
    const outcome = await selfArmConfirmedMergedPr({ prNumber: 500, cycleId: "c-fail" }, pending, deps);
    assert.equal(outcome, "failed");
    assert.ok(!pending.has(500), "a failed arm never adds to the tick-local Set");
  });

  test("a THROWN armPending is caught and reported as 'failed' (never-throws)", async () => {
    const { deps } = makeDeps({
      armImpl: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await selfArmConfirmedMergedPr({ prNumber: 501, cycleId: "c-throw" }, new Set(), deps);
    assert.equal(outcome, "failed");
  });

  test("a THROWN wasEnrolled fails closed to 'skipped' (never double-arms on unknown state)", async () => {
    const { deps, arms } = makeDeps({
      wasEnrolledImpl: async () => {
        throw new Error("enrolled-check down");
      },
    });
    const outcome = await selfArmConfirmedMergedPr({ prNumber: 502, cycleId: "c-encheck" }, new Set(), deps);
    assert.equal(outcome, "skipped", "unknown enrolled state ⇒ skip, not arm");
    assert.equal(arms.length, 0);
  });
});

describe("attribution-self-arm — isSentinelReconcileAnchorType", () => {
  test("classifies unclassified/unknown/empty as sentinels and a real lane as genuine", () => {
    assert.equal(isSentinelReconcileAnchorType("unclassified"), true);
    assert.equal(isSentinelReconcileAnchorType("UNKNOWN"), true, "case-insensitive");
    assert.equal(isSentinelReconcileAnchorType(""), true);
    assert.equal(isSentinelReconcileAnchorType("dev_orch"), false);
    assert.equal(isSentinelReconcileAnchorType("grill"), false);
  });
});
