/**
 * src/autopilot/anchor-type.ts — anchor classification (issue #4139 consolidation).
 *
 * Merged verbatim from eight one-file-per-issue test files:
 * anchor-classification-inference-3403, anchor-classification-target-build-3486,
 * anchor-type-branch-fallback-3579, anchor-type-cycleid-prefixless-3138,
 * classify-anchor-type-unclassified-2822, no-attribution-shape-3623,
 * anchor-type-leaf-2858, anchor-type-taxonomy-derived-3253.
 *
 * All eight are PURE, in-process tests of the classifier itself: they import
 * from ../src/autopilot/anchor-type.ts, touch no Redis and spawn no
 * subprocess. That is the boundary this file is drawn on. Files that merely
 * *reference* anchorType while primarily testing a Redis-backed metrics store
 * (anchor-classification-inference-3390, unclassified-anchors-instrumentation-3403,
 * cycle-close-anchor-type-heal-3604), the dispatch script
 * (dispatch-cycle-record-anchor-type) or recordCycle
 * (autopilot-runs-anchortype-2762) are deliberately NOT here — merging a live
 * -Redis lifecycle into this file would buy nothing and risk the shared-
 * teardown flake class documented in CLAUDE.md.
 *
 * Each source file's body is wrapped in its own block so its module-scope
 * helpers and fixtures stay private — block nesting does not change node:test
 * nesting, so every describe() below is still top-level. No test text was
 * edited.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ANCHOR_TYPE_BY_CLASS, PREFIX_ANCHOR_TYPE, SKILL_ANCHOR_TYPE, SLOT_ANCHOR_TYPE, UNCLASSIFIED_ANCHOR_TYPE, classifyAnchorType, classifyNoAttributionShape, inferAnchorTypeFromCycleId, isMalformedAnchorType } from "../src/autopilot/anchor-type.ts";
import * as cycleClose from "../src/autopilot/cycle-close.ts";
import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";

// ===========================================================================
// Merged from test/anchor-type-leaf-2858.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Anchor-type classification-policy LEAF — pure-module extraction pin (#2858).
 *
 * The five anchor-type classification symbols (`UNCLASSIFIED_ANCHOR_TYPE`,
 * `isMalformedAnchorType`, `classifyAnchorType`, `SLOT_ANCHOR_TYPE`,
 * `inferAnchorTypeFromCycleId`) were extracted out of the cycle-record WRITE
 * coordinator (`src/autopilot/cycle-close.ts`) into a pure, zero-I/O leaf
 * `src/autopilot/anchor-type.ts`.
 *
 * This suite:
 *   1. Imports the policy DIRECTLY from the new leaf and pins its behaviour with
 *      pure string inputs — no Redis fixture, no cycle-record schema, no `deps`
 *      bag. That the import resolves + the assertions pass IS the leaf's
 *      zero-I/O contract (the module cannot be loaded if it pulled in the Redis
 *      accessors the write coordinator carries).
 *   2. Pins the #3225 relay-retirement invariant: the #2858 back-compat
 *      re-export relay has been dropped from `cycle-close.ts` now that no
 *      importer targets the write coordinator for the policy symbols, so the
 *      leaf (`anchor-type.ts`) is the one canonical home (no relay boilerplate
 *      on the write coordinator's public surface).
 */







describe("anchor-type policy leaf — pure classification (#2858)", () => {
  test("UNCLASSIFIED_ANCHOR_TYPE is the honest sentinel, distinct from 'unknown'", () => {
    assert.equal(UNCLASSIFIED_ANCHOR_TYPE, "unclassified");
    assert.notEqual(UNCLASSIFIED_ANCHOR_TYPE, "unknown");
  });

  test("SLOT_ANCHOR_TYPE maps each dispatch-class slot to its anchorType", () => {
    assert.equal(SLOT_ANCHOR_TYPE.dev_orch, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.dev_target, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.qa_orch, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.qa_target, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.design_concept_orch, "grill");
    assert.equal(SLOT_ANCHOR_TYPE.research_orch, "research");
    assert.equal(SLOT_ANCHOR_TYPE.research_target, "research");
  });

  test("isMalformedAnchorType rejects flag-shaped + unmapped sentinel forms", () => {
    // Flag-shaped: a leaked CLI token.
    assert.equal(isMalformedAnchorType("--status"), true);
    assert.equal(isMalformedAnchorType("-x"), true);
    // dispatch.sh's unmapped-skill sentinel.
    assert.equal(isMalformedAnchorType("unmapped"), true);
    assert.equal(isMalformedAnchorType("unmapped:completed"), true);
    // Genuine anchor types pass through.
    assert.equal(isMalformedAnchorType("work-queue"), false);
    assert.equal(isMalformedAnchorType("qa-review"), false);
    assert.equal(isMalformedAnchorType("grill"), false);
  });

  test("inferAnchorTypeFromCycleId decodes the worktree-branch slot suffix", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t9-dev_orch"),
      "work-queue",
    );
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-local-t1-qa_orch"),
      "qa-review",
    );
    // Non-matching shapes / unknown slots → undefined.
    assert.equal(inferAnchorTypeFromCycleId("worktree-agent-abc-nolongsuffix"), undefined);
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t9-not_a_slot"),
      undefined,
    );
    assert.equal(
      inferAnchorTypeFromCycleId("77d5c14c-0a6d-43ff-9fd4-d7c527964008"),
      undefined,
    );
  });

  test("classifyAnchorType: explicit value > slot inference > sentinel", () => {
    // Explicit non-empty, non-malformed value wins (trimmed).
    assert.equal(classifyAnchorType("any-id", "  work-queue  "), "work-queue");
    // Malformed explicit value falls through to slot inference.
    assert.equal(
      classifyAnchorType("worktree-agent-deadbeef-t2-dev_orch", "--status"),
      "work-queue",
    );
    // No explicit value + slot-decodable cycleId → inferred.
    assert.equal(
      classifyAnchorType("worktree-agent-11223344-t2-design_concept_orch", undefined),
      "grill",
    );
    // No explicit value + no slot → honest sentinel, never undefined.
    assert.equal(
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", undefined),
      UNCLASSIFIED_ANCHOR_TYPE,
    );
  });
});

