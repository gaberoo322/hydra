// Candidate Suppression Decision coordinator (issue #3240) — pinned-clock unit
// tests for the ORDERED eligibility-dispatch cascade extracted from the inline
// `getCandidateFeed` loop. These need NO Redis fixture and NO full
// `CandidateFeedDeps` construction: the coordinator is pure and takes `now`, the
// exclusion flags, and the merged-ref sets as parameters.
//
// The five gates (in-flight-PR, spawn-capable, non-PR-deliverable, merged-work,
// shipped-subject) are individually unit-tested in candidate-eligibility.test.mts;
// this file pins the DISPATCH between them — the fire order, the reason→counter
// mapping, the exclusion-flag opt-outs, and the eligible passthrough.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateSuppressionDecision,
  type SuppressionInput,
} from "../src/backlog/candidate-suppression.ts";
import { IN_FLIGHT_PR_FRESHNESS_MS } from "../src/backlog/candidate-eligibility.ts";
import type { MergedRef } from "../src/backlog/target-pr-feed.ts";

const NOW = 1_700_000_000_000;

// A baseline eligible input: no gate fires. Individual tests override one field
// to make exactly one gate trip.
function baseInput(over: Partial<SuppressionInput> = {}): SuppressionInput {
  return {
    item: { title: "some ordinary candidate title" },
    mergedIdentity: { issue: "999", title: "some ordinary candidate title", anchorRef: "some ordinary candidate title" },
    subjectTitle: "some ordinary candidate title",
    now: NOW,
    excludeInFlight: true,
    inlineMode: false,
    excludeNonPrDeliverable: true,
    excludeMerged: true,
    mergedRefs: new Set<string>(),
    mergedBlobs: [],
    ...over,
  };
}

// --- eligible passthrough --------------------------------------------------

test("a candidate that trips no gate is eligible with a null counter", () => {
  const d = candidateSuppressionDecision(baseInput());
  assert.equal(d.suppressed, false);
  assert.equal(d.reason, "eligible");
  assert.equal(d.counter, null);
});

// --- in-flight-PR gate -----------------------------------------------------

test("a fresh pr-<n> claim suppresses with reason in-flight-pr → inFlightSuppressed", () => {
  const d = candidateSuppressionDecision(baseInput({
    item: { claimedBy: "pr-42", claimedAt: new Date(NOW - 60_000).toISOString() },
  }));
  assert.equal(d.suppressed, true);
  assert.equal(d.reason, "in-flight-pr");
  assert.equal(d.counter, "inFlightSuppressed");
});

test("excludeInFlight=false opts out of the in-flight gate (raw operator view)", () => {
  const d = candidateSuppressionDecision(baseInput({
    excludeInFlight: false,
    item: { claimedBy: "pr-42", claimedAt: new Date(NOW - 60_000).toISOString() },
  }));
  assert.equal(d.suppressed, false);
  assert.equal(d.reason, "eligible");
});

test("a stale pr-<n> claim (past the freshness window) is eligible", () => {
  const d = candidateSuppressionDecision(baseInput({
    item: { claimedBy: "pr-42", claimedAt: new Date(NOW - IN_FLIGHT_PR_FRESHNESS_MS - 1).toISOString() },
  }));
  assert.equal(d.suppressed, false);
});

// --- spawn-capable gate ----------------------------------------------------

test("inline mode + dispatch-spawn-capable suppresses → spawnSuppressed", () => {
  const d = candidateSuppressionDecision(baseInput({
    inlineMode: true,
    item: { title: "big migration", dispatchSpawnCapable: true },
  }));
  assert.equal(d.suppressed, true);
  assert.equal(d.reason, "spawn-capable");
  assert.equal(d.counter, "spawnSuppressed");
});

test("a spawn-capable anchor is eligible for a spawn-capable (non-inline) caller", () => {
  const d = candidateSuppressionDecision(baseInput({
    inlineMode: false,
    item: { title: "big migration", dispatchSpawnCapable: true },
  }));
  assert.equal(d.suppressed, false);
});

