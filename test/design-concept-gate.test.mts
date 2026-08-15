/**
 * Unit tests for `src/design-concept-gate.ts` — the zero-Redis gate + identity
 * leaf (issue #3095, anchoring the leaf extracted in #3039).
 *
 * This leaf imports ONLY the tier-classifier — nothing from `src/redis/` — so
 * the gate logic is assertable against synthetic `DesignConcept` objects with
 * zero Redis setup. These tests target the leaf's OWN surface distinct from the
 * persistence-path coverage in `design-concept.test.mts`:
 *
 *   - `gateCheck` — each of the 7 ADR-0008 failure modes one-by-one, plus the
 *     all-pass case.
 *   - `contentGateCheck` — the pre-approval half (rules 1-6) that makes
 *     hydra-grill Step 8's content-gate → approve → full-gate confirm
 *     sequence reachable (issue #4035).
 *   - `isFresh`   — the exact 7-day boundary.
 *   - `computeArtifactHash` — canonical-JSON key-order independence.
 *
 * All pure — no Redis, no filesystem, no agent calls.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  gateCheck,
  contentGateCheck,
  isFresh,
  computeArtifactHash,
  DESIGN_CONCEPT_MAX_AGE_MS,
  type DesignConcept,
} from "../src/design-concept-gate.ts";

const NOW = 1_700_000_000_000;

/**
 * A synthetic DesignConcept that PASSES every gate rule. Each failure-mode test
 * takes this base and breaks exactly one field, so a single reason is asserted
 * in isolation.
 */
function passingConcept(overrides: Partial<DesignConcept> = {}): DesignConcept {
  return {
    anchorRef: "issue-999",
    scope: "orch",
    createdAt: NOW - 1000, // fresh
    artifactHash: "placeholder",
    glossaryTerms: ["Design Concept"],
    glossaryGaps: [], // empty → passes rule 1
    modulesTouched: [
      { path: "src/foo.ts", interfaceImpact: "none", depthClassification: "shallow" },
    ],
    invariants: ["some invariant"],
    rejectedAlternatives: [],
    qaTrace: [
      { q: "q1", a: "a1" },
      { q: "q2", a: "a2" },
      { q: "q3", a: "a3" },
      { q: "q4", a: "a4" },
      { q: "q5", a: "a5" },
      { q: "q6", a: "a6" },
    ],
    prototypes: [],
    status: "approved",
    approvedBy: "auto-gate",
    ...overrides,
  };
}

describe("design-concept-gate — gateCheck all-pass", () => {
  test("a fully-valid approved concept passes the gate with no reasons", () => {
    const res = gateCheck(passingConcept(), NOW);
    assert.equal(res.ok, true);
    assert.deepEqual(res.reasons, []);
  });
});

describe("design-concept-gate — gateCheck 7 ADR-0008 failure modes", () => {
  test("rule 1: non-empty glossaryGaps fails closed", () => {
    const res = gateCheck(passingConcept({ glossaryGaps: ["Undefined Term"] }), NOW);
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("glossaryGaps")));
  });

  test("rule 2: zero invariants fails", () => {
    const res = gateCheck(passingConcept({ invariants: [] }), NOW);
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("invariants")));
  });

  test("rule 3: zero modulesTouched fails", () => {
    const res = gateCheck(passingConcept({ modulesTouched: [] }), NOW);
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("modulesTouched")));
  });

  test("rule 4: breaking impact on a tier < 2 (T1) path fails", () => {
    // config/agents/ classifies to T1 (prompt-shaped); a breaking declaration
    // there is a contradiction and must be rejected.
    const res = gateCheck(
      passingConcept({
        modulesTouched: [
          {
            path: "config/agents/planner.md",
            interfaceImpact: "breaking",
            depthClassification: "shallow",
          },
        ],
      }),
      NOW,
    );
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("breaking")));
  });

  test("rule 4: breaking impact on a tier >= 2 (T3 src) path passes rule 4", () => {
    // src/ classifies to T3; a breaking change there is permitted, so the gate
    // does NOT emit a breaking-related reason for this otherwise-valid concept.
    const res = gateCheck(
      passingConcept({
        modulesTouched: [
          {
            path: "src/foo.ts",
            interfaceImpact: "breaking",
            depthClassification: "deep",
          },
        ],
      }),
      NOW,
    );
    assert.equal(res.ok, true);
    assert.ok(!res.reasons.some((r) => r.includes("breaking")));
  });

  test("rule 5: qaTrace shorter than 6 turns fails", () => {
    const res = gateCheck(
      passingConcept({ qaTrace: [{ q: "q1", a: "a1" }] }),
      NOW,
    );
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("qaTrace")));
  });

  test("rule 6: a stale artifact (older than 7 days) fails", () => {
    const res = gateCheck(
      passingConcept({ createdAt: NOW - DESIGN_CONCEPT_MAX_AGE_MS - 1 }),
      NOW,
    );
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("stale")));
  });

  test("rule 7: status other than 'approved' fails", () => {
    const res = gateCheck(passingConcept({ status: "draft" }), NOW);
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("approved")));
  });

  test("multiple broken rules surface multiple reasons", () => {
    const res = gateCheck(
      passingConcept({ invariants: [], modulesTouched: [], status: "draft" }),
      NOW,
    );
    assert.equal(res.ok, false);
    assert.ok(res.reasons.length >= 3);
  });
});

// ---------------------------------------------------------------------------
// contentGateCheck — the pre-approval half (issue #4035)
// ---------------------------------------------------------------------------
//
// A freshly-written artifact is always status:'draft', so the FULL gate can
// never pass before approve (rule 7 requires the approval it gates). These
// cases pin the half that CAN pass pre-approval, and — with the sequence
// block below — make hydra-grill Step 8's documented auto-approve path
// reachable and regression-proof.
// ---------------------------------------------------------------------------

