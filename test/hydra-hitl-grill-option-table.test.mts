/**
 * Drift-guard for the `/hydra-hitl-grill` playbook — the standalone drain for
 * the `hitl-grill` park lane — and for its split from `/hydra-review`.
 *
 * Two contracts are pinned:
 *
 *   1. The park lane is drained by `/hydra-hitl-grill` and the Work-page inbox
 *      ONLY. `/hydra-review` must neither gather nor report it (a parked idea
 *      blocks no AFK work, so it is not an operator-attention item), and the
 *      pickup aggregator behind the phone-notify hook mirrors that
 *      (test/review-pickup.test.mts). Prose that quietly re-grows the bucket in
 *      hydra-review.md fails here.
 *   2. The new skill's `AskUserQuestion` walk uses the same slot contract as
 *      /hydra-review §4 (slot 1 recommended, slot 4 always Skip, "Other" is the
 *      tool's) so the operator's muscle memory carries across both cockpits, and
 *      its safety rules — operator-only, dismiss-only cluster verdicts, writes
 *      through the board routes — are stated where the skill will read them.
 *
 * Same drift-guard-as-test pattern as test/hydra-review-option-table.test.mts:
 * readFileSync + regex over the in-repo PLAYBOOKS only, never the generated
 * skill under ~/.claude/skills/, and NO `gh` call.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOKS = join(REPO_ROOT, "docs", "operator-playbooks");
const grill = readFileSync(join(PLAYBOOKS, "hydra-hitl-grill.md"), "utf-8");
const review = readFileSync(join(PLAYBOOKS, "hydra-review.md"), "utf-8");

/** Slice the option table section up to the next `###` heading. */
function optionTable(): string {
  const start = grill.indexOf("## The canonical option table");
  assert.ok(start > -1, "the canonical option table section is missing");
  const end = grill.indexOf("### 5. Execute the verdict", start);
  assert.ok(end > start, "could not locate §5, which terminates the option table");
  return grill.slice(start, end);
}

/** Parse the markdown table rows into [situation, slot1..slot4]. */
function tableRows(): string[][] {
  return optionTable()
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l) && !l.includes("(Recommended)"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length === 5 && cells[0] !== "Situation");
}

describe("hydra-hitl-grill — canonical option table", () => {
  test("the four situations each declare exactly four slots", () => {
    const rows = tableRows();
    assert.deepEqual(
      rows.map((r) => r[0]),
      [
        "Scoped, premise holds",
        "Unscoped, premise holds",
        "Premise false or superseded",
        "Overlaps a map or epic",
      ],
      "the situation set is the classification output of §2 — change both together",
    );
    for (const cells of rows) {
      for (let i = 1; i <= 4; i++) {
        assert.ok(cells[i].length > 0, `situation "${cells[0]}" has an empty slot ${i}`);
      }
    }
  });

  test("slot 4 is ALWAYS Skip, and Skip appears nowhere else", () => {
    for (const cells of tableRows()) {
      assert.equal(cells[4], "Skip", `situation "${cells[0]}" must reserve slot 4 for Skip`);
      for (let i = 1; i <= 3; i++) {
        assert.notEqual(cells[i], "Skip", `situation "${cells[0]}" repeats Skip in slot ${i}`);
      }
    }
  });

  test("slot 1 is the recommendation and matches the classification it follows", () => {
    const bySituation = new Map(tableRows().map((r) => [r[0], r[1]]));
    assert.equal(bySituation.get("Scoped, premise holds"), "Promote");
    assert.equal(bySituation.get("Unscoped, premise holds"), "Scope and promote");
    assert.equal(bySituation.get("Premise false or superseded"), "Dismiss");
    assert.equal(bySituation.get("Overlaps a map or epic"), "Fold into owner");
  });

  test("the recommended-first, Other, and escape-hatch rules are stated", () => {
    const sec = optionTable();
    assert.match(sec, /Slot 1 is the recommended action/i);
    assert.match(sec, /slot 4 is always\s+Skip/i);
    assert.match(sec, /appended automatically by the tool/i);
    assert.match(sec, /Slots 2[–-]4 never change/i);
  });
});

describe("hydra-hitl-grill — safety rules", () => {
  test("is operator-interactive only and never an autopilot dispatch class", () => {
    assert.match(grill, /never dispatched by `\/hydra-autopilot`/i);
    assert.match(grill, /never named in\s+`scripts\/autopilot\/classes\.json`/i);
    const classes = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "autopilot", "classes.json"), "utf-8"),
    );
    assert.ok(
      !JSON.stringify(classes).includes("hydra-hitl-grill"),
      "classes.json must not dispatch hydra-hitl-grill — it is the admission valve, not a class",
    );
  });

  test("cluster verdicts are Dismiss-only; promotes are per item", () => {
    assert.match(grill, /Cluster verdicts are for Dismiss only/i);
    assert.match(grill, /Never batch a promote/i);
  });

  test("writes go through the board routes, never hand label edits", () => {
    assert.match(grill, /POST \/api\/autopilot\/board\/promote/);
    assert.match(grill, /POST \/api\/autopilot\/board\/close/);
    assert.match(grill, /Never `gh issue edit --add-label\/--remove-label`/);
    assert.match(grill, /"reason":"not planned"/, "dismiss must close not-planned so the dedup baseline survives");
  });

  test("ambiguity resolves to Skip, and every verdict leaves a comment", () => {
    assert.match(grill, /Ambiguous means Skip/i);
    assert.match(grill, /Verdict via \/hydra-hitl-grill/);
  });
});

describe("hydra-review — the hitl-grill bucket is gone", () => {
  test("no gather, report, or drain-order mention of the park lane survives", () => {
    assert.ok(!review.includes("### 1.6"), "the §1.6 report step must not come back");
    assert.ok(!/Hitl-grill \(P\)/.test(review), "the §2 report block must not come back");
    assert.ok(
      !/`hitl-grill` parked ideas \(§1\.6\)/.test(review),
      "the drain-order rule must not list the park lane",
    );
  });

  test("the playbook points the operator at /hydra-hitl-grill instead", () => {
    assert.match(review, /\/hydra-hitl-grill/);
    assert.match(review, /never gather, report, promote, close, relabel, or comment on a parked idea here/i);
  });
});
