/**
 * Regression test for issue #3957 — the wire-or-retire playbook restates its
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
 * This test is the drift guard the issue asked for. It slices each of the four
 * restatement sites out of the playbook and asserts every one enumerates ALL
 * four protected carve-out families. A future edit that drops providers/ (or
 * risk/, execution/, or the money-movement records) from any one site fails
 * this test instead of silently reintroducing the #3957 contradiction.
 *
 * The four sites, each sliced by stable surrounding prose:
 *   1. Step 2's interim hardcoded carve-out list.
 *   2. The pre-template prose restatement ("... passed the carve-out ...").
 *   3. The RETIRE-task template's precondition bullet — intentionally a
 *      SELF-CONTAINED duplicate: that template block is copied verbatim into a
 *      hydra-betting GitHub issue body per the playbook's own step 5 (a
 *      different repo, a different reader with no access to this playbook), so
 *      its inline carve-out list can never become a "see Step 2" cross-reference.
 *      This test asserts its CONTENT (that it still lists every family inline),
 *      never that it cross-references Step 2.
 *   4. The post-template "rule 1 restated" rationale.
 *
 * Method mirrors test/verifier-core-docs-drift.test.mts: read the playbook as
 * plain text, slice each restatement region between two markers, and assert the
 * canonical carve-out families are all present. `wagers` is phrased variably
 * ("web/src/lib/wagers/ record-*" vs "money-movement record modules") across the
 * sites, so each family carries the set of literals that satisfy it.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = "docs/operator-playbooks/hydra-wire-or-retire.md";

/**
 * The four protected carve-out families. Every restatement site must mention
 * ALL four — that is exactly the invariant #3957 restores and pins. `wagers` is
 * phrased as either the literal path or "money-movement record" depending on
 * the site, so a site satisfies it via any one of its literals.
 */
const CARVEOUT_FAMILIES: { name: string; anyOf: string[] }[] = [
  { name: "risk (web/src/lib/risk/)", anyOf: ["web/src/lib/risk/"] },
  { name: "execution (web/src/lib/execution/)", anyOf: ["web/src/lib/execution/"] },
  { name: "providers (web/src/lib/providers/)", anyOf: ["web/src/lib/providers/"] },
  {
    name: "wagers money-movement records",
    anyOf: ["web/src/lib/wagers/", "money-movement record"],
  },
];

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

/** The four restatement sites, each pinned by stable surrounding prose. */
function carveoutSites(text: string): { label: string; region: string }[] {
  return [
    {
      label: "Step 2 interim hardcoded carve-out list",
      region: sliceBetween(text, "Interim hardcoded carve-out list", "Rationale: retiring or rewiring"),
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

describe("hydra-wire-or-retire carve-out drift guard (issue #3957)", () => {
  const text = readDoc();

  describe("every carve-out restatement site enumerates all four protected families", () => {
    for (const site of carveoutSites(text)) {
      describe(`site: ${site.label}`, () => {
        for (const family of CARVEOUT_FAMILIES) {
          test(`mentions the ${family.name} family`, () => {
            const present = family.anyOf.some((lit) => site.region.includes(lit));
            assert.ok(
              present,
              `${site.label} does not mention the ${family.name} carve-out family ` +
                `(looked for any of ${JSON.stringify(family.anyOf)}). ` +
                `The four restatement sites of the carve-out list must stay in sync — ` +
                `see issue #3957 and Target CLAUDE.md rule 1.`,
            );
          });
        }
      });
    }
  });

  test("the playbook restates the providers carve-out in exactly four sites", () => {
    // providers/ is the family #3957 restored to all four sites, so its literal
    // count is the cleanest canary for the site count itself: one occurrence per
    // restatement site. A site silently added or removed fails here so the guard
    // is updated deliberately rather than passing vacuously.
    const providersOccurrences = text.split("web/src/lib/providers/").length - 1;
    assert.equal(
      providersOccurrences,
      4,
      `expected exactly 4 restatements of "web/src/lib/providers/" (one per carve-out site), ` +
        `found ${providersOccurrences} — a carve-out site was added or removed without updating this guard`,
    );
  });

  test("the RETIRE-task template stays self-contained (inline list, never a Step-2 cross-reference)", () => {
    // The template block is copied verbatim into a hydra-betting issue body,
    // so its precondition bullet must carry the full inline carve-out list —
    // never "see Step 2". This pins that the inline providers/ entry survives
    // inside the template specifically (the self-contained duplicate is by
    // design, per the #3957 design-concept invariant 2).
    const region = sliceBetween(text, "Preconditions (already checked", "If your deletion would touch");
    assert.ok(
      region.includes("web/src/lib/providers/"),
      "the RETIRE-task template's precondition bullet must list providers/ inline " +
        "(self-contained — the template is portable into a hydra-betting issue body)",
    );
  });
});
