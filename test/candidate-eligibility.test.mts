// Candidate Eligibility seam (issue #2066) — pinned-clock unit tests for the
// two genuinely-private eligibility predicates extracted from
// `getCandidateFeed`. These need NO Redis fixture: the predicates are pure and
// take `now` as a parameter.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isInFlightPR,
  isBlockerJustCleared,
  requiresSpawnCapableDispatch,
  requiresNonPrDispatch,
  NON_PR_DELIVERABLE_LABELS,
  IN_FLIGHT_PR_FRESHNESS_MS,
  RECENT_UNBLOCK_THRESHOLD_MS,
} from "../src/backlog/candidate-eligibility.ts";

// A fixed reference clock so every test is deterministic.
const NOW = 1_700_000_000_000;

// --- isInFlightPR ----------------------------------------------------------

test("isInFlightPR: fresh pr- claim inside the window is in-flight", () => {
  const item = { claimedBy: "pr-123", claimedAt: new Date(NOW - 60_000).toISOString() };
  assert.equal(isInFlightPR(item, NOW), true);
});

test("isInFlightPR: claim exactly at the window boundary is NOT fresh (strict <)", () => {
  const item = {
    claimedBy: "pr-123",
    claimedAt: new Date(NOW - IN_FLIGHT_PR_FRESHNESS_MS).toISOString(),
  };
  assert.equal(isInFlightPR(item, NOW), false);
});

test("isInFlightPR: claim just inside the boundary is fresh", () => {
  const item = {
    claimedBy: "pr-123",
    claimedAt: new Date(NOW - (IN_FLIGHT_PR_FRESHNESS_MS - 1)).toISOString(),
  };
  assert.equal(isInFlightPR(item, NOW), true);
});

test("isInFlightPR: stale claim older than the window resurfaces", () => {
  const item = {
    claimedBy: "pr-123",
    claimedAt: new Date(NOW - (IN_FLIGHT_PR_FRESHNESS_MS + 60_000)).toISOString(),
  };
  assert.equal(isInFlightPR(item, NOW), false);
});

test("isInFlightPR: no claimedBy → not in-flight", () => {
  assert.equal(isInFlightPR({ claimedAt: new Date(NOW).toISOString() }, NOW), false);
  assert.equal(isInFlightPR({}, NOW), false);
  assert.equal(isInFlightPR(null, NOW), false);
  assert.equal(isInFlightPR(undefined, NOW), false);
});

test("isInFlightPR: non-string claimedBy → not in-flight", () => {
  const item = { claimedBy: 123 as any, claimedAt: new Date(NOW).toISOString() };
  assert.equal(isInFlightPR(item, NOW), false);
});

test("isInFlightPR: claimedBy not a pr- marker → not in-flight", () => {
  const item = { claimedBy: "agent-foo", claimedAt: new Date(NOW).toISOString() };
  assert.equal(isInFlightPR(item, NOW), false);
});

test("isInFlightPR: pr- claim with no claimedAt → not in-flight", () => {
  assert.equal(isInFlightPR({ claimedBy: "pr-123" }, NOW), false);
});

test("isInFlightPR: unparseable claimedAt → not in-flight (degrade, never throw)", () => {
  const item = { claimedBy: "pr-123", claimedAt: "not-a-date" };
  assert.equal(isInFlightPR(item, NOW), false);
});

// --- isBlockerJustCleared --------------------------------------------------

test("isBlockerJustCleared: recently-unblocked item within 24h is just-cleared", () => {
  const item = {
    meta: { blockedReason: "waiting on #42" },
    lane: "queued",
    movedAt: new Date(NOW - 60_000).toISOString(),
  };
  assert.equal(isBlockerJustCleared(item, NOW), true);
});

test("isBlockerJustCleared: move exactly at the window boundary is NOT recent (strict <)", () => {
  const item = {
    meta: { blockedReason: "waiting on #42" },
    lane: "queued",
    movedAt: new Date(NOW - RECENT_UNBLOCK_THRESHOLD_MS).toISOString(),
  };
  assert.equal(isBlockerJustCleared(item, NOW), false);
});