describe("anchor-type policy leaf — cycle-close.ts relay retired (#3225)", () => {
  test("the write coordinator no longer re-exports anchor-type policy symbols", () => {
    // The #2858 migration window is closed (issue #3225): the back-compat
    // re-export relay was retired from `cycle-close.ts` once no importer of the
    // policy symbols targeted the write coordinator. The canonical — and now
    // ONLY — home for the policy is `anchor-type.ts`, so the write coordinator's
    // public surface no longer carries these pass-through symbols. The module
    // no longer declares these properties, so probe the runtime namespace
    // through an index signature (a direct `cycleClose.X` access is now a
    // compile-time error — which is itself the retirement we are asserting).
    const surface = cycleClose as Record<string, unknown>;
    assert.equal(surface.UNCLASSIFIED_ANCHOR_TYPE, undefined);
    assert.equal(surface.isMalformedAnchorType, undefined);
    assert.equal(surface.classifyAnchorType, undefined);
    assert.equal(surface.SLOT_ANCHOR_TYPE, undefined);
    assert.equal(surface.inferAnchorTypeFromCycleId, undefined);
  });
});
}

// ===========================================================================
// Merged from test/classify-anchor-type-unclassified-2822.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Issue #2822 — pin the bare-UUID `unclassified` invariant.
 *
 * #2822 reported that 14% of the recent metrics window carried
 * `anchorType: "unclassified"`. The design-concept (approved, hash 5265e45d…)
 * established that this is NOT a live bug:
 *
 *   - Both live anchorType writers — `recordCycle()` (POST
 *     /autopilot/cycle-record) and the direct POST /metrics/record handler —
 *     ALREADY route through `classifyAnchorType()` (src/autopilot/cycle-close.ts),
 *     and `dispatch.sh cycle-record` always stamps `anchor_type` from `$skill`.
 *     No code-writing dispatch produces `unclassified`.
 *   - The 14% was rolling-window RESIDUE: bare-UUID cycleIds recorded BEFORE the
 *     #2803/#2806 classify fixes deployed, still inside the 7-day rolling window.
 *   - The one residual live path — a bare-UUID POST to /metrics/record with no
 *     `anchorType` — is WORKING AS DESIGNED: a raw UUID is not slot-decodable, so
 *     the honest `unclassified` sentinel is the correct, visible outcome.
 *
 * This suite pins `classifyAnchorType` directly (a pure function — no Redis, no
 * clock) so the invariant behind the "false alarm" verdict can never silently
 * regress:
 *
 *   (a) a bare-UUID cycleId with NO anchorType records the `unclassified`
 *       SENTINEL — never the aggregator's `"unknown"` catch-all, never a crash;
 *   (b) a slot-suffixed worktree-branch cycleId still INFERS its anchorType.
 *
 * The exact bare-UUID / short-hex cycleIds `classifyAnchorType` receives are
 * taken from the #2822 evidence block so the regression is anchored to the
 * real telemetry that raised the alarm.
 *
 * Distinct from `autopilot-runs-anchortype-2762.test.mts` (which drives the
 * full `recordCycle` write path against an in-memory deps fixture) and
 * `metrics-record-schema-guard.test.mts` (which drives the HTTP handler against
 * Redis): this suite isolates the classifier itself, so a change to the
 * sentinel or the slot-inference regex fails HERE first, with no I/O in the way.
 */






// The literal the metrics aggregator (src/metrics/aggregate.ts) maps an
// absent/empty/whitespace anchorType to. The whole point of the sentinel is
// that classifyAnchorType NEVER lets a metrics record fall into this bucket —
// so it must be a DISTINCT string from the sentinel.
const AGGREGATOR_UNKNOWN_BUCKET = "unknown";

