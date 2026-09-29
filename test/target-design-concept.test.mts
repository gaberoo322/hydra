/**
 * Regression tests for the lightweight Target design-concept artifact
 * (issue #1056, parent epic #1052).
 *
 * Pins the four contract properties the issue's acceptance criteria name:
 *   - money-critical anchors get an artifact (built, serializable, persistable);
 *   - safe-path anchors skip artifact creation entirely;
 *   - a retry on the same anchor reuses the persisted artifact (round-trip);
 *   - the artifact stays *lightweight* — flat 4-field shape, no Q&A/tier/gate.
 *
 * Pure tests — no Redis, no network, no spawn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  shouldCaptureDesignConcept as shouldCaptureRaw,
  buildDesignConcept as buildRaw,
  serializeDesignConcept,
  parseDesignConcept,
  selectOperatorDecision,
  isStaleAgainstDecision,
  type TargetDesignConceptInput,
  type TargetIssueComment,
  type OperatorDecision,
} from "../scripts/target/target-design-concept.ts";
import {
  BETTING_RISK_SURFACE,
  BETTING_APP_SUBDIR,
} from "./_helpers/betting-risk-surface.mts";

const NOW = new Date("2026-06-06T12:00:00.000Z");

// Issue #3018: shouldCaptureDesignConcept / buildDesignConcept now take the
// manifest-sourced risk surface as (optional) arguments. The tests pass the
// betting fixture explicitly so they stay hermetic (no `.hydra/manifest.json`
// on disk). These wrappers preserve the existing call shapes below.
const shouldCaptureDesignConcept = (expectedPaths: readonly string[]) =>
  shouldCaptureRaw(expectedPaths, BETTING_RISK_SURFACE, BETTING_APP_SUBDIR);
const buildDesignConcept = (input: TargetDesignConceptInput, now?: Date) =>
  buildRaw(input, now, BETTING_RISK_SURFACE, BETTING_APP_SUBDIR);

function sampleInput(overrides: Partial<TargetDesignConceptInput> = {}): TargetDesignConceptInput {
  return {
    anchorRef: "issue-9001",
    scope: "Add a max-stake guard to the Kelly sizer.",
    modulesTouched: ["src/lib/staking/kelly.ts", "src/lib/execution/place-bet.ts"],
    invariants: ["never stake above the configured bankroll cap"],
    rejectedAlternatives: [{ alt: "clamp at the provider layer", why: "too late — order already built" }],
    ...overrides,
  };
}

describe("shouldCaptureDesignConcept — money-critical gate", () => {
  test("captures for money-critical paths (providers / execution / staking / bet-math)", () => {
    assert.equal(shouldCaptureDesignConcept(["src/lib/providers/betfair.ts"]), true);
    assert.equal(shouldCaptureDesignConcept(["src/lib/execution/place-bet.ts"]), true);
    assert.equal(shouldCaptureDesignConcept(["src/lib/staking/kelly.ts"]), true);
    assert.equal(shouldCaptureDesignConcept(["src/lib/bet-math/edge.ts"]), true);
  });

  test("safe-path anchors skip artifact creation entirely", () => {
    assert.equal(shouldCaptureDesignConcept(["web/src/components/Button.tsx", "README.md"]), false);
    assert.equal(shouldCaptureDesignConcept([]), false);
  });

  test("a mixed change with any money-critical path still captures", () => {
    assert.equal(
      shouldCaptureDesignConcept(["README.md", "src/lib/staking/kelly.ts"]),
      true,
    );
  });
});

describe("buildDesignConcept — lightweight 4-field artifact", () => {
  test("builds the flat artifact with all four planner fields", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    assert.equal(dc.kind, "target-design-concept");
    assert.equal(dc.anchorRef, "issue-9001");
    assert.equal(dc.scope, "Add a max-stake guard to the Kelly sizer.");
    assert.deepEqual(dc.modulesTouched, [
      "src/lib/staking/kelly.ts",
      "src/lib/execution/place-bet.ts",
    ]);
    assert.deepEqual(dc.invariants, ["never stake above the configured bankroll cap"]);
    assert.deepEqual(dc.rejectedAlternatives, [
      { alt: "clamp at the provider layer", why: "too late — order already built" },
    ]);
    assert.equal(dc.capturedAt, NOW.toISOString());
  });

  test("derives matchedPaths from modulesTouched via the keystone classifier", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    // Both sample paths are money-critical, in input order, de-duplicated.
    assert.deepEqual(dc.matchedPaths, [
      "src/lib/staking/kelly.ts",
      "src/lib/execution/place-bet.ts",
    ]);
  });

  test("stays lightweight — no Q&A trace / tier / lifecycle / prototype fields", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    const keys = Object.keys(dc).sort();
    assert.deepEqual(keys, [
      "anchorRef",
      "capturedAt",
      "invariants",
      "kind",
      "matchedPaths",
      "modulesTouched",
      "rejectedAlternatives",
      "scope",
    ]);
    // Explicitly NOT mirroring the Orchestrator artifact's heavy shape.
    const record = dc as unknown as Record<string, unknown>;
    assert.equal(record.qaTrace, undefined);
    assert.equal(record.prototypes, undefined);
    assert.equal(record.status, undefined);
    assert.equal(record.approvedBy, undefined);
    assert.equal(record.depthClassification, undefined);
  });

  test("trims and drops empty / whitespace-only / non-string list entries", () => {
    const dc = buildDesignConcept(
      sampleInput({
        scope: "   trimmed scope   ",
        modulesTouched: ["  src/lib/staking/kelly.ts  ", "", "   "],
        invariants: ["keep it exact", "   ", ""],
        rejectedAlternatives: [
          { alt: "  a  ", why: "  b  " },
          { alt: "", why: "" },
        ],
      }),
      NOW,
    );
    assert.equal(dc.scope, "trimmed scope");
    assert.deepEqual(dc.modulesTouched, ["src/lib/staking/kelly.ts"]);
    assert.deepEqual(dc.invariants, ["keep it exact"]);
    assert.deepEqual(dc.rejectedAlternatives, [{ alt: "a", why: "b" }]);
  });

  test("total — tolerates a malformed planner submission without throwing", () => {
    const dc = buildDesignConcept(
      {
        anchorRef: undefined as unknown as string,
        scope: undefined as unknown as string,
        modulesTouched: undefined as unknown as string[],
        invariants: undefined as unknown as string[],
        rejectedAlternatives: undefined as unknown as never[],
      },
      NOW,
    );
    assert.equal(dc.anchorRef, "");
    assert.equal(dc.scope, "");
    assert.deepEqual(dc.modulesTouched, []);
    assert.deepEqual(dc.invariants, []);
    assert.deepEqual(dc.rejectedAlternatives, []);
    assert.deepEqual(dc.matchedPaths, []);
  });
});

describe("serialize / parse — retry reuse round-trip", () => {
  test("a retry on the same anchor reuses the persisted artifact (round-trip)", () => {
    const original = buildDesignConcept(sampleInput(), NOW);
    const persisted = serializeDesignConcept(original);
    const reused = parseDesignConcept(persisted);
    assert.deepEqual(reused, original);
  });

  test("parse returns null for absent / empty persisted value (recapture)", () => {
    assert.equal(parseDesignConcept(null), null);
    assert.equal(parseDesignConcept(undefined), null);
    assert.equal(parseDesignConcept(""), null);
  });

  test("parse returns null (not throw) on corrupt JSON — degrades to recapture", () => {
    assert.equal(parseDesignConcept("{not json"), null);
    assert.equal(parseDesignConcept("42"), null);
    assert.equal(parseDesignConcept("[]"), null);
  });

  test("parse rejects a wrong-discriminator / mistyped object", () => {
    assert.equal(parseDesignConcept(JSON.stringify({ kind: "orch-design-concept" })), null);
    assert.equal(
      parseDesignConcept(
        JSON.stringify({
          kind: "target-design-concept",
          anchorRef: "issue-1",
          scope: "x",
          modulesTouched: "not-an-array",
          invariants: [],
          rejectedAlternatives: [],
          matchedPaths: [],
          capturedAt: NOW.toISOString(),
        }),
      ),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #4693 (CSB #119 / PR #193 QA FAIL): the Target design-concept capture
// read the issue BODY only, ignoring the operator's decision COMMENT that had
// routed the anchor back to ready-for-agent. The fixtures below model the real
// CSB #119 thread shapes: every comment — routing notes, autopilot notes, the
// QA FAIL verdict, the operator's decisions — is authored by the shared
// `gaberoo322` identity, so author login is NOT a discriminator; only the
// "Operator decision" content marker is.
// ---------------------------------------------------------------------------

/** A raw REST comment object (`gh api …/issues/N/comments` shape, subset). */
function rawComment(overrides: Record<string, unknown>) {
  return {
    user: { login: "gaberoo322" },
    body: "",
    created_at: "2026-09-22T00:00:00Z",
    html_url: "https://github.com/gaberoo322/claw-street-bets/issues/119#issuecomment-0",
    ...overrides,
  };
}

