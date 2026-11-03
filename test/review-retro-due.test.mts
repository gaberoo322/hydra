/**
 * Review-findings retro policy (issue #5271, R2): due derivation, ladder,
 * caps, PR path allowlist, prune, cue grammar, the Redis-only route and the
 * Turn Snapshot fold. Pure + injected deps: no Redis, no gh.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  armSlug,
  cohortTripSlug,
  deriveReviewRetroDue,
  hotSpotSlug,
  isReviewPrDiffAllowed,
  planCohortTripIssue,
  planReviewEmit,
  pruneCandidates,
  reviewCue,
  slugify,
  REVIEW_RETRIP_MIN_DAYS,
} from "../src/qa/review-retro.ts";
import type { ReviewFindingArm } from "../src/qa/review-findings-extract.ts";
import { KEBAB_CUE, REVIEW_CUE, parseArgs } from "../src/retro-inputs.ts";
import { computeReviewRetro } from "../src/api/review-retro.ts";
import { foldReviewRetroDue } from "../src/autopilot/turn-snapshot/afk-frontier.ts";
import type { RetroSeenEntry } from "../src/redis/retro-seen.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-03T00:00:00Z");

const ruleArm = (key: string): ReviewFindingArm => ({ arm: "rule-cross-pr", key, prs: [1, 2, 3] });
const entry = (cue: string, ref: string | null, ageDays: number): RetroSeenEntry => ({
  cue,
  decision: "issue",
  runId: "r1",
  ref,
  at: new Date(NOW - ageDays * DAY).toISOString(),
});
const seenOf = (...es: RetroSeenEntry[]): Record<string, RetroSeenEntry> =>
  Object.fromEntries(es.map((e) => [e.cue, e]));

describe("review cue grammar and slugs", () => {
  test("REVIEW_CUE accepts review cues and KEBAB_CUE stays colon-free", () => {
    assert.ok(REVIEW_CUE.test("review:check:rule-cross-pr-std-x"));
    assert.ok(REVIEW_CUE.test("review:mechanical:cohort-trip-2026-11-03"));
    assert.ok(!REVIEW_CUE.test("review:bogus:x"));
    assert.ok(!REVIEW_CUE.test("review:check:Bad_Slug"));
    assert.ok(!KEBAB_CUE.test("review:check:x"));
  });

  test("slugify lowercases, collapses runs and trims", () => {
    assert.equal(slugify("STD-DESIGN-X"), "std-design-x");
    assert.equal(slugify("src/a/b.ts"), "src-a-b-ts");
    assert.equal(slugify("--A  B--"), "a-b");
  });

  test("armSlug is pure and deterministic per arm", () => {
    assert.equal(armSlug(ruleArm("STD-A")), "rule-cross-pr-std-a");
    assert.equal(armSlug({ arm: "file-cross-pr", key: "src/x.ts", prs: [] }), "file-cross-pr-src-x-ts");
    assert.equal(armSlug({ arm: "rule-same-pr-rounds", key: "STD-A", pr: 1, rounds: [1] }), "rule-same-pr-rounds-std-a");
    assert.equal(armSlug({ arm: "file-same-pr-rounds", key: "a.ts", pr: 1, rounds: [1] }), "file-same-pr-rounds-a-ts");
    assert.equal(armSlug({ arm: "pair-miss", prs: [1], count: 1 }), "pair-miss");
    assert.equal(armSlug({ arm: "detector-gap", key: "Gap_Class", prs: [] }), "detector-gap-gap-class");
    assert.equal(hotSpotSlug("src/x.ts"), "hot-spot-src-x-ts");
    assert.equal(cohortTripSlug("2026-11-03T00:00:00Z"), "cohort-trip-2026-11-03t00-00-00z");
    assert.ok(REVIEW_CUE.test(reviewCue("fence", armSlug(ruleArm("STD-A")))));
  });

  test("parseArgs --review sets review only when present", () => {
    assert.deepEqual(parseArgs(""), { apply: false });
    assert.deepEqual(parseArgs("--apply --review"), { apply: true, review: true });
    assert.deepEqual(parseArgs("abc --review"), { apply: false, runId: "abc", review: true });
  });
});

describe("deriveReviewRetroDue", () => {
  test("unseen slug is due at the check rung", () => {
    const r = deriveReviewRetroDue([ruleArm("STD-A")], {}, NOW);
    assert.equal(r.due, true);
    assert.equal(r.candidates[0]?.nextRung, "check");
  });

  test("no arms is not due", () => {
    assert.deepEqual(deriveReviewRetroDue([], {}, NOW), { due: false, candidates: [] });
  });

  test("a fresh emit is not due; an old one is due one rung up", () => {
    const cue = reviewCue("check", "rule-cross-pr-std-a");
    assert.equal(deriveReviewRetroDue([ruleArm("STD-A")], seenOf(entry(cue, "1", 1)), NOW).due, false);
    const old = deriveReviewRetroDue([ruleArm("STD-A")], seenOf(entry(cue, "1", REVIEW_RETRIP_MIN_DAYS)), NOW);
    assert.equal(old.due, true);
    assert.equal(old.candidates[0]?.nextRung, "standard");
  });

  test("fence is terminal even when old", () => {
    const cue = reviewCue("fence", "rule-cross-pr-std-a");
    assert.equal(deriveReviewRetroDue([ruleArm("STD-A")], seenOf(entry(cue, "1", 90)), NOW).due, false);
  });
});

describe("planReviewEmit ladder and caps", () => {
  test("first emit is a check-rung issue", () => {
    const p = planReviewEmit([ruleArm("STD-A")], {}, new Set());
    assert.equal(p.issues[0]?.cue, "review:check:rule-cross-pr-std-a");
    assert.equal(p.pr, null);
  });

  test("an open prior emit emits nothing (prior-emit-open)", () => {
    const cue = reviewCue("check", "rule-cross-pr-std-a");
    const p = planReviewEmit([ruleArm("STD-A")], seenOf(entry(cue, "7", 30)), new Set());
    assert.deepEqual(p.skipped, [{ slug: "rule-cross-pr-std-a", reason: "prior-emit-open" }]);
    assert.equal(p.issues.length + (p.pr ? 1 : 0), 0);
  });

  test("an open prior emit is rechecked and, once re-stamped, is not due on consecutive days", () => {
    const cue = reviewCue("check", "rule-cross-pr-std-a");
    const arms = [ruleArm("STD-A")];
    const old = entry(cue, "7", 10);
    assert.equal(deriveReviewRetroDue(arms, seenOf(old), NOW).due, true);
    const p = planReviewEmit(arms, seenOf(old), new Set());
    assert.equal(p.recheck.length, 1);
    const bumped = { ...p.recheck[0]!.entry, at: new Date(NOW).toISOString() };
    assert.equal(deriveReviewRetroDue(arms, seenOf(bumped), NOW + DAY).due, false);
    assert.equal(deriveReviewRetroDue(arms, seenOf(bumped), NOW + REVIEW_RETRIP_MIN_DAYS * DAY).due, true);
  });

  test("sibling: a closed prior emit and a first emit have no recheck", () => {
    const cue = reviewCue("check", "rule-cross-pr-std-a");
    assert.deepEqual(planReviewEmit([ruleArm("STD-A")], seenOf(entry(cue, "7", 30)), new Set(["7"])).recheck, []);
    assert.deepEqual(planReviewEmit([ruleArm("STD-A")], {}, new Set()).recheck, []);
  });

  test("a closed prior emit re-trips exactly one rung up", () => {
    const check = reviewCue("check", "rule-cross-pr-std-a");
    const p = planReviewEmit([ruleArm("STD-A")], seenOf(entry(check, "7", 30)), new Set(["7"]));
    assert.equal(p.pr?.rung, "standard");
    const std = reviewCue("standard", "rule-cross-pr-std-a");
    const p2 = planReviewEmit([ruleArm("STD-A")], seenOf(entry(check, "7", 60), entry(std, "8", 30)), new Set(["7", "8"]));
    assert.equal(p2.pr?.rung, "fence");
  });

  test("fence is ladder-exhausted", () => {
    const fence = reviewCue("fence", "rule-cross-pr-std-a");
    const p = planReviewEmit([ruleArm("STD-A")], seenOf(entry(fence, "9", 30)), new Set(["9"]));
    assert.equal(p.skipped[0]?.reason, "ladder-exhausted");
  });

  test("caps: 2 issues and 1 PR, overflow is named", () => {
    const arms = [ruleArm("A"), ruleArm("B"), ruleArm("C")];
    const p = planReviewEmit(arms, {}, new Set());
    assert.equal(p.issues.length, 2);
    assert.deepEqual(p.skipped, [{ slug: "rule-cross-pr-c", reason: "review-issue-cap-reached" }]);

    const seen = seenOf(
      entry(reviewCue("check", "rule-cross-pr-d"), "1", 30),
      entry(reviewCue("check", "rule-cross-pr-e"), "2", 30),
    );
    const q = planReviewEmit([ruleArm("D"), ruleArm("E")], seen, new Set(["1", "2"]));
    assert.equal(q.pr?.slug, "rule-cross-pr-d");
    assert.deepEqual(q.skipped, [{ slug: "rule-cross-pr-e", reason: "review-pr-cap-reached" }]);
  });

  test("cohort trip issue is mechanical and not double-filed", () => {
    const first = planCohortTripIssue("2026-11-03T00:00:00Z", {});
    assert.equal(first?.cue, "review:mechanical:cohort-trip-2026-11-03t00-00-00z");
    assert.equal(planCohortTripIssue("2026-11-03T00:00:00Z", seenOf(entry(first!.cue, "1", 1))), null);
    assert.equal(planCohortTripIssue(null, {}), null);
  });
});

describe("isReviewPrDiffAllowed and pruneCandidates", () => {
  test("only CODING_STANDARDS.md and CLAUDE.md are allowed", () => {
    assert.equal(isReviewPrDiffAllowed(["CODING_STANDARDS.md"]), true);
    assert.equal(isReviewPrDiffAllowed(["CLAUDE.md", "CODING_STANDARDS.md"]), true);
    assert.equal(isReviewPrDiffAllowed([]), false);
    assert.equal(isReviewPrDiffAllowed(["CLAUDE.md", "docs/operator-playbooks/hydra-qa.md"]), false);
    assert.equal(isReviewPrDiffAllowed(["src/qa/fold.ts"]), false);
  });

  test("pruneCandidates returns uncited reviewer rules within the 90-day window", () => {
    const rows = [
      { kind: "finding", rule: "STD-A", at: new Date(NOW - DAY).toISOString() },
      { kind: "finding", rule: "STD-B", at: new Date(NOW - 100 * DAY).toISOString() },
      { kind: "pair-miss", rule: "STD-C", at: new Date(NOW).toISOString() },
    ];
    assert.deepEqual(pruneCandidates(["STD-A", "STD-B", "STD-C", "STD-B"], rows, NOW), ["STD-B", "STD-C"]);
  });
});

describe("the Redis-only route and the Turn Snapshot fold", () => {
  const rowAt = (pr: number, rule: string) => ({
    kind: "finding",
    pr,
    round: 1,
    sha: "s",
    at: new Date(NOW - DAY).toISOString(),
    source: "route",
    severity: "medium",
    axis: "standards",
    location: "src/x.ts:1",
    file: "src/x.ts",
    rule,
    finding: `${rule} problem`,
    reviewers: [],
  });

  test("computeReviewRetro derives due from rows and seen only", async () => {
    const rows = [1, 2, 3].map((pr) => rowAt(pr, "STD-A"));
    const snap = await computeReviewRetro({ readRows: async () => rows, readSeen: async () => ({}), now: () => NOW });
    assert.equal(snap.due, true);
    assert.ok(snap.arms.some((a) => a.arm === "rule-cross-pr"));
    assert.ok(Array.isArray(snap.hotSpots) && Array.isArray(snap.warnings));
    const quiet = await computeReviewRetro({ readRows: async () => [], readSeen: async () => ({}), now: () => NOW });
    assert.equal(quiet.due, false);
  });

  test("foldReviewRetroDue is fail-closed", () => {
    assert.equal(foldReviewRetroDue(JSON.stringify({ due: true })), true);
    assert.equal(foldReviewRetroDue(JSON.stringify({ due: false })), false);
    assert.equal(foldReviewRetroDue(JSON.stringify({ due: "true" })), false);
    assert.equal(foldReviewRetroDue("not json"), false);
    assert.equal(foldReviewRetroDue(null), false);
  });
});