describe("classifyAnchorType — bare-UUID unclassified invariant (#2822)", () => {
  // The bare-UUID + short-hex cycleIds from the #2822 evidence block. None is
  // slot-decodable (no `worktree-agent-…-tN-<slot>` shape), so each MUST land
  // the honest `unclassified` sentinel when no anchorType is supplied.
  const BARE_CYCLE_IDS = [
    "77d5c14c-0a6d-43ff-9fd4-d7c527964008", // → PR #2796
    "53bf2557-30a7-4605-a3f2-d033e8bf208d", // → PR #2786
    "991a8895-569a-4e38-ad1c-f3c79e696719", // → PR #2765
    "ab07ae73cbba50381", // short-hex, → PR #2787
    "aa6380135cb0ec4ba", // short-hex, → PR #2774
    "autopilot-28b7c14e", // autopilot- prefixed, → PR #2770
  ];

  for (const cycleId of BARE_CYCLE_IDS) {
    test(`bare cycleId '${cycleId}' with no anchorType → unclassified sentinel`, () => {
      // `undefined` is what recordCycle passes for an absent body.anchorType.
      const result = classifyAnchorType(cycleId, undefined);
      assert.equal(
        result,
        UNCLASSIFIED_ANCHOR_TYPE,
        "a non-slot-decodable cycleId with no anchorType must land the sentinel",
      );
    });
  }

  test("the sentinel is NEVER the aggregator's 'unknown' catch-all", () => {
    // The invariant that makes the sentinel worth having: it is a DISTINCT,
    // attributable value, so a post-fix `unknown` bucket can only mean a record
    // predates the classify fix — never that classification silently fell
    // through. If these two strings ever collide the distinction is lost.
    assert.notEqual(UNCLASSIFIED_ANCHOR_TYPE, AGGREGATOR_UNKNOWN_BUCKET);
    assert.equal(UNCLASSIFIED_ANCHOR_TYPE, "unclassified");
  });

  test("returns a non-empty string (never undefined/empty) so the aggregator can't bucket it 'unknown'", () => {
    // aggregate.ts maps an absent/empty/whitespace anchorType to "unknown"
    // (`(m.anchorType && String(m.anchorType).trim()) || "unknown"`). A
    // non-empty return here is precisely what prevents that fall-through.
    for (const raw of [undefined, null, "", "   "]) {
      const result = classifyAnchorType(
        "77d5c14c-0a6d-43ff-9fd4-d7c527964008",
        raw,
      );
      assert.equal(typeof result, "string");
      assert.ok(result.trim().length > 0, `non-empty for raw=${JSON.stringify(raw)}`);
      assert.notEqual(result, AGGREGATOR_UNKNOWN_BUCKET);
    }
  });

  test("never throws on a bare-UUID cycleId (no crash path)", () => {
    // #2822 explicitly requires the bare-UUID path to be crash-free.
    assert.doesNotThrow(() =>
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", undefined),
    );
  });

  test("(b) a slot-suffixed worktree-branch cycleId still INFERS its anchorType", () => {
    // The complementary invariant: the sentinel must NOT swallow a cycleId that
    // IS slot-decodable — a real anchorType is recovered from the slot suffix.
    assert.equal(
      classifyAnchorType("worktree-agent-568fde2a-t9-dev_orch", undefined),
      "work-queue",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-deadbeef-t12-qa_orch", undefined),
      "qa-review",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-11223344-t2-design_concept_orch", undefined),
      "grill",
    );
  });

  test("an explicit anchorType on a bare-UUID cycleId is honoured (not overridden by the sentinel)", () => {
    // When the caller DID supply a good anchorType, the bare-UUID shape must not
    // force the sentinel — the explicit value wins.
    assert.equal(
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", "work-queue"),
      "work-queue",
    );
  });
});
}

// ===========================================================================
// Merged from test/anchor-type-cycleid-prefixless-3138.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Issue #3138 — prefix-less relay cycleId anchorType inference.
 *
 * A dispatch cycle recorded with the PREFIX-LESS relay cycleId
 * `6fd1300b-t1-qa_orch` (no `worktree-agent-` prefix) was bucketed as
 * `unclassified`, because `inferAnchorTypeFromCycleId`'s regex hard-required the
 * `worktree-agent-` prefix. This is the qa_orch relay first-write case
 * (cycle-merge-reconcile / holdback-merge-watch write a cycle-record for a PR
 * the reap path never recorded, using a relay cycleId). The taxonomy module
 * (`producerClassFromCycleId`) ALREADY accepts the prefix-less shape by trailing
 * slot; the anchor-type leaf was the outlier.
 *
 * The fix makes the `worktree-agent-` prefix OPTIONAL and anchors the slot on
 * `_(orch|target)` (design-concept issue-3138, CANDIDATE B). This suite pins:
 *
 *   (1) a prefix-less `<runToken>-t<N>-<slot>` id resolves to the SAME
 *       anchorType its worktree-agent-prefixed twin resolves to;
 *   (2) every #2822 bare-UUID / short-hex / autopilot-prefixed id STILL returns
 *       the `unclassified` sentinel (the widened regex must not swallow them);
 *   (3) the harness's own bare `worktree-agent-<longhash>` branch (no -tN-<slot>
 *       suffix) STILL falls through to the sentinel.
 *
 * Isolates the pure `classifyAnchorType` seam (no Redis, no clock), so a change
 * to the regex fails HERE first, with no I/O in the way. Complementary to
 * `classify-anchor-type-unclassified-2822.test.mts` and
 * `autopilot-runs-anchortype-2762.test.mts`.
 */






// ADR-0027: the unclassified-anchorType fail-loud alarm now logs through the
// pino structured-logger seam (module singleton → process.stderr) instead of a
// freeform console.warn. Capture the serialized JSON lines and assert on the
// structured `level` field (pino: warn=40) rather than grepping console.warn.
function captureStderr(): { lines: () => Record<string, any>[]; restore: () => void } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  return {
    lines: () =>
      buf
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, any>),
    restore: () => {
      (process.stderr as any).write = originalWrite;
    },
  };
}

describe("classifyAnchorType — prefix-less relay cycleId inference (#3138)", () => {
  // (1) The reported id plus one variant per slot family. Each is the
  // prefix-less twin of a worktree-agent-prefixed id the #2762 suite pins.
  const PREFIXLESS_CASES: ReadonlyArray<readonly [string, string]> = [
    ["6fd1300b-t1-qa_orch", "qa-review"], // the exact reported id
    ["6fd1300b-t3-dev_target", "work-queue"],
    ["568fde2a-t9-dev_orch", "work-queue"],
    ["cafe1234-t5-qa_target", "qa-review"],
    ["11223344-t2-design_concept_orch", "grill"],
    ["aabbccdd-t7-research_orch", "research"],
    ["local-t0-research_orch", "research"], // `local` run-token fallback
  ];

  for (const [cycleId, expected] of PREFIXLESS_CASES) {
    test(`prefix-less '${cycleId}' with no anchorType → ${expected}`, () => {
      assert.equal(classifyAnchorType(cycleId, undefined), expected);
    });
  }

  test("a prefix-less id resolves to the SAME anchorType as its worktree-agent twin", () => {
    // The core invariant: prefix presence must not change the answer.
    assert.equal(
      inferAnchorTypeFromCycleId("6fd1300b-t1-qa_orch"),
      inferAnchorTypeFromCycleId("worktree-agent-6fd1300b-t1-qa_orch"),
    );
    assert.equal(
      inferAnchorTypeFromCycleId("568fde2a-t9-dev_orch"),
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t9-dev_orch"),
    );
  });

  test("does NOT emit a warn-level line when a prefix-less id resolves", () => {
    const cap = captureStderr();
    try {
      assert.equal(classifyAnchorType("6fd1300b-t1-qa_orch", undefined), "qa-review");
    } finally {
      cap.restore();
    }
    const warns = cap.lines().filter((o) => o.level === 40);
    assert.equal(warns.length, 0, "no warn when the slot is decodable");
  });
});