const ROUTING_NOTE = rawComment({
  body: "Routing this back to ready-for-agent after review.",
  created_at: "2026-09-23T13:00:00Z",
  html_url: "https://example/119#c1",
});
const QA_FAIL_VERDICT = rawComment({
  body: "Spec FAIL: record-market-data.ts alone scores 56.46% vs the 60% mutation floor.",
  created_at: "2026-09-25T09:30:00Z",
  html_url: "https://example/119#c2",
});
const DECISION_0923 = rawComment({
  body:
    "**Operator decision (2026-09-23):** Out of scope: moving the existing two workers into `src/bin/`. " +
    "Narrower deliverable: SCAFFOLD.md + `src/bin/README.md` scoping the rule to money-acting workers, plus an allowlist test.",
  created_at: "2026-09-23T14:00:00Z",
  html_url: "https://example/119#c3",
});
const DECISION_0927 = rawComment({
  body:
    "> *This was generated by AI during operator review.*\n\n" +
    "**Operator decision (2026-09-27):** The 09-23 decision stands — no `src/bin/` move in this anchor.",
  created_at: "2026-09-27T18:00:00Z",
  html_url: "https://example/119#c4",
});
const HEADER_ONLY_STATUS = rawComment({
  body: "> *This was generated by AI during operator review.*\n\nStatus: fix-forward under way, PR open.",
  created_at: "2026-09-28T09:00:00Z",
  html_url: "https://example/119#c5",
});

