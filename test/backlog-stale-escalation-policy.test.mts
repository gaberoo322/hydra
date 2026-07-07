/**
 * Unit tests for the pure stale-claim escalation POLICY leaf (issue #2973).
 *
 * `src/backlog/stale-escalation-policy.ts` (issue #2678) is the zero-I/O leaf
 * extracted from the Redis coordinator `src/backlog/stale-escalation.ts`. It
 * owns the pure escalation decision: `itemAgeMs` (oldest-known-timestamp age)
 * and `staleEscalationVerdict` (the escalate predicate). Both are pure — plain
 * item structs + an injected clock in, numbers / booleans / strings out — with
 * no Redis, no I/O, no event bus.
 *
 * Before #2973 this leaf had NO direct test at all (the coordinator half is
 * exercised by `test/backlog-stale-escalation.test.mts`, but not the pure policy
 * in isolation). This suite pins the two central design-concept invariants
 * carried over from #2031 / #2678:
 *   1. fail-open — an unageable item with a non-retired claimant is NOT escalated;
 *   2. staleness is never proof of shipment — the verdict never says "move to
 *      done", it only stamps an operator-actionable `escalate: true` + reason.
 *
 * Constants (`STALE_ESCALATE_AFTER_MS` default 14d, `RETIRED_CLAIMANTS` default
 * `codex`) are read from env at module load; these tests assert against the
 * defaults and never mutate `process.env`, so they stay hermetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  itemAgeMs,
  staleEscalationVerdict,
} from "../src/backlog/stale-escalation-policy.ts";

const NOW = Date.parse("2026-07-07T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 14 * DAY_MS; // default when HYDRA_RECONCILE_STALE_ESCALATE_MS unset

describe("stale-escalation-policy — itemAgeMs oldest-timestamp precedence (#2973)", () => {
  test("uses movedAt first when present", () => {
    const age = itemAgeMs(
      { movedAt: new Date(NOW - 5 * DAY_MS).toISOString(), claimedAt: new Date(NOW).toISOString() },
      NOW,
    );
    assert.equal(age, 5 * DAY_MS);
  });

  test("falls back to claimedAt when movedAt is absent", () => {
    const age = itemAgeMs({ claimedAt: new Date(NOW - 3 * DAY_MS).toISOString() }, NOW);
    assert.equal(age, 3 * DAY_MS);
  });

  test("falls back to meta.addedAt when movedAt and claimedAt are absent", () => {
    const age = itemAgeMs({ meta: { addedAt: new Date(NOW - 2 * DAY_MS).toISOString() } }, NOW);
    assert.equal(age, 2 * DAY_MS);
  });

  test("skips a non-string / empty timestamp and continues to the next candidate", () => {
    const age = itemAgeMs(
      { movedAt: "", claimedAt: 12345 as any, meta: { addedAt: new Date(NOW - DAY_MS).toISOString() } },
      NOW,
    );
    assert.equal(age, DAY_MS);
  });

  test("returns null when no parseable timestamp exists (unageable item)", () => {
    assert.equal(itemAgeMs({ movedAt: "not-a-date" }, NOW), null);
    assert.equal(itemAgeMs({}, NOW), null);
    assert.equal(itemAgeMs({ movedAt: undefined, claimedAt: null as any }, NOW), null);
  });
});

describe("stale-escalation-policy — retired-claimant escalation (#2973)", () => {
  test("a `codex` claimant escalates regardless of age (fresh item, still escalated)", () => {
    const v = staleEscalationVerdict(
      { claimedBy: "codex", movedAt: new Date(NOW - 60 * 1000).toISOString() },
      NOW,
    );
    assert.equal(v.escalate, true);
    assert.match(v.reason, /retired claimant/);
    assert.match(v.reason, /unconfirmable-shipped/);
  });

  test("retired-claimant match is case-insensitive and trims whitespace", () => {
    const v = staleEscalationVerdict({ claimedBy: "  CODEX  " }, NOW);
    assert.equal(v.escalate, true);
  });

  test("a live (non-retired) claimant on a fresh item does NOT escalate", () => {
    const v = staleEscalationVerdict(
      { claimedBy: "claude", movedAt: new Date(NOW - DAY_MS).toISOString() },
      NOW,
    );
    assert.equal(v.escalate, false);
    assert.equal(v.reason, "");
  });
});

describe("stale-escalation-policy — age-based escalation (#2973)", () => {
  test("an item older than 14d escalates with a day-count reason", () => {
    const v = staleEscalationVerdict(
      { movedAt: new Date(NOW - 20 * DAY_MS).toISOString() },
      NOW,
    );
    assert.equal(v.escalate, true);
    assert.match(v.reason, /no activity for 20d/);
    assert.match(v.reason, /unconfirmable-shipped/);
  });

  test("the 14d threshold is exclusive — exactly 14d does NOT escalate", () => {
    const v = staleEscalationVerdict(
      { movedAt: new Date(NOW - STALE_AFTER_MS).toISOString() },
      NOW,
    );
    assert.equal(v.escalate, false);
  });

  test("a just-under-14d item does not escalate", () => {
    const v = staleEscalationVerdict(
      { movedAt: new Date(NOW - (14 * DAY_MS - 1000)).toISOString() },
      NOW,
    );
    assert.equal(v.escalate, false);
  });
});

describe("stale-escalation-policy — fail-open + never-done invariants (#2973)", () => {
  test("an unageable item with a non-retired claimant is NOT escalated (fail-open)", () => {
    const v = staleEscalationVerdict({ claimedBy: "claude", movedAt: "garbage" }, NOW);
    assert.equal(v.escalate, false);
    assert.equal(v.reason, "");
  });

  test("no verdict ever recommends moving to done — reason only ever asks the operator to confirm", () => {
    const escalations = [
      staleEscalationVerdict({ claimedBy: "codex" }, NOW),
      staleEscalationVerdict({ movedAt: new Date(NOW - 30 * DAY_MS).toISOString() }, NOW),
    ];
    for (const v of escalations) {
      assert.equal(v.escalate, true);
      // Staleness is not proof of shipment: the verdict asks the operator to
      // confirm, it never asserts a done transition.
      assert.doesNotMatch(v.reason, /\bmove to done\b/i);
      assert.match(v.reason, /operator: confirm shipped/);
    }
  });

  test("retired-claimant check wins over age when both apply (reason cites the claimant)", () => {
    const v = staleEscalationVerdict(
      { claimedBy: "codex", movedAt: new Date(NOW - 30 * DAY_MS).toISOString() },
      NOW,
    );
    assert.equal(v.escalate, true);
    assert.match(v.reason, /retired claimant/);
  });
});