describe("classifyAnchorType — widened regex preserves #2822/harness negatives (#3138)", () => {
  // (2) The #2822 evidence ids. None carries a `-t<N>-<slot_ending_in_orch|target>`
  // middle, so each MUST still return the sentinel — the widened regex must not
  // swallow them. If any of these goes red, the regex is too loose.
  const SENTINEL_IDS = [
    "77d5c14c-0a6d-43ff-9fd4-d7c527964008", // bare UUID
    "53bf2557-30a7-4605-a3f2-d033e8bf208d",
    "ab07ae73cbba50381", // short-hex
    "aa6380135cb0ec4ba",
    "autopilot-28b7c14e", // autopilot- prefixed
    "worktree-agent-ab3a8b01c3f11f366", // (3) harness branch, no turn/slot suffix
    "6fd1300b-t1-unknown_class", // prefix-less but unmapped slot (not _orch/_target)
  ];

  for (const cycleId of SENTINEL_IDS) {
    test(`'${cycleId}' with no anchorType → unclassified sentinel`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }

  test("an explicit anchorType still wins over cycleId inference on a prefix-less id", () => {
    // The caller-supplied value takes precedence (classifyAnchorType's first
    // branch is unchanged) even when the cycleId would otherwise infer.
    assert.equal(classifyAnchorType("6fd1300b-t1-qa_orch", "work-queue"), "work-queue");
  });
});
}

