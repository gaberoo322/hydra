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

import { REGISTRY, reviewTableDrift, type ReviewTableRow } from "../src/operator-actions/registry.ts";
import { REVIEW_BUCKETS } from "../src/schemas/operator-actions.ts";

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

  test("the AskUserQuestion walk is one-row-one-question", () => {
    // The Workflow-cannot-prompt assertion that used to live here went with the
    // fan-out itself (#4187): the block was gated so hard by its own thresholds
    // (filter only above 5 rows, fan-out only at >=4 surviving) that it could
    // essentially never fire, while costing ~231 words of context on EVERY
    // invocation. This half stays — it is the no-batching contract, which is
    // load-bearing regardless of how enrichment is done.
    assert.match(
      src,
      /One row = one question = one call|one row = one question = one call/i,
      "the no-batching contract must be stated for the AskUserQuestion walk",
    );
  });

  test("the retired 'Overnight queue row' is gone; 'Grill handoff' replaces it exactly (#4621, ADR-0034 §8.1)", () => {
    const rows = tableRows();
    assert.ok(
      !rows.some((cells) => cells[0] === "Overnight queue row"),
      "the overnight decision queue was retired — no bucket may still be named Overnight queue row",
    );
    const grillHandoff = rows.find((cells) => cells[0] === "Grill handoff");
    assert.ok(grillHandoff, "a Grill handoff row must replace the retired Overnight queue row");
    assert.deepEqual(
      grillHandoff!.slice(1),
      ["Grill with docs", "Won't do", "Approve draft as-is", "Skip"],
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

// ---------------------------------------------------------------------------
// Pin to the operator-action registry — issue #4622, ADR-0034 §8.2 "CLI and UI
// cannot drift" (drift assertion (b) of the four). Where the describe above
// pins the PLAYBOOK's table shape, this pins playbook ↔ registry: every §4 row
// must be named by EXACTLY ONE registry entry's reviewBucket, and that entry's
// three action labels must equal the row's cells 1-3 exactly. The comparison
// lives in the pure helper `reviewTableDrift` (registry.ts) so synthetic
// fixtures can drive it in both directions — a label changed on EITHER side
// reddens the required test job.
// ---------------------------------------------------------------------------

/** The §4 rows as `ReviewTableRow` tuples (Bucket cell + slots 1-4). */
function pinnedRows(): ReviewTableRow[] {
  return tableRows().map(
    (cells): ReviewTableRow => [cells[0], cells[1], cells[2], cells[3], cells[4]],
  );
}

describe("hydra-review — option table pinned to the registry (issue #4622, ADR-0034 §8.2 assertion b)", () => {
  test("assertion (b): reviewTableDrift(REGISTRY, §4 rows) is []", () => {
    assert.deepEqual(
      reviewTableDrift(REGISTRY, pinnedRows()),
      [],
      "the shipped registry and the §4 table must agree on every row — a non-empty drift list names the row and the broken half",
    );
  });

  test("assertion (b): each §4 row has EXACTLY ONE naming registry entry", () => {
    const namingCount = new Map<string, number>();
    for (const entry of REGISTRY) {
      if (entry.reviewBucket !== undefined) {
        namingCount.set(entry.reviewBucket, (namingCount.get(entry.reviewBucket) ?? 0) + 1);
      }
    }
    for (const cells of tableRows()) {
      const n = namingCount.get(cells[0]) ?? 0;
      assert.equal(
        n,
        1,
        `row "${cells[0]}" is named by ${n} reviewBucket entries (zero = unpinned, two+ = ambiguous)`,
      );
    }
  });

  test("assertion (b): §4 Bucket names equal REVIEW_BUCKETS exactly", () => {
    assert.deepEqual(
      new Set(tableRows().map((cells) => cells[0])),
      new Set<string>(REVIEW_BUCKETS),
      "no §4 row may sit outside the REVIEW_BUCKETS enum, and no enum value may lack a table row",
    );
  });

  test("assertion (b): changing a PLAYBOOK cell label reddens the pin", () => {
    const rows = pinnedRows().map((row): ReviewTableRow =>
      row[0] === "Stale-blocked"
        ? [row[0], "Unblock everything", row[2], row[3], row[4]]
        : row,
    );
    assert.deepEqual(reviewTableDrift(REGISTRY, rows), [
      {
        kind: "label-mismatch",
        bucket: "Stale-blocked",
        slot: 1,
        table: "Unblock everything",
        registry: "Unblock",
      },
    ]);
  });

  test("assertion (b): changing a REGISTRY label reddens the pin", () => {
    const entries = REGISTRY.map((entry) =>
      entry.reviewBucket === "Target reframe"
        ? { ...entry, recommended: { ...entry.recommended, label: "Start over" } }
        : entry,
    );
    assert.deepEqual(reviewTableDrift(entries, pinnedRows()), [
      {
        kind: "label-mismatch",
        bucket: "Target reframe",
        slot: 1,
        table: "Narrow scope",
        registry: "Start over",
      },
    ]);
  });

  test("assertion (b): a row no entry names reddens (unpinned-row)", () => {
    const entries = REGISTRY.filter((entry) => entry.reviewBucket !== "Grill handoff");
    assert.ok(entries.length < REGISTRY.length, "fixture must actually drop an entry");
    assert.deepEqual(reviewTableDrift(entries, pinnedRows()), [
      { kind: "unpinned-row", bucket: "Grill handoff" },
    ]);
  });

  test("assertion (b): a row two entries name reddens (ambiguous-row)", () => {
    const staleBlocked = REGISTRY.find((entry) => entry.key === "waiting-on-you:stale-blocked")!;
    // A second entry naming the same row. The variant keeps the fixture
    // schema-plausible (a different (key, variant) slot) — the point is that
    // two entries claiming one row make the pin ambiguous.
    const duplicate = { ...staleBlocked, variant: "triage-origin" as const };
    assert.deepEqual(reviewTableDrift([...REGISTRY, duplicate], pinnedRows()), [
      { kind: "ambiguous-row", bucket: "Stale-blocked", count: 2 },
    ]);
  });

  test("assertion (b): the Stalled PR row pin is owned by prs-not-landing:unshepherded only", () => {
    const stalled = REGISTRY.filter((entry) => entry.reviewBucket === "Stalled PR");
    assert.equal(stalled.length, 1, "exactly one entry may name the Stalled PR row");
    assert.equal(stalled[0]!.key, "prs-not-landing:unshepherded");
    // conflicted keeps its labels/actions but deliberately does NOT name the
    // row (#4622): a conflicted PR's slot 1 is escape-hatch territory, so
    // unshepherded (the generic "Land it" case) owns the pin.
    const conflicted = REGISTRY.find((entry) => entry.key === "prs-not-landing:conflicted")!;
    assert.equal(conflicted.reviewBucket, undefined);
    assert.equal(conflicted.recommended.label, "Land it");
    assert.equal(conflicted.alternatives[0].label, "Update branch");
    assert.equal(conflicted.alternatives[1].label, "Close");
  });

  test("assertion (b): the ready-for-human DEFAULT entry stays the generic fallback (no reviewBucket)", () => {
    const defaultEntry = REGISTRY.find(
      (entry) => entry.key === "waiting-on-you:ready-for-human" && entry.variant === undefined,
    )!;
    assert.equal(defaultEntry.reviewBucket, undefined);
    assert.equal(defaultEntry.recommended.label, "Classify and resolve");
  });

  test("assertion (b): Triage origin, Tracking parent and Dev failure are variant entries on waiting-on-you:ready-for-human", () => {
    const variants = REGISTRY.filter(
      (entry) => entry.key === "waiting-on-you:ready-for-human" && entry.variant !== undefined,
    )
      .map((entry) => [entry.variant, entry.reviewBucket] as const)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(variants, [
      ["dev-failure", "Dev failure"],
      ["grill-handoff", "Grill handoff"],
      ["tracking-parent", "Tracking parent"],
      ["triage-origin", "Triage origin"],
    ]);
  });
});