describe("selectOperatorDecision — content-marker selection (issue #4693)", () => {
  test("selects the marker comment and carries its body VERBATIM with provenance", () => {
    const sel = selectOperatorDecision([
      ROUTING_NOTE,
      QA_FAIL_VERDICT,
      DECISION_0923,
      HEADER_ONLY_STATUS,
    ]);
    assert.ok(sel, "a marker comment must be selected");
    assert.equal(sel.body, DECISION_0923.body); // full comment body, not a paraphrase
    assert.equal(sel.url, DECISION_0923.html_url);
    assert.equal(sel.createdAt, DECISION_0923.created_at);
  });

  test("author login is NOT a discriminator — non-marker comments by the operator identity are never selected", () => {
    // Every comment on the CSB #119 thread shares the gaberoo322 identity
    // (agents post as the operator login); none of these carries the marker.
    const sel = selectOperatorDecision([ROUTING_NOTE, QA_FAIL_VERDICT, HEADER_ONLY_STATUS]);
    assert.equal(sel, null);
  });

  test("the AI-review header ALONE does not make a comment a decision", () => {
    // CSB #119's 2026-09-28 fix-forward status report carries the header but
    // no decision — it must not be selected.
    const sel = selectOperatorDecision([HEADER_ONLY_STATUS]);
    assert.equal(sel, null);
  });

  test("the most recent marker comment wins by created_at, regardless of array order", () => {
    const ascending = selectOperatorDecision([ROUTING_NOTE, DECISION_0923, DECISION_0927]);
    assert.equal(ascending?.createdAt, DECISION_0927.created_at);
    // Shuffled: the later created_at still wins — ordering is by created_at,
    // not by position (the REST endpoint returns ascending, but the selector
    // must not depend on that).
    const shuffled = selectOperatorDecision([DECISION_0927, ROUTING_NOTE, DECISION_0923]);
    assert.equal(shuffled?.createdAt, DECISION_0927.created_at);
  });

  test("marker match is case-insensitive", () => {
    const sel = selectOperatorDecision([
      rawComment({ body: "operator decision: keep it narrow", html_url: "https://example/119#c6" }),
    ]);
    assert.ok(sel);
  });

  test("a comment that QUOTES or mentions the phrase mid-body never supersedes the real decision", () => {
    const quotingQa = rawComment({
      body:
        "QA FAIL: the build ignored the operator decision above.\n\n" +
        "> **Operator decision (2026-09-23):** Out of scope: moving workers.\n\nPlease redo.",
      created_at: "2026-09-29T09:00:00Z",
      html_url: "https://example/119#c9",
    });
    const midBody = rawComment({
      body: "Per the Operator decision (2026-09-23) I re-scoped.",
      created_at: "2026-09-29T10:00:00Z",
      html_url: "https://example/119#c10",
    });
    const sel = selectOperatorDecision([DECISION_0927, quotingQa, midBody]);
    assert.equal(sel?.url, DECISION_0927.html_url);
    assert.equal(selectOperatorDecision([quotingQa, midBody]), null);
  });

  test("target-build playbook wires Step 3.3 before 3.5, streams comments via stdin, and WARNs on failure paths", () => {
    const pb = readFileSync(
      new URL("../docs/operator-playbooks/hydra-target-build.md", import.meta.url),
      "utf8",
    );
    const i33 = pb.indexOf("### 3.3. Operator-decision comment read");
    assert.ok(i33 >= 0 && i33 < pb.indexOf("### 3.5. Self-declare scope"));
    const block = pb.slice(i33, pb.indexOf("### 3.5. Self-declare scope"));
    assert.ok(!/-- "\$OPERATOR_COMMENTS"/.test(block), "comment thread must not travel as argv (ARG_MAX)");
    assert.ok(block.includes("operator-decision selection FAILED"), "selection failure must WARN");
    assert.ok(block.includes("safe-path builds"), "safe-path (no Step 4.5) enforcement must be documented");
  });

  test("non-array / empty input returns null; malformed entries are skipped — never throws", () => {
    assert.equal(selectOperatorDecision(null), null);
    assert.equal(selectOperatorDecision(undefined), null);
    assert.equal(selectOperatorDecision([]), null);
    assert.equal(
      selectOperatorDecision("not-an-array" as unknown as TargetIssueComment[]),
      null,
    );
    // Marker-bearing but malformed entries (missing / mistyped fields) skip:
    assert.equal(selectOperatorDecision([rawComment({ body: "Operator decision: x", created_at: undefined, html_url: undefined })]), null);
    assert.equal(
      selectOperatorDecision([
        rawComment({ body: "Operator decision: x", created_at: 123 as unknown as string }),
      ]),
      null,
    );
    assert.equal(
      selectOperatorDecision([rawComment({ body: "Operator decision: x", html_url: undefined })]),
      null,
    );
    assert.equal(
      selectOperatorDecision([null, 42, "x", {}] as unknown as TargetIssueComment[]),
      null,
    );
    // A well-formed marker comment survives amid malformed entries:
    const sel = selectOperatorDecision([
      {} as TargetIssueComment,
      DECISION_0923,
      rawComment({ body: "Operator decision: partial" }),
    ]);
    assert.equal(sel?.url, DECISION_0923.html_url);
  });
});