// ===========================================================================
// Merged from test/anchor-classification-inference-3403.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Issue #3403 — anchor classification 26% unclassified rate.
 *
 * The live 50-cycle sample carried 13 records stuck in the `unclassified`
 * bucket. Diagnosing the exact cycleIds against production /metrics showed three
 * families:
 *
 *   (A) DECODABLE — the cycleId unambiguously names a dispatch class, but the
 *       pre-#3403 parser rejected the shape:
 *         - the bare SKILL name as the whole cycleId (`hydra-dev`), and
 *         - a fence-less `<class-prefix>-<suffix>` id (`dev-3291`).
 *       `inferAnchorTypeFromCycleId` now decodes both via taxonomy-derived
 *       lookups (`SKILL_ANCHOR_TYPE` / `PREFIX_ANCHOR_TYPE`), so they land their
 *       real lane instead of the sentinel — and because `getMetricsTrend`
 *       re-infers stored sentinel rows from the cycleId (#3390), the fix drops
 *       the LIVE rate at read time with no Redis backfill.
 *
 *   (B) AMBIGUOUS-PREFIX SAFETY — `PREFIX_ANCHOR_TYPE` holds only prefixes that
 *       resolve to ONE lane, so an ambiguous prefix (`design` → grill vs
 *       design-qa) never guesses; it stays the honest sentinel.
 *
 *   (C) STRUCTURALLY UNDECODABLE — bare UUIDs, the harness's own
 *       `worktree-agent-<longhash>` branch names, and PR-number/turn-only tails
 *       carry NO class signal in the cycleId. These correctly STAY the
 *       `unclassified` sentinel (the #2822 "never guess" invariant); their
 *       upstream anchorType forward is the known #2800 gap, and they are
 *       surfaced as documented exceptions by `getUnclassifiedAnchors`.
 *
 * Pure classifier suite — no Redis, no clock. A change to the sentinel or the
 * inference legs fails HERE first, with no I/O in the way. cycleIds are taken
 * from the #3403 evidence block so the regression is anchored to real telemetry.
 */






describe("inferAnchorTypeFromCycleId — skill-name + class-prefix legs (#3403)", () => {
  test("bare skill-name cycleId decodes to its class lane (`hydra-dev` → work-queue)", () => {
    assert.equal(inferAnchorTypeFromCycleId("hydra-dev"), "work-queue");
    assert.equal(classifyAnchorType("hydra-dev", undefined), "work-queue");
  });

  test("every taxonomy skill decodes via the skill-name leg", () => {
    // Every key in the derived skill→lane map must round-trip through the
    // inference function — the map and the parser can never drift.
    for (const [skill, lane] of Object.entries(SKILL_ANCHOR_TYPE)) {
      assert.equal(
        inferAnchorTypeFromCycleId(skill),
        lane,
        `skill '${skill}' must decode to '${lane}'`,
      );
    }
  });

  test("fence-less `<class-prefix>-<issue>` cycleId decodes (`dev-3291` → work-queue)", () => {
    assert.equal(inferAnchorTypeFromCycleId("dev-3291"), "work-queue");
    assert.equal(classifyAnchorType("dev-3291", undefined), "work-queue");
  });

  test("prefix leg agrees with the full-slot lane for every unambiguous prefix", () => {
    for (const [prefix, lane] of Object.entries(PREFIX_ANCHOR_TYPE)) {
      assert.equal(
        inferAnchorTypeFromCycleId(`${prefix}-9999`),
        lane,
        `prefix '${prefix}' must decode to '${lane}'`,
      );
    }
  });

  test("a fenced bare prefix tail decodes (`…-t3-dev` → work-queue)", () => {
    assert.equal(inferAnchorTypeFromCycleId("abc12345-t3-dev"), "work-queue");
  });
});

describe("PREFIX_ANCHOR_TYPE — ambiguous prefixes never guess (#3403)", () => {
  test("`design` is EXCLUDED (grill vs design-qa disagree) so it stays the sentinel", () => {
    // design_concept_orch → grill, design_qa_target → design-qa: the prefix is
    // ambiguous, so it must NOT be a key in the map...
    assert.equal(PREFIX_ANCHOR_TYPE.design, undefined);
    // ...and a bare `design-…` cycleId must stay unclassified rather than pick
    // one of the two lanes arbitrarily.
    assert.equal(inferAnchorTypeFromCycleId("design-4200"), undefined);
    assert.equal(classifyAnchorType("design-4200", undefined), UNCLASSIFIED_ANCHOR_TYPE);
  });

  test("every prefix in the map resolves to exactly one lane (unambiguous by construction)", () => {
    for (const lane of Object.values(PREFIX_ANCHOR_TYPE)) {
      assert.equal(typeof lane, "string");
      assert.ok(lane.length > 0);
    }
  });
});

describe("inferAnchorTypeFromCycleId — structurally undecodable ids stay the sentinel (#3403)", () => {
  // The exact still-unclassified cycleIds from the live #3403 sample that carry
  // NO class signal — bare UUIDs, harness branch names, PR-number/turn-only
  // tails. These MUST stay undefined (the #2822 never-guess invariant): the new
  // skill/prefix legs must not swallow a random hex/UUID segment.
  const UNDECODABLE_IDS = [
    "b8a3071f-a783-4812-bec5-8fa0f5079a08", // bare UUID
    "ec3928e1-e125-4342-8d4c-51bcd834fa19",
    "b9e6356d-7b33-4eda-b533-3b5e160aba53",
    "98fd3a0a-dd92-4977-a16d-ce536ca656ff",
    "b17ee362-3c54-4b5c-8707-8565b0cc9498-t3", // turn but no slot tail
    "worktree-agent-a9c177cfbcf1de7bf", // harness branch, no -t{N}- middle
    "worktree-agent-a4f8a3811688505c3",
    "worktree-agent-ad56fc40d1f365c08",
    "c6db11dc-t3-pr3326", // fenced, but `pr3326` is not a class/prefix
  ];

  for (const cycleId of UNDECODABLE_IDS) {
    test(`'${cycleId}' stays undefined → unclassified sentinel`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }

  test("an explicit anchorType still wins over the sentinel on an undecodable id", () => {
    assert.equal(
      classifyAnchorType("b8a3071f-a783-4812-bec5-8fa0f5079a08", "work-queue"),
      "work-queue",
    );
  });
});
}

// ===========================================================================
// Merged from test/anchor-type-taxonomy-derived-3253.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Anchor-type taxonomy-derived SLOT_ANCHOR_TYPE — completeness pin (#3253).
 *
 * Before #3253, `SLOT_ANCHOR_TYPE` was a hand-maintained seven-entry literal
 * covering only the pipeline slots (`dev_*`, `qa_*`, `research_*`,
 * `design_concept_orch`). The dispatch-class alphabet
 * (`scripts/autopilot/classes.json`) meanwhile grew ~13 signal classes
 * (`discover_*`, `architecture_orch`, `retro_orch`, `cleanup_*`, `sweep_*`,
 * `scout_orch`, `wire_or_retire_target`, `design_qa_target`, `skill_prune`,
 * `health`) with NO entry — so a cycle whose cycleId embedded one of those
 * slots decoded to `undefined` and fell through to the `unclassified` sentinel
 * (the 34% unknown/unclassified rate the architecture review flagged).
 *
 * This suite pins the fix: `SLOT_ANCHOR_TYPE` is DERIVED from
 * `DISPATCH_CLASSES`, so EVERY dispatch class carries an anchorType lane, and
 * the signal-class slots that used to fall through now decode through
 * `inferAnchorTypeFromCycleId` / `classifyAnchorType` into their own buckets.
 */






describe("SLOT_ANCHOR_TYPE is derived from the taxonomy — no drift (#3253)", () => {
  test("EVERY dispatch class in the taxonomy has a non-empty anchorType lane", () => {
    for (const row of DISPATCH_CLASSES) {
      const lane = SLOT_ANCHOR_TYPE[row.name];
      assert.equal(
        typeof lane,
        "string",
        `class "${row.name}" has no SLOT_ANCHOR_TYPE lane`,
      );
      assert.ok(
        (lane as string).length > 0,
        `class "${row.name}" maps to an empty anchorType lane`,
      );
      // A derived lane must never itself be the honest data-quality sentinel.
      assert.notEqual(
        lane,
        UNCLASSIFIED_ANCHOR_TYPE,
        `class "${row.name}" maps to the unclassified sentinel`,
      );
    }
  });

  test("SLOT_ANCHOR_TYPE keys exactly mirror the taxonomy class names", () => {
    const taxonomyNames = new Set(DISPATCH_CLASSES.map((r) => r.name));
    const slotNames = new Set(Object.keys(SLOT_ANCHOR_TYPE));
    assert.deepEqual(
      [...slotNames].sort(),
      [...taxonomyNames].sort(),
      "SLOT_ANCHOR_TYPE keys must equal the taxonomy class names",
    );
  });

  test("historical pipeline-slot lanes are preserved verbatim", () => {
    assert.equal(SLOT_ANCHOR_TYPE.dev_orch, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.dev_target, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.qa_orch, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.qa_target, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.design_concept_orch, "grill");
    assert.equal(SLOT_ANCHOR_TYPE.research_orch, "research");
    assert.equal(SLOT_ANCHOR_TYPE.research_target, "research");
  });

  test("the signal-class slots that used to fall through now have lanes", () => {
    // These were the missing entries pre-#3253 — the drift the fix closes.
    assert.equal(SLOT_ANCHOR_TYPE.cleanup_orch, "cleanup");
    assert.equal(SLOT_ANCHOR_TYPE.cleanup_target, "cleanup");
    assert.equal(SLOT_ANCHOR_TYPE.retro_orch, "retro");
    assert.equal(SLOT_ANCHOR_TYPE.discover_orch, "discover");
    assert.equal(SLOT_ANCHOR_TYPE.discover_target, "discover");
    assert.equal(SLOT_ANCHOR_TYPE.architecture_orch, "architecture");
    assert.equal(SLOT_ANCHOR_TYPE.sweep_orch, "sweep");
    assert.equal(SLOT_ANCHOR_TYPE.sweep_target, "sweep");
    assert.equal(SLOT_ANCHOR_TYPE.scout_orch, "scout");
  });

  test("ANCHOR_TYPE_BY_CLASS is the superset ANCHOR_TYPE_BY_CLASS[name] source", () => {
    // The exported per-class map backs the derived slot map; every taxonomy
    // class resolves through it identically.
    for (const row of DISPATCH_CLASSES) {
      assert.equal(SLOT_ANCHOR_TYPE[row.name], ANCHOR_TYPE_BY_CLASS[row.name]);
    }
  });
});

describe("cycleId inference decodes signal-class slots post-#3253", () => {
  test("a cleanup_orch worktree-branch cycleId no longer falls to unclassified", () => {
    // Pre-#3253 this decoded to undefined → classifyAnchorType returned
    // 'unclassified'. Now it decodes to the 'cleanup' lane.
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t3-cleanup_orch"),
      "cleanup",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-568fde2a-t3-cleanup_orch", undefined),
      "cleanup",
    );
  });

  test("discover / architecture / retro signal slots decode to their lanes", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-deadbeef-t1-discover_orch"),
      "discover",
    );
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-local-t2-architecture_orch"),
      "architecture",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-abcd1234-t7-retro_orch", undefined),
      "retro",
    );
  });

  test("the prefix-less relay form also decodes a signal slot (#3138 shape)", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("6fd1300b-t4-cleanup_target"),
      "cleanup",
    );
  });

  test("a genuinely non-dispatch cycleId still yields the honest sentinel", () => {
    assert.equal(
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", undefined),
      UNCLASSIFIED_ANCHOR_TYPE,
    );
  });
});
}