// --- non-PR-deliverable gate ----------------------------------------------

test("a non-pr-deliverable anchor suppresses → nonPrDeliverableSuppressed", () => {
  const d = candidateSuppressionDecision(baseInput({
    item: { title: "host systemd tweak", nonPrDeliverable: true },
  }));
  assert.equal(d.suppressed, true);
  assert.equal(d.reason, "non-pr-deliverable");
  assert.equal(d.counter, "nonPrDeliverableSuppressed");
});

test("excludeNonPrDeliverable=false opts out of the PR-deliverability gate", () => {
  const d = candidateSuppressionDecision(baseInput({
    excludeNonPrDeliverable: false,
    item: { title: "host systemd tweak", nonPrDeliverable: true },
  }));
  assert.equal(d.suppressed, false);
});

// --- merged-work gate ------------------------------------------------------

test("an exact-token merged match suppresses → mergedSuppressed", () => {
  const d = candidateSuppressionDecision(baseInput({
    mergedIdentity: { issue: "882", title: "882", anchorRef: "882" },
    mergedRefs: new Set(["882"]),
  }));
  assert.equal(d.suppressed, true);
  assert.equal(d.reason, "merged-work");
  assert.equal(d.counter, "mergedSuppressed");
});

test("excludeMerged=false opts out of both merged gates", () => {
  const d = candidateSuppressionDecision(baseInput({
    excludeMerged: false,
    mergedIdentity: { issue: "882", title: "882", anchorRef: "882" },
    mergedRefs: new Set(["882"]),
  }));
  assert.equal(d.suppressed, false);
});

// --- shipped-subject gate --------------------------------------------------

test("a merged blob covering the subject suppresses → shippedSubjectSuppressed", () => {
  const title = "extract eligibility decision logic into a leaf module";
  const blobs: MergedRef[] = [
    { ref: "pr-1", blob: "extract eligibility decision logic into a leaf module for candidate feed" } as MergedRef,
  ];
  const d = candidateSuppressionDecision(baseInput({
    mergedIdentity: { issue: "x", title, anchorRef: title },
    subjectTitle: title,
    mergedBlobs: blobs,
  }));
  assert.equal(d.suppressed, true);
  assert.equal(d.reason, "shipped-subject");
  assert.equal(d.counter, "shippedSubjectSuppressed");
});

test("an empty merged-blob feed never subject-suppresses (positive-evidence-only)", () => {
  const d = candidateSuppressionDecision(baseInput({
    subjectTitle: "extract eligibility decision logic into a leaf module",
    mergedBlobs: [],
  }));
  assert.equal(d.suppressed, false);
});

// --- fire ORDER (the coordinator's core contract) --------------------------

test("in-flight-pr fires before spawn-capable when both match (order pinned)", () => {
  // Both gates would fire; the cascade evaluates in-flight-PR first.
  const d = candidateSuppressionDecision(baseInput({
    inlineMode: true,
    item: {
      claimedBy: "pr-42",
      claimedAt: new Date(NOW - 60_000).toISOString(),
      dispatchSpawnCapable: true,
    },
  }));
  assert.equal(d.reason, "in-flight-pr");
  assert.equal(d.counter, "inFlightSuppressed");
});

test("merged-work fires before shipped-subject when both match (order pinned)", () => {
  const title = "extract eligibility decision logic into a leaf module";
  const blobs: MergedRef[] = [
    { ref: "pr-1", blob: "extract eligibility decision logic into a leaf module for candidate feed" } as MergedRef,
  ];
  const d = candidateSuppressionDecision(baseInput({
    mergedIdentity: { issue: "882", title, anchorRef: title },
    subjectTitle: title,
    mergedRefs: new Set(["882"]),
    mergedBlobs: blobs,
  }));
  assert.equal(d.reason, "merged-work");
  assert.equal(d.counter, "mergedSuppressed");
});