test("isBlockerJustCleared: move just inside the boundary is recent", () => {
  const item = {
    meta: { blockedReason: "waiting on #42" },
    lane: "queued",
    movedAt: new Date(NOW - (RECENT_UNBLOCK_THRESHOLD_MS - 1)).toISOString(),
  };
  assert.equal(isBlockerJustCleared(item, NOW), true);
});

test("isBlockerJustCleared: unblocked too long ago (>24h) is not just-cleared", () => {
  const item = {
    meta: { blockedReason: "waiting on #42" },
    lane: "queued",
    movedAt: new Date(NOW - (RECENT_UNBLOCK_THRESHOLD_MS + 60_000)).toISOString(),
  };
  assert.equal(isBlockerJustCleared(item, NOW), false);
});

test("isBlockerJustCleared: no blockedReason → never was blocked", () => {
  const item = { meta: {}, lane: "queued", movedAt: new Date(NOW).toISOString() };
  assert.equal(isBlockerJustCleared(item, NOW), false);
  assert.equal(isBlockerJustCleared({ lane: "queued", movedAt: new Date(NOW).toISOString() }, NOW), false);
});

test("isBlockerJustCleared: still in the blocked lane → not cleared", () => {
  const item = {
    meta: { blockedReason: "waiting on #42" },
    lane: "blocked",
    movedAt: new Date(NOW - 60_000).toISOString(),
  };
  assert.equal(isBlockerJustCleared(item, NOW), false);
});

test("isBlockerJustCleared: no movedAt → not just-cleared", () => {
  const item = { meta: { blockedReason: "waiting on #42" }, lane: "queued" };
  assert.equal(isBlockerJustCleared(item, NOW), false);
});

test("isBlockerJustCleared: unparseable movedAt → not just-cleared (degrade, never throw)", () => {
  const item = { meta: { blockedReason: "waiting on #42" }, lane: "queued", movedAt: "nope" };
  assert.equal(isBlockerJustCleared(item, NOW), false);
});

test("isBlockerJustCleared: null/undefined item → not just-cleared", () => {
  assert.equal(isBlockerJustCleared(null, NOW), false);
  assert.equal(isBlockerJustCleared(undefined, NOW), false);
});

// --- requiresSpawnCapableDispatch (issue #2075) ----------------------------

test("requiresSpawnCapableDispatch: top-level dispatchSpawnCapable=true requires spawn", () => {
  assert.equal(requiresSpawnCapableDispatch({ dispatchSpawnCapable: true }), true);
});

test("requiresSpawnCapableDispatch: meta.dispatchSpawnCapable=true requires spawn", () => {
  assert.equal(
    requiresSpawnCapableDispatch({ meta: { dispatchSpawnCapable: true } }),
    true,
  );
});

test("requiresSpawnCapableDispatch: dispatch-spawn-capable label requires spawn", () => {
  assert.equal(
    requiresSpawnCapableDispatch({ labels: ["ready-for-agent", "dispatch-spawn-capable"] }),
    true,
  );
});

test("requiresSpawnCapableDispatch: absent flag → inline-buildable (false)", () => {
  assert.equal(requiresSpawnCapableDispatch({}), false);
  assert.equal(requiresSpawnCapableDispatch({ meta: {} }), false);
  assert.equal(requiresSpawnCapableDispatch({ labels: ["ready-for-agent"] }), false);
});

test("requiresSpawnCapableDispatch: non-true flag values do not require spawn", () => {
  // Only a strict boolean `true` flips the gate — a truthy string never does,
  // so a stray "true"-as-string can't accidentally hide an inline-buildable
  // anchor.
  assert.equal(requiresSpawnCapableDispatch({ dispatchSpawnCapable: "true" as any }), false);
  assert.equal(requiresSpawnCapableDispatch({ dispatchSpawnCapable: 1 as any }), false);
  assert.equal(requiresSpawnCapableDispatch({ meta: { dispatchSpawnCapable: "yes" as any } }), false);
});