describe("operatorDecision field — build + parse (issue #4693)", () => {
  const decision: OperatorDecision = {
    url: DECISION_0923.html_url,
    createdAt: DECISION_0923.created_at,
    body: DECISION_0923.body,
  };

  test("buildDesignConcept carries the decision VERBATIM when provided", () => {
    const dc = buildDesignConcept(sampleInput({ operatorDecision: decision }), NOW);
    assert.deepEqual(dc.operatorDecision, decision);
    assert.equal(dc.operatorDecision?.body, decision.body); // verbatim, not trimmed/paraphrased
  });

  test("the field is ABSENT when no decision — the pre-#4693 lightweight shape is preserved", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    assert.equal("operatorDecision" in dc, false);
    assert.equal(dc.operatorDecision, undefined);
  });

  test("build is total — a mistyped operatorDecision is dropped, never thrown on", () => {
    const dc = buildDesignConcept(
      sampleInput({ operatorDecision: "narrow it" as unknown as OperatorDecision }),
      NOW,
    );
    assert.equal("operatorDecision" in dc, false);
    const dc2 = buildDesignConcept(
      sampleInput({
        operatorDecision: { url: 1, createdAt: 2, body: 3 } as unknown as OperatorDecision,
      }),
      NOW,
    );
    assert.equal("operatorDecision" in dc2, false);
    const dc3 = buildDesignConcept(sampleInput({ operatorDecision: null }), NOW);
    assert.equal("operatorDecision" in dc3, false);
  });

  test("round-trips through serialize / parse with the field intact", () => {
    const persisted = serializeDesignConcept(
      buildDesignConcept(sampleInput({ operatorDecision: decision }), NOW),
    );
    const reused = parseDesignConcept(persisted);
    assert.deepEqual(reused?.operatorDecision, decision);
  });

  test("parse accepts a LEGACY artifact with no operatorDecision field (14-day-TTL Redis keys)", () => {
    const legacy = JSON.stringify({
      kind: "target-design-concept",
      anchorRef: "issue-9001",
      scope: "Add a max-stake guard to the Kelly sizer.",
      modulesTouched: ["src/lib/staking/kelly.ts"],
      invariants: ["never stake above the configured bankroll cap"],
      rejectedAlternatives: [],
      matchedPaths: ["src/lib/staking/kelly.ts"],
      capturedAt: NOW.toISOString(),
    });
    const parsed = parseDesignConcept(legacy);
    assert.ok(parsed, "a legacy artifact must still parse and be reusable");
    assert.equal(parsed.operatorDecision, undefined);
  });

  test("parse REJECTS a present-but-mistyped operatorDecision — degrades to recapture", () => {
    const base = {
      kind: "target-design-concept",
      anchorRef: "issue-9001",
      scope: "s",
      modulesTouched: [],
      invariants: [],
      rejectedAlternatives: [],
      matchedPaths: [],
      capturedAt: NOW.toISOString(),
    };
    assert.equal(
      parseDesignConcept(JSON.stringify({ ...base, operatorDecision: "narrow it" })),
      null,
    );
    assert.equal(
      parseDesignConcept(
        JSON.stringify({ ...base, operatorDecision: { url: "u", createdAt: "2026-09-23T14:00:00Z" } }),
      ),
      null,
    );
    assert.equal(parseDesignConcept(JSON.stringify({ ...base, operatorDecision: null })), null);
  });
});

