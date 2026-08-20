/**
 * Drift-guard for issue #4185 — pins the canonical option table and the
 * `AskUserQuestion` walk contract in docs/operator-playbooks/hydra-review.md.
 *
 * Why this exists: before #4185 the skill re-derived its option list from prose
 * on every run, so the same bucket could render different choices in different
 * sessions. The operator's ask was to CLICK the recommended action rather than
 * compose a sentence per row — and clicking only builds muscle memory if slot
 * position is stable. Prose cannot guarantee that; a test can.
 *
 * Drift-guard-as-test pattern (`feedback_drift_guard_as_test_not_workflow`): a
 * test in the REQUIRED `test` job actually gates, whereas a sibling advisory
 * workflow cannot. Mirrors test/hydra-review-stalled-pr-bucket.test.mts —
 * readFileSync + regex over the in-repo PLAYBOOK only, never the generated
 * skill under ~/.claude/skills/ (only one SKILL.md is tracked here, so a
 * generated-artifact assertion would read a file absent from a fresh worktree),
 * and NO `gh` call (a live read would burn the quota a running autopilot shares).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-review.md");
const src = readFileSync(PLAYBOOK, "utf-8");

/** Slice §4 (the option table) up to §5. */
function optionTable(): string {
  const start = src.indexOf("### 4. The canonical option table");
  assert.ok(start > -1, "§4 canonical option table section is missing");
  const end = src.indexOf("### 5. Wrap-up", start);
  assert.ok(end > start, "could not locate §5, which terminates §4");
  return src.slice(start, end);
}

/** Parse the markdown table rows into [bucket, slot1..slot4]. */
function tableRows(): string[][] {
  return optionTable()
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l) && !l.includes("(Recommended)"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length === 5 && cells[0] !== "Bucket");
}

describe("hydra-review — canonical option table (issue #4185)", () => {
  test("every bucket declares exactly four slots", () => {
    const rows = tableRows();
    assert.ok(rows.length >= 9, `expected >=9 bucket rows, got ${rows.length}`);
    for (const cells of rows) {
      for (let i = 1; i <= 4; i++) {
        assert.ok(
          cells[i].length > 0,
          `bucket "${cells[0]}" has an empty slot ${i} — AskUserQuestion needs 2-4 concrete options`,
        );
      }
    }
  });

  test("slot 4 is ALWAYS Skip — the operator must never have to type to defer", () => {
    for (const cells of tableRows()) {
      assert.equal(
        cells[4],
        "Skip",
        `bucket "${cells[0]}" must reserve slot 4 for Skip; reaching defer through "Other" would force typing, which is the friction #4185 removes`,
      );
    }
  });

  test("Skip appears ONLY in slot 4 — it is the escape, never a substantive choice", () => {
    for (const cells of tableRows()) {
      for (let i = 1; i <= 3; i++) {
        assert.notEqual(cells[i], "Skip", `bucket "${cells[0]}" repeats Skip in slot ${i}`);
      }
    }
  });

  test("the recommended-first and Other rules are stated", () => {
    const sec = optionTable();
    assert.match(sec, /Slot 1 is the recommended action/i, "slot 1 must be declared the recommendation");
    assert.match(sec, /slot 4 is always Skip/i, "slot 4 must be declared as Skip");
    assert.match(
      sec,
      /never write it as an option|appended (?:automatically )?by the tool|automatic "Other"/i,
      '"Other" must be documented as tool-provided, so no bucket wastes a slot on it',
    );
  });

  test("the slot-1 escape hatch is documented AND bounded to slot 1", () => {
    const sec = optionTable();
    assert.match(sec, /escape hatch/i, "the slot-1 specialisation carve-out must be documented");
    assert.match(
      sec,
      /Slots 2[–-]4 never change/i,
      "the carve-out must be explicitly bounded to slot 1, or the whole table drifts",
    );
  });

  test("the AskUserQuestion walk is one-row-one-question, and Workflow cannot prompt", () => {
    assert.match(
      src,
      /One row = one question = one call|one row = one question = one call/i,
      "the no-batching contract must be stated for the AskUserQuestion walk",
    );
    assert.match(
      src,
      /cannot call `AskUserQuestion`/,
      "the playbook must state that a Workflow subagent has no operator channel — otherwise a future edit will try to prompt from inside the fan-out",
    );
  });

  test("the multi-select filter is gated above 5 rows, not always-on", () => {
    assert.match(
      src,
      /only when the post-classification actionable list exceeds 5/i,
      "the filter must be gated on a row-count threshold; after classification most boards have 2-3 actionable rows, where filtering is ceremony",
    );
  });

  test("evidence previews are scoped to the two evidence-driven buckets", () => {
    assert.match(src, /preview/i, "the preview mechanism must be documented");
    assert.match(
      src,
      /Do \*\*not\*\* attach a preview to judgment rows/i,
      "previews must be explicitly excluded from judgment rows, where they would duplicate the summary",
    );
  });
});