test("requiresSpawnCapableDispatch: non-object / null / undefined → false (degrade, never throw)", () => {
  assert.equal(requiresSpawnCapableDispatch(null), false);
  assert.equal(requiresSpawnCapableDispatch(undefined), false);
  assert.equal(requiresSpawnCapableDispatch("issue-2075" as any), false);
  assert.equal(requiresSpawnCapableDispatch(42 as any), false);
});

test("requiresSpawnCapableDispatch: non-array labels are ignored", () => {
  assert.equal(
    requiresSpawnCapableDispatch({ labels: "dispatch-spawn-capable" as any }),
    false,
  );
});

// --- requiresNonPrDispatch (issue #2282) -----------------------------------

test("requiresNonPrDispatch: top-level nonPrDeliverable=true requires non-PR dispatch", () => {
  assert.equal(requiresNonPrDispatch({ nonPrDeliverable: true }), true);
});

test("requiresNonPrDispatch: meta.nonPrDeliverable=true requires non-PR dispatch", () => {
  assert.equal(requiresNonPrDispatch({ meta: { nonPrDeliverable: true } }), true);
});

test("requiresNonPrDispatch: each canonical class label trips the gate", () => {
  for (const label of NON_PR_DELIVERABLE_LABELS) {
    assert.equal(
      requiresNonPrDispatch({ labels: ["ready-for-agent", label] }),
      true,
      `label "${label}" must trip the gate`,
    );
  }
});

test("requiresNonPrDispatch: absent flag → deliverable (false)", () => {
  assert.equal(requiresNonPrDispatch({}), false);
  assert.equal(requiresNonPrDispatch({ meta: {} }), false);
  assert.equal(requiresNonPrDispatch({ labels: ["ready-for-agent", "enhancement"] }), false);
});

test("requiresNonPrDispatch: non-true flag values do not require non-PR dispatch", () => {
  // Only a strict boolean `true` flips the gate — a truthy string never does.
  assert.equal(requiresNonPrDispatch({ nonPrDeliverable: "true" as any }), false);
  assert.equal(requiresNonPrDispatch({ nonPrDeliverable: 1 as any }), false);
  assert.equal(requiresNonPrDispatch({ meta: { nonPrDeliverable: "yes" as any } }), false);
});

test("requiresNonPrDispatch: non-object / null / undefined → false (degrade, never throw)", () => {
  assert.equal(requiresNonPrDispatch(null), false);
  assert.equal(requiresNonPrDispatch(undefined), false);
  assert.equal(requiresNonPrDispatch("item-559" as any), false);
  assert.equal(requiresNonPrDispatch(42 as any), false);
});

test("requiresNonPrDispatch: non-array labels are ignored", () => {
  assert.equal(requiresNonPrDispatch({ labels: "host-systemd" as any }), false);
});

test("requiresNonPrDispatch: non-string label entries are skipped (degrade, never throw)", () => {
  assert.equal(requiresNonPrDispatch({ labels: [42, { x: 1 }, null] as any }), false);
});

test("requiresNonPrDispatch: an unknown label alone does NOT trip the gate", () => {
  assert.equal(requiresNonPrDispatch({ labels: ["some-other-label"] }), false);
});

// --- policy constants ------------------------------------------------------

test("eligibility policy constants keep their canonical values", () => {
  assert.equal(IN_FLIGHT_PR_FRESHNESS_MS, 30 * 60 * 1000);
  assert.equal(RECENT_UNBLOCK_THRESHOLD_MS, 24 * 60 * 60 * 1000);
});

test("NON_PR_DELIVERABLE_LABELS keeps its canonical class set", () => {
  assert.deepEqual(
    [...NON_PR_DELIVERABLE_LABELS].sort(),
    ["host-systemd", "live-data", "non-pr-deliverable", "operator-gated"],
  );
});