describe("isStaleAgainstDecision — retry-reuse staleness (issue #4693)", () => {
  // Captured 2026-06-06 (NOW) — before/after decisions date around it.
  // Carries an older decision so the timestamp arm (not the missing-field arm)
  // is what these cases exercise.
  const concept = buildDesignConcept(
    { ...sampleInput(), operatorDecision: { url: "https://example/119#c0", createdAt: "2025-12-01T00:00:00Z", body: "**Operator decision (2025-12-01):** first" } },
    NOW,
  );
  const newer: OperatorDecision = {
    url: "https://example/119#c4",
    createdAt: "2026-09-27T18:00:00Z",
    body: "**Operator decision (2026-09-27):** stand",
  };
  const older: OperatorDecision = {
    url: "https://example/119#c3",
    createdAt: "2026-01-01T00:00:00Z",
    body: "**Operator decision (2026-01-01):** older",
  };

  test("a null decision never makes an artifact stale", () => {
    assert.equal(isStaleAgainstDecision(concept, null), false);
    assert.equal(isStaleAgainstDecision(concept, undefined), false);
  });

  test("stale iff the decision is strictly NEWER than the artifact's capturedAt", () => {
    assert.equal(isStaleAgainstDecision(concept, newer), true);
    assert.equal(isStaleAgainstDecision(concept, older), false);
    const sameInstant = { ...newer, createdAt: concept.capturedAt };
    assert.equal(isStaleAgainstDecision(concept, sameInstant), false);
  });

  test("an artifact with NO operatorDecision field is stale once a decision exists, even if captured after it", () => {
    const bare = buildDesignConcept(sampleInput(), NOW);
    assert.equal(bare.operatorDecision, undefined);
    assert.equal(isStaleAgainstDecision(bare, older), true); // decision predates capture, field missing
    assert.equal(isStaleAgainstDecision(bare, null), false); // no decision -> never stale
  });

  test("unparseable timestamps fail safe to stale (recapture, never reuse)", () => {
    const badDecision = { ...newer, createdAt: "not-a-date" };
    assert.equal(isStaleAgainstDecision(concept, badDecision), true);
    const badConcept = { ...concept, capturedAt: "not-a-date" };
    assert.equal(isStaleAgainstDecision(badConcept, newer), true);
  });
});
