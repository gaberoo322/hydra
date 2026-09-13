/**
 * Regression test for issue #3957 — the wire-or-retire playbook restated its
 * hard carve-out list (risk / live-execution / providers / wagers
 * money-movement record modules) in FOUR places, and two of them had silently
 * dropped `web/src/lib/providers/` — contradicting both the other two sites
 * and Target `CLAUDE.md` rule 1 ("Never delete files in src/lib/providers/").
 * A live `wire_or_retire_target` run on 2026-08-11 hit exactly this: three
 * providers/ files passed the step-2 carve-out check (because step 2 did not
 * name providers/), then failed the rule-1 constraint later in the flow and had
 * to be split off into a separate ready-for-human issue instead of being routed
 * at step 2 as the carve-out intends.
 *
 * ISSUE #4411 FLIP: the #3957 fix was "four hardcoded restatements must stay in
 * sync". Issue #4411 deleted the hardcoded carve-out list entirely —
 * decide.py's `WIRE_OR_RETIRE_RISK_CARVEOUT` constant is gone, and every
 * `wire_or_retire_target` dispatch now threads `prompt_args.risk_carveout`
 * straight from the Target Manifest's `riskCritical.surface`
 * (`scripts/target/print-target-facts.ts`, ADR-0026). There is no longer a
 * SECOND copy of the carve-out list to drift out of sync with a first — the
 * manifest is read once, by collect-state.sh, and every consumer downstream
 * (decide.py's dispatch, this playbook's step 2, its RETIRE-task template)
 * reads the SAME `prompt_args.risk_carveout` value. So the #3957 drift class
 * is structurally impossible now, not just guarded against.
 *
 * This test is FLIPPED (CLAUDE.md order: rewrite the pinned-old-behavior case
 * before adding new coverage) from asserting "all four sites enumerate the
 * same four hardcoded path families" to asserting the new invariant: every
 * site that used to restate the hardcoded list now references
 * `prompt_args.risk_carveout` consistently, AND no target-identity-hardcoded
 * carve-out literal (`web/src/lib/risk/`, `web/src/lib/execution/`,
 * `web/src/lib/providers/`, `web/src/lib/wagers/`) has crept back into the
 * document — that would be the #3957 drift class reappearing in a new form
 * (a stray hardcoded family alongside the dynamic reference, rather than two
 * out-of-sync hardcoded lists).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = "docs/operator-playbooks/hydra-wire-or-retire.md";

function readDoc(): string {
  return readFileSync(resolve(REPO_ROOT, PLAYBOOK), "utf-8");
}

/** Slice the substring between two markers (exclusive of the start marker). */
function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `could not find marker ${JSON.stringify(startMarker)} in ${PLAYBOOK}`);
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  assert.ok(end >= 0, `could not find end marker ${JSON.stringify(endMarker)} in ${PLAYBOOK}`);
  return text.slice(from, end);
}

/**
 * The four historical restatement sites (#3957), re-anchored to the
 * post-#4411 text. Each must now reference `prompt_args.risk_carveout` rather
 * than a hardcoded family list.
 */
function carveoutSites(text: string): { label: string; region: string }[] {
  return [
    {
      label: "Step 2 hard carve-out description",
      region: sliceBetween(text, "### 2. Hard carve-out", "### 3. Recover the intent"),
    },
    {
      label: "pre-template prose restatement",
      region: sliceBetween(text, "passed the carve-out", "receives a RETIRE task"),
    },
    {
      label: "RETIRE-task template precondition bullet",
      region: sliceBetween(text, "Preconditions (already checked", "If your deletion would touch"),
    },
    {
      label: "post-template 'rule 1 restated' rationale",
      region: sliceBetween(
        text,
        "Why this is the only sanctioned deletion path",
        "this template is never emitted for them",
      ),
    },
  ];
}

describe("hydra-wire-or-retire carve-out drift guard (issue #3957, flipped by #4411)", () => {
  const text = readDoc();

  describe("every carve-out restatement site references prompt_args.risk_carveout (not a hardcoded list)", () => {
    for (const site of carveoutSites(text)) {
      test(`site "${site.label}" mentions prompt_args.risk_carveout`, () => {
        assert.ok(
          site.region.includes("risk_carveout"),
          `${site.label} does not reference risk_carveout — every site that used to ` +
            `restate the #3957 hardcoded carve-out list must now point at the manifest-` +
            `sourced prompt_args.risk_carveout (issue #4411) so there is a SINGLE source ` +
            `of truth, not a second copy that can drift.`,
        );
      });
    }
  });

  test("no hardcoded carve-out family literal has crept back into the playbook (issue #4411)", () => {
    // The #3957 drift class was two hardcoded lists disagreeing. Re-introducing
    // ANY hardcoded family literal here — even a single one, even in only one
    // site — reopens exactly that class in a new shape (a stray hardcoded
    // family that silently overrides or contradicts the manifest-sourced
    // value). None of these may appear anywhere in the document.
    const forbiddenLiterals = [
      "web/src/lib/risk/",
      "web/src/lib/execution/",
      "web/src/lib/providers/",
      "web/src/lib/wagers/",
    ];
    for (const literal of forbiddenLiterals) {
      assert.ok(
        !text.includes(literal),
        `found a reintroduced hardcoded carve-out literal ${JSON.stringify(literal)} — ` +
          `issue #4411 re-sourced the carve-out from prompt_args.risk_carveout (the Target ` +
          `Manifest's riskCritical.surface); a hardcoded path family here reopens the #3957 ` +
          `drift class.`,
      );
    }
  });

  test("the RETIRE-task template stays self-contained (references risk_carveout inline, never a bare Step-2 cross-reference)", () => {
    // The template block is copied verbatim into a Target issue body, so its
    // precondition bullet must carry an inline, self-contained description —
    // never "see Step 2" with no further context (the issue-body reader has
    // no access to this playbook). It must reference prompt_args.risk_carveout
    // by name so the precondition is checkable against the dispatch record
    // that produced it, per the #3957 design-concept invariant 2 carried
    // forward by #4411.
    const region = sliceBetween(text, "Preconditions (already checked", "If your deletion would touch");
    assert.ok(
      region.includes("prompt_args.risk_carveout"),
      "the RETIRE-task template's precondition bullet must reference prompt_args.risk_carveout " +
        "inline (self-contained — the template is portable into a Target issue body)",
    );
  });
});