// ===========================================================================
// Merged from test/anchor-classification-target-build-3486.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Issue #3486 — 22% of recent scheduler cycles carry an unknown anchor-type.
 *
 * Over the live 50-cycle window, 11 cycles (22%) carried a `cycleId` matching
 * `claude-cycle-YYYY-MM-DD-HHMM` that decoded to no dispatch class, so they
 * landed with no `anchorType` and fell into the `unclassified` sentinel — opaque
 * to the tier classifier, anchor-selection, and outcome-impact ranking.
 *
 * Root cause: `claude-cycle-*` (and its inline-mode twin `inline-*`) is the
 * cycleId `hydra-target-build` registers in Step 0 of
 * `docs/operator-playbooks/hydra-target-build.md` (`CYCLE_ID="claude-cycle-$(date
 * -u +%Y-%m-%d-%H%M)"`, `source: "claude"`). Its tail is a `date` timestamp, not a
 * class token, so every pre-#3486 inference leg (skill-name, fenced `-t{N}-`,
 * class-prefix) missed it. But the LITERAL prefix is unambiguous: every such cycle
 * is a Target build — the `dev_target` class → `work-queue` lane.
 *
 * `inferAnchorTypeFromCycleId` now decodes both prefixes via a literal-prefix +
 * timestamp-anchor match, and because `getMetricsTrend` re-infers stored sentinel
 * rows from the cycleId (#3390), this drops the LIVE unclassified rate at read
 * time with no Redis backfill.
 *
 * This suite also pins the #2822 "never guess" invariant: the new leg's timestamp
 * anchor must NOT swallow a bare UUID / short-hex / harness-branch cycleId.
 *
 * Pure classifier suite — no Redis, no clock. A change to the leg fails HERE
 * first. cycleIds are taken from the #3486 evidence block so the regression is
 * anchored to real telemetry.
 */






describe("inferAnchorTypeFromCycleId — hydra-target-build cycleId leg (#3486)", () => {
  // The exact cycleIds from the #3486 evidence block.
  const TARGET_BUILD_IDS = [
    "claude-cycle-2026-07-18-2101",
    "claude-cycle-2026-07-18-2030",
    "claude-cycle-2026-07-18-1955",
  ];

  for (const cycleId of TARGET_BUILD_IDS) {
    test(`'${cycleId}' decodes to the dev_target lane (work-queue)`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), "work-queue");
      assert.equal(classifyAnchorType(cycleId, undefined), "work-queue");
    });
  }

  test("the decoded lane IS the taxonomy dev_target lane (derived, not hard-coded)", () => {
    // The leg must track the taxonomy alphabet: if dev_target ever re-lanes, the
    // decode follows. Guards against a hard-coded string drifting from the map.
    assert.equal(
      inferAnchorTypeFromCycleId("claude-cycle-2026-07-18-2101"),
      ANCHOR_TYPE_BY_CLASS.dev_target,
    );
  });

  test("the inline-mode twin `inline-YYYY-MM-DD-HHMM` decodes to the same lane", () => {
    // The inline-mode fragment emits `cycleId:"inline-$(date -u +%Y-%m-%d-%H%M)"`.
    assert.equal(inferAnchorTypeFromCycleId("inline-2026-07-18-2101"), "work-queue");
    assert.equal(classifyAnchorType("inline-2026-07-18-2101", undefined), "work-queue");
  });

  test("a trailing `-<suffix>` (manual item-tagged runs) still decodes", () => {
    // `~/hydra-betting/reports` shows `claude-cycle-2026-05-16-0727-item284`.
    assert.equal(
      inferAnchorTypeFromCycleId("claude-cycle-2026-05-16-0727-item284"),
      "work-queue",
    );
  });

  test("an explicit anchorType still wins over the cycleId decode", () => {
    // The write-path precedence is unchanged: a caller-supplied good anchorType
    // is never overwritten by the inference leg.
    assert.equal(
      classifyAnchorType("claude-cycle-2026-07-18-2101", "research"),
      "research",
    );
  });
});

