/**
 * Regression tests for the Feedback File grammar Module (issue #940).
 *
 * The markdown grammar of `config/feedback/to-{agent}.md` — path resolution,
 * the `## Auto-Promoted Rules` / `## Stale Rules` section layout, the
 * `### <category> (Nx since <date>)` block format, and the three block
 * operations (append / archive / remove) — used to be re-derived at three
 * call sites across two modules. These tests pin the consolidated grammar,
 * with special attention to the WRITE (append/render) side, which had no
 * direct unit test before this Module existed (it was only exercised
 * transitively through `recordPattern`'s Redis path).
 *
 * Pure transforms only — no I/O.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #1125 — point CONFIG_PATH at a throwaway dir BEFORE importing the
// module (its CONFIG_PATH constant is captured at load time). The I/O tests
// below exercise the self-healing write path against this temp root; the pure
// grammar tests are path-agnostic, so sharing one config root is fine.
const ORIGINAL_CONFIG_PATH = process.env.HYDRA_CONFIG_PATH;
const TEMP_CONFIG_ROOT = mkdtempSync(join(tmpdir(), "hydra-feedback-file-"));
process.env.HYDRA_CONFIG_PATH = TEMP_CONFIG_ROOT;

import {
  AUTO_PROMOTED_SECTION,
  STALE_RULES_SECTION,
  appendPromotedRuleBlock,
  feedbackFilePath,
  removePromotedRuleBlock,
  renderPromotedRuleBlock,
  promoteToFeedbackFile,
  consolidateStalePromotedRules,
  demotePromotedRuleFromFeedbackFile,
  type PromotedRuleInput,
} from "../src/pattern-memory/feedback-file.ts";

const RULE: PromotedRuleInput = {
  category: "scope-creep",
  hitCount: 12,
  firstSeen: "2026-05-01",
  action: "Stay within the planned file set.",
  lastCycleId: "cycle-2026-06-03-0900",
  examples: ["touched src/foo.ts outside scope"],
  lastSeen: "2026-06-03",
};

describe("feedbackFilePath (issue #940)", () => {
  test("resolves to-{agent}.md under config/feedback", () => {
    const p = feedbackFilePath("planner");
    assert.ok(p.endsWith("/feedback/to-planner.md"), `got: ${p}`);
  });
});

describe("renderPromotedRuleBlock (issue #940)", () => {
  test("emits the canonical heading + auto-promoted trailer", () => {
    const block = renderPromotedRuleBlock(RULE, "2026-06-03");
    assert.ok(block.includes("### scope-creep (12x since 2026-05-01)"));
    assert.ok(block.includes("Stay within the planned file set."));
    assert.ok(block.includes("Last: cycle-2026-06-03-0900 (touched src/foo.ts outside scope)"));
    assert.ok(block.includes("<!-- auto-promoted 2026-06-03, last hit 2026-06-03 -->"));
  });

  test("falls back to 'no example' when examples is empty", () => {
    const block = renderPromotedRuleBlock({ ...RULE, examples: [] }, "2026-06-03");
    assert.ok(block.includes("(no example)"));
  });
});

describe("appendPromotedRuleBlock (issue #940)", () => {
  test("creates the Auto-Promoted section + preamble when absent", () => {
    const before = "# Planner Guidance\n\nSome preamble.\n";
    const after = appendPromotedRuleBlock(before, RULE, "2026-06-03");
    assert.ok(after.includes(AUTO_PROMOTED_SECTION));
    assert.ok(after.includes("auto-promoted from agent memory"));
    assert.ok(after.includes("### scope-creep (12x since 2026-05-01)"));
    // Original content is preserved ahead of the new section.
    assert.ok(after.startsWith("# Planner Guidance"));
  });

  test("inserts after the existing header when the section is present", () => {
    const before =
      "# Planner Guidance\n\n" + AUTO_PROMOTED_SECTION + "\n\n" +
      "### existing-rule (3x since 2026-04-01)\nbody\n<!-- auto-promoted 2026-04-01, last hit 2026-04-02 -->\n";
    const after = appendPromotedRuleBlock(before, RULE, "2026-06-03");
    // The new rule lands immediately under the header, ahead of the existing one.
    const newIdx = after.indexOf("### scope-creep (12x");
    const existingIdx = after.indexOf("### existing-rule (3x");
    assert.ok(newIdx !== -1 && existingIdx !== -1);
    assert.ok(newIdx < existingIdx, "new rule should be inserted before the existing one");
    // Exactly one Auto-Promoted header — no duplicate section created.
    assert.equal(after.split(AUTO_PROMOTED_SECTION).length - 1, 1);
  });
});

describe("append → remove round-trip shares one grammar (issue #940)", () => {
  test("a block written by appendPromotedRuleBlock is removable by removePromotedRuleBlock", () => {
    const base = "# Planner Guidance\n\nIntro.\n";
    const withRule = appendPromotedRuleBlock(base, RULE, "2026-06-03");
    assert.ok(withRule.includes("### scope-creep (12x"));

    const { newContent, removed } = removePromotedRuleBlock(withRule, "scope-creep");
    assert.equal(removed, true, "the writer's heading format must be parseable by the reader");
    assert.ok(!newContent.includes("### scope-creep (12x"));
    // No orphaned triple-blank-lines after the strip.
    assert.ok(!/\n{3,}/.test(newContent));
  });

  test("removePromotedRuleBlock does not cross into the Stale Rules section", () => {
    const withRule = appendPromotedRuleBlock("# Planner\n", RULE, "2026-06-03");
    const withStale =
      withRule + "\n" + STALE_RULES_SECTION + "\n\n" +
      "### scope-creep (2x since 2026-01-01)\nold\n<!-- auto-promoted 2026-01-01, last hit 2026-01-02 -->\n";
    const { newContent, removed } = removePromotedRuleBlock(withStale, "scope-creep");
    assert.equal(removed, true);
    // The identically-named stale block survives.
    assert.ok(newContent.includes(STALE_RULES_SECTION));
    assert.ok(newContent.includes("### scope-creep (2x since 2026-01-01)"));
    // The auto-promoted one is gone.
    assert.ok(!newContent.includes("### scope-creep (12x"));
  });
});

// ===========================================================================
// Issue #1125 — self-healing on-disk promotion (config/feedback/ absent path)
// ===========================================================================
//
// The on-disk feedback lifecycle is LIVE (recordPattern's 3-hit promote →
// promoteToFeedbackFile, plus the daily consolidateStalePromotedRules sweep),
// but config/feedback/ was retired from the repo (#710). Before #1125 a missing
// directory ENOENT-failed the read so a promotion was silently lost on every
// fresh checkout. These tests pin the Option-B self-healing behaviour: a
// promotion lands on disk even when the directory does not yet exist, and the
// daily consolidation is a clean no-op (not an ENOENT) on a missing file.

// Top-level teardown: remove the shared temp root + restore the env var after
// ALL describes (including the consolidate/demote ones below) have run.
after(async () => {
  await rm(TEMP_CONFIG_ROOT, { recursive: true, force: true });
  if (ORIGINAL_CONFIG_PATH === undefined) delete process.env.HYDRA_CONFIG_PATH;
  else process.env.HYDRA_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
});

// Use agent names unique to this suite so the assertions are order-independent
// of the other test files that share the (module-load-captured) CONFIG_PATH.
const IO_AGENT = "planner-1125-iotest";
const DEMOTE_AGENT = "skeptic-1125-iotest";

describe("promoteToFeedbackFile self-heals a missing config/feedback dir (issue #1125)", () => {
  test("a 3-hit promotion persists to disk when the feedback dir is absent", async () => {
    const fbPath = feedbackFilePath(IO_AGENT);
    // Guarantee the absent-file precondition regardless of test ordering or
    // which test file loaded the module first (CONFIG_PATH is load-time fixed).
    await rm(fbPath, { force: true });
    await assert.rejects(stat(fbPath), /ENOENT/, "precondition: file must not exist yet");

    await promoteToFeedbackFile(IO_AGENT, RULE);

    // The rule actually landed on disk — the core Option-B acceptance criterion.
    const written = await readFile(fbPath, "utf-8");
    assert.ok(written.includes(AUTO_PROMOTED_SECTION), "Auto-Promoted section created");
    assert.ok(
      written.includes("### scope-creep (12x since 2026-05-01)"),
      "promoted block persisted to disk",
    );
  });

  test("a second promotion appends to the now-existing file", async () => {
    await promoteToFeedbackFile(IO_AGENT, {
      ...RULE,
      category: "stale-base-ref",
      action: "Diff against origin/master.",
    });
    const written = await readFile(feedbackFilePath(IO_AGENT), "utf-8");
    // Both rules coexist; the new one is inserted ahead of the first.
    assert.ok(written.includes("### scope-creep (12x"));
    assert.ok(written.includes("### stale-base-ref (12x"));
    // Exactly one section header — no duplicate section.
    assert.equal(written.split(AUTO_PROMOTED_SECTION).length - 1, 1);
  });
});

describe("consolidateStalePromotedRules tolerates a missing file (issue #1125)", () => {
  test("is a clean no-op (no throw) when feedback files are absent", async () => {
    // The default planner/executor/skeptic to-*.md files may or may not exist
    // under the shared CONFIG_PATH depending on test ordering; either way the
    // sweep must NOT throw — a missing file ENOENT degrades to a no-op (#1125).
    await assert.doesNotReject(consolidateStalePromotedRules());
  });
});

describe("demotePromotedRuleFromFeedbackFile tolerates a missing file (issue #1125)", () => {
  test("returns false (no-op) instead of erroring when the file is absent", async () => {
    // Ensure the target file is absent regardless of ordering.
    await rm(feedbackFilePath(DEMOTE_AGENT), { force: true });
    const removed = await demotePromotedRuleFromFeedbackFile(DEMOTE_AGENT, "scope-creep");
    assert.equal(removed, false, "demote on a missing file is a clean no-op");
  });
});