describe("design-concept-gate — contentGateCheck, the pre-approval half (issue #4035)", () => {
  test("a content-clean DRAFT passes rules 1-6 — the question the full gate cannot answer pre-approval", () => {
    const draft = passingConcept({ status: "draft", approvedBy: "" });
    const res = contentGateCheck(draft, NOW);
    assert.equal(res.ok, true);
    assert.deepEqual(res.reasons, []);
  });

  test("a genuine content failure (non-empty glossaryGaps) fails the content gate", () => {
    const res = contentGateCheck(
      passingConcept({ status: "draft", glossaryGaps: ["Undefined Term"] }),
      NOW,
    );
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r) => r.includes("glossaryGaps")));
  });

  test("contentGateCheck never emits the rule-7 status reason", () => {
    // Even a draft (the pre-approval case) must not see a status reason —
    // the content gate owns rules 1-6 ONLY.
    const res = contentGateCheck(passingConcept({ status: "draft" }), NOW);
    assert.ok(!res.reasons.some((r) => r.includes("status must be 'approved'")));
  });
});

describe("design-concept-gate — the reachable Step 8 sequence (issue #4035)", () => {
  test("content-gate pass → approve → full gate pass, end to end at the domain layer", () => {
    // 1. The freshly-written artifact (always a draft) passes the content gate.
    const draft = passingConcept({ status: "draft", approvedBy: "" });
    const content = contentGateCheck(draft, NOW);
    assert.equal(content.ok, true);

    // 2. Approve — approveDesignConcept flips status/approvedBy
    //    unconditionally (it does not re-check the rules); modeled here as
    //    exactly the two fields it writes.
    const approved: DesignConcept = {
      ...draft,
      status: "approved",
      approvedBy: "auto-gate",
    };

    // 3. The full gate confirms: rule 7 can only pass now that status
    //    flipped, and rules 1-6 are re-evaluated rather than assumed.
    const full = gateCheck(approved, NOW);
    assert.equal(full.ok, true);
    assert.deepEqual(full.reasons, []);
  });

  test("the same draft fails the full gate with EXACTLY the rule-7 reason — the pre-#4035 dead branch", () => {
    const full = gateCheck(passingConcept({ status: "draft", approvedBy: "" }), NOW);
    assert.equal(full.ok, false);
    assert.deepEqual(full.reasons, ["status must be 'approved' (got 'draft')"]);
  });

  test("a content failure escalates: content gate fails, and approval does NOT rescue the full gate", () => {
    const draft = passingConcept({
      status: "draft",
      approvedBy: "",
      glossaryGaps: ["Undefined Term"],
    });
    // Step 8 takes the escalate branch here — approve is never called…
    assert.equal(contentGateCheck(draft, NOW).ok, false);
    // …and even a (rule-violating) approval would still fail the full gate,
    // so the escalate-to-handoff path stays reachable for real failures.
    const approved: DesignConcept = { ...draft, status: "approved", approvedBy: "auto-gate" };
    const full = gateCheck(approved, NOW);
    assert.equal(full.ok, false);
    assert.ok(full.reasons.some((r) => r.includes("glossaryGaps")));
  });
});

describe("design-concept-gate — isFresh boundary", () => {
  test("exactly at the 7-day boundary is still fresh (<=, inclusive)", () => {
    const d = passingConcept({ createdAt: NOW - DESIGN_CONCEPT_MAX_AGE_MS });
    assert.equal(isFresh(d, NOW), true);
  });

  test("one ms past the 7-day boundary is stale", () => {
    const d = passingConcept({ createdAt: NOW - DESIGN_CONCEPT_MAX_AGE_MS - 1 });
    assert.equal(isFresh(d, NOW), false);
  });

  test("a non-positive or non-numeric createdAt is never fresh", () => {
    assert.equal(isFresh(passingConcept({ createdAt: 0 }), NOW), false);
    assert.equal(isFresh(passingConcept({ createdAt: -1 }), NOW), false);
  });

  test("respects an explicit maxAgeMs override", () => {
    const d = passingConcept({ createdAt: NOW - 2000 });
    assert.equal(isFresh(d, NOW, 1000), false);
    assert.equal(isFresh(d, NOW, 5000), true);
  });
});

describe("design-concept-gate — computeArtifactHash determinism", () => {
  test("identical bodies produce identical hashes", () => {
    const a = passingConcept();
    const b = passingConcept();
    assert.equal(computeArtifactHash(a), computeArtifactHash(b));
  });

  test("hash is independent of object key insertion order (canonical JSON)", () => {
    // Same field values, different literal key order in the qaTrace turns.
    const a = passingConcept({
      qaTrace: Array.from({ length: 6 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })),
    });
    const b = passingConcept({
      // Build the same turns with keys inserted in reverse order.
      qaTrace: Array.from({ length: 6 }, (_, i) => {
        const turn: { a: string; q: string } = { a: `a${i}`, q: `q${i}` };
        return turn;
      }),
    });
    assert.equal(computeArtifactHash(a), computeArtifactHash(b));
  });

  test("hash EXCLUDES createdAt, status, and approvedBy (identity is content-only)", () => {
    const base = passingConcept();
    const mutated = passingConcept({
      createdAt: base.createdAt + 12345,
      status: "draft",
      approvedBy: "operator:someone",
    });
    assert.equal(computeArtifactHash(base), computeArtifactHash(mutated));
  });

  test("a change to a body field DOES change the hash", () => {
    const base = passingConcept();
    const mutated = passingConcept({ invariants: ["a different invariant"] });
    assert.notEqual(computeArtifactHash(base), computeArtifactHash(mutated));
  });
});