describe("inferAnchorTypeFromCycleId — target-build leg never guesses (#3486 / #2822)", () => {
  // The new literal-prefix + timestamp leg must NOT swallow any id that carries
  // no class signal. These MUST stay undefined → unclassified sentinel.
  const UNDECODABLE_IDS = [
    "b8a3071f-a783-4812-bec5-8fa0f5079a08", // bare UUID — no claude-cycle/inline prefix
    "worktree-agent-a9c177cfbcf1de7bf", // harness branch
    "claude-cycle-2026-07-18", // prefix but no HHMM segment (not a full timestamp)
    "claude-cycle-not-a-timestamp", // prefix but non-numeric tail
    "inline", // bare prefix, no timestamp
    "claude-cycle", // bare prefix, no timestamp
    "some-claude-cycle-2026-07-18-2101", // timestamp shape but not prefix-anchored
  ];

  for (const cycleId of UNDECODABLE_IDS) {
    test(`'${cycleId}' stays undefined → unclassified sentinel`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }

  test("never throws on a target-build-shaped cycleId (no crash path)", () => {
    assert.doesNotThrow(() => classifyAnchorType("claude-cycle-2026-07-18-2101", undefined));
    assert.doesNotThrow(() => inferAnchorTypeFromCycleId("claude-cycle-2026-07-18-2101"));
  });
});
}

