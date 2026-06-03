/**
 * Regression tests for the /hydra-retro skill's pure caps / dedup /
 * recurrence-gate logic (issue #919, epic #917).
 *
 * `scripts/ci/hydra-retro-emit.ts` is the testable core of the retrospective
 * emit pipeline: given the surviving (post-adversarial-self-check) findings and
 * a snapshot of the cross-run dedup + recurrence ledgers, it produces a
 * deterministic emit plan. These tests guard the four contracts the epic
 * mandates:
 *
 *   1. CAPS — at most 2 GitHub issues (code gotchas) and at most 1 gated PR
 *      (prompt/doc fixes) per run; the overflow is recorded artifact-only, not
 *      dropped silently.
 *   2. DEDUP — a cue already in the seen-list is never re-proposed, regardless
 *      of kind.
 *   3. RECURRENCE + CONFIDENCE GATE — a prompt-shaped fix is only PR-eligible
 *      when its cue recurred ≥3× AND its confidence clears the floor.
 *   4. DETERMINISM — input order is the only tie-break; the same inputs always
 *      yield the same plan.
 *
 * Plus the validation + arg-parsing helpers (kebab-case cue grammar, dry-run
 * default). The module is pure — no fs/network/Redis — so these run in
 * milliseconds with zero setup, mirroring test/hydra-prd-template.test.mts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planEmit,
  validateFindings,
  parseArgs,
  MAX_ISSUES_PER_RUN,
  MAX_PRS_PER_RUN,
  RECURRENCE_THRESHOLD,
  PROMPT_FIX_MIN_CONFIDENCE,
  type RetroFinding,
  type RetroLedgers,
} from "../scripts/ci/hydra-retro-emit.ts";

function code(cue: string, confidence = 0.9): RetroFinding {
  return { cue, kind: "code", title: `Code: ${cue}`, confidence };
}
function prompt(cue: string, confidence = 0.9): RetroFinding {
  return { cue, kind: "prompt", title: `Prompt: ${cue}`, confidence };
}
function ledgers(
  opts: Partial<RetroLedgers> = {},
): RetroLedgers {
  return {
    seenCues: opts.seenCues ?? new Set<string>(),
    recurrence: opts.recurrence ?? {},
  };
}

// Recurrence map that clears the gate for the given cues.
function recurring(...cues: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of cues) m[c] = RECURRENCE_THRESHOLD;
  return m;
}

describe("planEmit — issue cap (code findings)", () => {
  test("files at most MAX_ISSUES_PER_RUN issues; overflow is artifact-only", () => {
    const findings = [code("a"), code("b"), code("c"), code("d")];
    const plan = planEmit(findings, ledgers());

    assert.equal(plan.issues.length, MAX_ISSUES_PER_RUN);
    assert.deepEqual(
      plan.issues.map((i) => i.cue),
      ["a", "b"],
      "first two code findings (input order) take the issue slots",
    );
    assert.ok(plan.issues.every((i) => i.lane === "issue"));

    // The two over the cap are recorded, not dropped.
    const overflowCues = plan.artifactOnly
      .filter((a) => a.reason === "issue-cap-reached")
      .map((a) => a.cue);
    assert.deepEqual(overflowCues, ["c", "d"]);
    assert.equal(plan.skipped.length, 0);
  });

  test("under the cap, every code finding becomes an issue", () => {
    const plan = planEmit([code("a"), code("b")], ledgers());
    assert.equal(plan.issues.length, 2);
    assert.equal(plan.artifactOnly.length, 0);
  });
});

describe("planEmit — PR cap + recurrence/confidence gate (prompt findings)", () => {
  test("a recurrence-gated, high-confidence prompt fix takes the single PR slot", () => {
    const plan = planEmit([prompt("p1")], ledgers({ recurrence: recurring("p1") }));
    assert.ok(plan.pr, "expected a planned PR");
    assert.equal(plan.pr!.cue, "p1");
    assert.equal(plan.pr!.lane, "pr");
  });

  test("at most MAX_PRS_PER_RUN PR; the second qualifier is pr-cap-reached", () => {
    const plan = planEmit(
      [prompt("p1"), prompt("p2")],
      ledgers({ recurrence: recurring("p1", "p2") }),
    );
    assert.equal(MAX_PRS_PER_RUN, 1);
    assert.equal(plan.pr!.cue, "p1", "first qualifier in input order wins the slot");
    const capped = plan.artifactOnly.filter((a) => a.reason === "pr-cap-reached");
    assert.deepEqual(capped.map((a) => a.cue), ["p2"]);
  });

  test("below the recurrence threshold → no PR, recorded below-recurrence-gate", () => {
    const recurrence = { p1: RECURRENCE_THRESHOLD - 1 };
    const plan = planEmit([prompt("p1")], ledgers({ recurrence }));
    assert.equal(plan.pr, null);
    assert.deepEqual(
      plan.artifactOnly.map((a) => ({ cue: a.cue, reason: a.reason })),
      [{ cue: "p1", reason: "below-recurrence-gate" }],
    );
  });

  test("a cue absent from the recurrence ledger counts as 0 → gated out", () => {
    const plan = planEmit([prompt("never-seen")], ledgers());
    assert.equal(plan.pr, null);
    assert.equal(plan.artifactOnly[0].reason, "below-recurrence-gate");
  });

  test("below the confidence floor → no PR even when recurrence passes", () => {
    const low = PROMPT_FIX_MIN_CONFIDENCE - 0.01;
    const plan = planEmit(
      [prompt("p1", low)],
      ledgers({ recurrence: recurring("p1") }),
    );
    assert.equal(plan.pr, null);
    assert.equal(plan.artifactOnly[0].reason, "below-confidence-gate");
  });

  test("confidence exactly at the floor passes", () => {
    const plan = planEmit(
      [prompt("p1", PROMPT_FIX_MIN_CONFIDENCE)],
      ledgers({ recurrence: recurring("p1") }),
    );
    assert.ok(plan.pr);
  });
});

describe("planEmit — dedup against the persisted seen-list", () => {
  test("a seen cue is hard-skipped regardless of kind", () => {
    const seenCues = new Set(["dup-code", "dup-prompt"]);
    const findings = [
      code("dup-code"),
      prompt("dup-prompt"),
      code("fresh"),
    ];
    const plan = planEmit(
      findings,
      ledgers({ seenCues, recurrence: recurring("dup-prompt") }),
    );

    assert.deepEqual(plan.issues.map((i) => i.cue), ["fresh"]);
    assert.equal(plan.pr, null, "the recurring prompt fix was deduped, not PR'd");
    const dups = plan.skipped.filter((s) => s.reason === "duplicate-seen-list");
    assert.deepEqual(dups.map((s) => s.cue).sort(), ["dup-code", "dup-prompt"]);
  });

  test("dedup is checked before the caps — a seen code cue doesn't consume an issue slot", () => {
    const seenCues = new Set(["seen"]);
    const plan = planEmit([code("seen"), code("a"), code("b")], ledgers({ seenCues }));
    assert.deepEqual(plan.issues.map((i) => i.cue), ["a", "b"]);
    assert.equal(plan.issues.length, 2);
  });
});

describe("planEmit — determinism + mixed routing", () => {
  test("same inputs yield the same plan", () => {
    const findings = [code("a"), prompt("p1"), code("b"), prompt("p2")];
    const led = () => ledgers({ recurrence: recurring("p1", "p2") });
    const a = planEmit(findings, led());
    const b = planEmit(findings, led());
    assert.deepEqual(a, b);
  });

  test("a full mixed run routes each lane correctly", () => {
    const findings = [
      code("c1"),
      code("c2"),
      code("c3"), // over the issue cap → artifact
      prompt("p1"), // recurring + confident → PR
      prompt("p2"), // recurring but PR slot taken → artifact
      prompt("p3", 0.5), // low confidence → artifact
    ];
    const plan = planEmit(
      findings,
      ledgers({ recurrence: recurring("p1", "p2") }),
    );

    assert.deepEqual(plan.issues.map((i) => i.cue), ["c1", "c2"]);
    assert.equal(plan.pr!.cue, "p1");

    const byReason: Record<string, string[]> = {};
    for (const a of plan.artifactOnly) {
      (byReason[a.reason] ??= []).push(a.cue);
    }
    assert.deepEqual(byReason["issue-cap-reached"], ["c3"]);
    assert.deepEqual(byReason["pr-cap-reached"], ["p2"]);
    assert.deepEqual(byReason["below-confidence-gate"], ["p3"]);
    assert.equal(plan.skipped.length, 0);
  });

  test("empty findings → an empty plan", () => {
    const plan = planEmit([], ledgers());
    assert.deepEqual(plan, { issues: [], pr: null, artifactOnly: [], skipped: [] });
  });
});

describe("validateFindings", () => {
  test("accepts a well-formed finding list", () => {
    assert.deepEqual(validateFindings([code("good-cue"), prompt("another-cue")]), []);
  });

  test("rejects a non-kebab-case cue", () => {
    const errs = validateFindings([{ cue: "Not Kebab", kind: "code", title: "t", confidence: 0.5 }]);
    assert.ok(errs.some((e) => e.field === "cue"));
  });

  test("rejects an out-of-range confidence", () => {
    const errs = validateFindings([{ cue: "ok-cue", kind: "code", title: "t", confidence: 1.5 }]);
    assert.ok(errs.some((e) => e.field === "confidence"));
  });

  test("rejects an unknown kind and an empty title", () => {
    const errs = validateFindings([
      // @ts-expect-error — exercising the runtime guard with a bad kind
      { cue: "ok-cue", kind: "doc", title: "", confidence: 0.5 },
    ]);
    assert.ok(errs.some((e) => e.field === "kind"));
    assert.ok(errs.some((e) => e.field === "title"));
  });

  test("a non-array input is a single top-level error", () => {
    // Cast to exercise the runtime guard against a non-array input.
    const errs = validateFindings(null as unknown as RetroFinding[]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].field, "findings");
  });
});

describe("parseArgs", () => {
  test("dry-run (audit) is the default", () => {
    assert.deepEqual(parseArgs(""), { apply: false });
    assert.deepEqual(parseArgs(null), { apply: false });
    assert.deepEqual(parseArgs("--audit"), { apply: false });
    assert.deepEqual(parseArgs("--dry-run"), { apply: false });
  });

  test("--apply is the explicit opt-in", () => {
    assert.equal(parseArgs("--apply").apply, true);
  });

  test("a positional token is the run id", () => {
    assert.deepEqual(parseArgs("run-123"), { apply: false, runId: "run-123" });
    assert.deepEqual(parseArgs("run-123 --apply"), { apply: true, runId: "run-123" });
  });

  test("unknown flags are ignored, not misparsed as the run id", () => {
    assert.deepEqual(parseArgs("--verbose run-9"), { apply: false, runId: "run-9" });
  });
});