// ===========================================================================
// Merged from test/anchor-type-branch-fallback-3579.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Issue #3579 — the merge-watch FIRST-WRITE branch-fallback decode leg.
 *
 * ## The gap this pins
 *
 * When the merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`)
 * fires the merged-status enrichment for a PR that reap NEVER wrote a cycle-record
 * for (the qa_orch relay / dropped-arm case), that enrichment is the FIRST write.
 * Its cycleId is the raw dispatch id — frequently a bare UUID
 * (`afa22ef1-7e11-…`) that carries no decodable class token. Live telemetry
 * (2026-07-23) showed such first-writes bucketing to the `unclassified` sentinel
 * even when the merged PR's HEAD BRANCH did carry a decodable
 * `worktree-agent-<tok>-t{N}-<slot>` fence (e.g. `worktree-agent-afa22ef1-t2-dev_orch-3564`).
 *
 * The #2822 invariant (pinned in `classify-anchor-type-unclassified-2822.test.mts`)
 * stands: a cycleId with NO decodable token and NO explicit anchorType must land
 * the honest `unclassified` sentinel — never a fabricated class. This suite pins
 * the ORTHOGONAL improvement: when the caller ALSO supplies a decodable branch
 * ref (the merged PR's headRefName), `classifyAnchorType` decodes the class from
 * THAT ref using the EXACT SAME fence parser. It is not a guess — only a real
 * `-t{N}-<slot>` fence in the branch decodes; a bare-hash / descriptive branch
 * still returns the sentinel. So the #2822 "never guess" contract is preserved:
 * the branch is a second SOURCE of the same honest decode, not a fallback guess.
 */






describe("classifyAnchorType — merge-watch branch-fallback decode (#3579)", () => {
  test("undecodable bare-UUID cycleId + decodable fenced branch → decodes from branch", () => {
    // The live #3579 case: cycleId is the bare UUID, but the merged PR's head
    // branch carries the full `-t2-dev_orch` fence. `dev_orch` → `work-queue`.
    const result = classifyAnchorType(
      "afa22ef1-7e11-41e6-a78f-c725b46c7870", // bare UUID — no class token
      undefined, // no explicit anchorType (arm dropped it)
      "worktree-agent-afa22ef1-t2-dev_orch-3564", // head branch — decodable fence
    );
    assert.equal(
      result,
      "work-queue",
      "a decodable head branch must classify the first-write when the cycleId can't",
    );
  });

  test("branch fence carrying a signal class (qa_orch) decodes to its lane", () => {
    const result = classifyAnchorType(
      "b8a3071f-a783-4e1a-9c2d-0011deadbeef",
      undefined,
      "worktree-agent-b8a3071f-t1-qa_orch",
    );
    assert.equal(result, "qa-review");
  });

  test("prefix-less fenced branch (no worktree-agent- prefix) still decodes", () => {
    // The relay-shaped branch `<runtoken>-t{N}-<slot>` the reconcile path can see.
    const result = classifyAnchorType(
      "6fd1300b-0000-0000-0000-000000000000",
      undefined,
      "6fd1300b-t1-research_orch",
    );
    assert.equal(result, "research");
  });

  test("#2822 PRESERVED: undecodable cycleId + UNDECODABLE branch → sentinel", () => {
    // Both the cycleId AND the head branch are bare hashes / descriptive names
    // with no class token — the 18/19 live majority. Fabricating a class here
    // would violate #2822; the honest sentinel is correct.
    for (const branch of [
      "worktree-agent-a101470ed2d2384fa", // bare harness hash — no fence
      "issue-3527-pino-pattern-memory", // descriptive branch — no class token
      "docs/graduate-memory-gotchas-to-claude-md",
      "", // empty branch ref
    ]) {
      const result = classifyAnchorType(
        "145669af-ab4f-4d4b-aa18-cc1525e8db93",
        undefined,
        branch,
      );
      assert.equal(
        result,
        UNCLASSIFIED_ANCHOR_TYPE,
        `undecodable cycleId + undecodable branch '${branch}' must stay unclassified`,
      );
    }
  });

  test("explicit anchorType wins over branch decode (no clobber)", () => {
    // When the arm DID forward an explicit anchorType, that is authoritative —
    // the branch fallback must never override a caller-supplied classification.
    const result = classifyAnchorType(
      "afa22ef1-7e11-41e6-a78f-c725b46c7870",
      "grill", // explicit — e.g. a design_concept_orch arm
      "worktree-agent-afa22ef1-t2-dev_orch-3564", // branch says work-queue
    );
    assert.equal(result, "grill", "an explicit anchorType is authoritative");
  });

  test("cycleId decode wins over branch (cycleId is the primary source)", () => {
    // When the cycleId ITSELF decodes, the branch is never consulted — the
    // cycleId is the primary, more-specific source.
    const result = classifyAnchorType(
      "worktree-agent-afa22ef1-t2-qa_orch", // decodable → qa-review
      undefined,
      "worktree-agent-afa22ef1-t2-dev_orch-3564", // branch → work-queue (ignored)
    );
    assert.equal(result, "qa-review", "a decodable cycleId is the primary source");
  });

  test("omitting the branch arg preserves the exact prior two-arg behaviour", () => {
    // Back-compat: every existing caller passes two args. A decodable cycleId
    // still decodes; an undecodable one still lands the sentinel.
    assert.equal(
      classifyAnchorType("worktree-agent-x-t2-dev_orch", undefined),
      "work-queue",
    );
    assert.equal(
      classifyAnchorType("145669af-ab4f-4d4b-aa18-cc1525e8db93", undefined),
      UNCLASSIFIED_ANCHOR_TYPE,
    );
  });

  test("never throws on a malformed / non-string branch ref", () => {
    assert.doesNotThrow(() =>
      classifyAnchorType("145669af-ab4f", undefined, undefined),
    );
    assert.doesNotThrow(() =>
      classifyAnchorType("145669af-ab4f", undefined, "   "),
    );
  });
});
}

// ===========================================================================
// Merged from test/no-attribution-shape-3623.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Issue #3623 — `no-attribution` shape diagnostic.
 *
 * The #3602 sub-bucket split already separates the `unclassified` sentinel into
 * `fixable` (a second decode source recovers a lane) vs `no-attribution`
 * (structurally undecodable — inherent harness noise under the #2822 never-guess
 * invariant). But `no-attribution` was a single OPAQUE count: an operator asking
 * "WHY are these 14 cycles undecodable?" had to fetch each cycleId/branch and
 * re-derive the shape by hand (a bare-UUID merge-watch first-write behaves
 * differently from an `autopilot-<hash>-t{N}` relay id or a bare
 * `worktree-agent-<longhash>` harness branch — but the bucket erased that).
 *
 * `classifyNoAttributionShape` labels each no-attribution cycle with the STABLE
 * kebab-case shape token that explains its undecodability, so the residue is
 * self-documenting — the issue's "document the undecodable shape" success
 * criterion. It is PURE (string inputs only, zero Redis/async) and NEVER guesses
 * a lane — it only names the structural reason a cycle carries no class token.
 */





describe("classifyNoAttributionShape — names the undecodable structural shape (#3623)", () => {
  test("a bare-UUID cycleId with no branch is `bare-uuid` (merge-watch first-write)", () => {
    // The dominant residual: a merge-status enrichment / cycle-merge-reconcile
    // first-write keyed on a bare UUID with no worktreeBranch to decode.
    assert.equal(
      classifyNoAttributionShape("72d9770f-40b9-41b9-bea4-59c93f1e2ebe", undefined),
      "bare-uuid",
    );
  });

  test("an `autopilot-<hash>-t{N}` cycleId is `autopilot-turn` (no slot token)", () => {
    // The autopilot's own turn-scoped cycleId carries a `-t{N}` turn fence but
    // NO trailing `-<slot>` class token, so it is undecodable by design.
    assert.equal(
      classifyNoAttributionShape("autopilot-2b5a625c-t2", undefined),
      "autopilot-turn",
    );
    assert.equal(
      classifyNoAttributionShape("autopilot-2b5a625c-t1", undefined),
      "autopilot-turn",
    );
  });

  test("a bare `worktree-agent-<longhash>` (cycleId or branch) is `harness-branch`", () => {
    // The harness's own Agent-tool branch name — no `-t{N}-<slot>` fence. The
    // #2822 invariant deliberately excludes it. This is the shape whether the
    // longhash arrives as the cycleId itself or as the stored worktreeBranch.
    assert.equal(
      classifyNoAttributionShape("worktree-agent-a0f1d230dcdda8f78", undefined),
      "harness-branch",
    );
    assert.equal(
      classifyNoAttributionShape(
        "afa22ef1-7e11-41e6-a78f-c725b46c7870",
        "worktree-agent-2b5a625cdeadbeefcafef00dba5eba11",
      ),
      "harness-branch",
    );
  });

  test("a descriptive branch (no class token) is `descriptive-branch`", () => {
    // A human/feature branch like `feat/3605-...` or `vlm-claude-cli-shim-3542`
    // carries an issue number but no dispatch-class token — undecodable.
    assert.equal(
      classifyNoAttributionShape(
        "72d9770f-40b9-41b9-bea4-59c93f1e2ebe",
        "feat/3605-extract-prune-design-concept-index",
      ),
      "descriptive-branch",
    );
    assert.equal(
      classifyNoAttributionShape(
        "4a2fc33e-9478-49dc-88cd-69dd393787dd",
        "vlm-claude-cli-shim-3542",
      ),
      "descriptive-branch",
    );
  });

  test("an unrecognised shape falls back to the honest `unknown-shape` token", () => {
    // Never guess: a cycleId that fits no known undecodable pattern still gets a
    // stable, non-empty token so the caller never has to reason about undefined.
    assert.equal(classifyNoAttributionShape("", undefined), "unknown-shape");
    assert.equal(
      classifyNoAttributionShape("something-weird-and-novel", undefined),
      "unknown-shape",
    );
  });

  test("the branch shape takes precedence when the cycleId alone is a bare UUID", () => {
    // A bare-UUID cycleId WITH a stored branch is more precisely explained by the
    // branch shape (harness-branch / descriptive-branch) than the generic
    // bare-uuid, so the branch is consulted first when present.
    assert.equal(
      classifyNoAttributionShape(
        "72d9770f-40b9-41b9-bea4-59c93f1e2ebe",
        "worktree-agent-a0f1d230dcdda8f78",
      ),
      "harness-branch",
    );
  });
});
}
